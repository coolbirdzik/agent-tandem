import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, unlink, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { assertPath } from './history';
import { withStorageLock } from './storage-lock';

const uuid = /^[a-f0-9-]{36}$/i, hash = /^[a-f0-9]{64}$/;
// Blobs and snapshot manifests are written under one lock and referenced under a later one (another
// window may be mid-capture). Ten minutes covers that gap without making users wait a day to clean.
const grace = 10 * 60 * 1000;
// Native Codex homes create linked tool launchers here. Never follow or clean
// these links; they are unrelated to our snapshot references and candidates.
const nativeTemporary = (relative: string) => /^accounts\/profiles\/[a-f0-9-]{36}\/tmp(?:\/|$)/i.test(relative);
const vanishedTemporary = (error: unknown, relative: string) => nativeTemporary(relative) && (error as NodeJS.ErrnoException).code === 'ENOENT';
export interface StoredFile { relative: string; bytes: number; modified: number; changed: number; inode: number }
export interface CleanupPlan { token: string; createdAt: number; files: StoredFile[]; bytes: number }
export interface CleanupResult { removed: number; bytes: number; skipped: number; failures: string[] }
export interface StoredHistory {
  id: string; projectId: string; project: string; label: string; kind: 'checkpoints' | 'undo' | 'tracking';
  /** `bytes` counts every referenced snapshot file; `reclaimable` only those no other history or Review keeps. Tracking baselines count no restore points. */
  count: number; bytes: number; reclaimable: number; createdAt: number; updatedAt: number;
}
export interface HistoryDeletionPlan extends CleanupPlan {
  histories: StoredHistory[];
  /** Checkpoint files lose `ids`; a Review file (no ids) stops change tracking. */
  records: { relative: string; digest: string; ids: string[] }[];
  /** Categories chosen in "Clean up…"; absent for restore history picked row by row. */
  kinds?: CleanupKind[];
}
export const CLEANUP_KINDS = ['checkpoints', 'undo', 'tracking', 'unused'] as const;
export type CleanupKind = typeof CLEANUP_KINDS[number];
export interface HistoryDeletionResult extends CleanupResult { checkpointsRemoved: number; trackingStopped: number }
/** Deletion progress: reference checks and history edits are indeterminate; removal counts approved files. */
export interface StorageProgress { phase: 'checking' | 'history' | 'removing' | 'refreshing'; done: number; total: number; bytes: number; totalBytes: number }
export type StorageProgressListener = (progress: StorageProgress) => void;
interface CheckpointRecord { id: string; key: string; snapshot: string; createdAt: number; undo?: boolean; title?: string }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const reviewFile = /^reviews\/[a-f0-9]{64}\.json$/, checkpointFile = /^checkpoints\/[a-f0-9]{64}\.json$/;
/** Review state with change tracking stopped. Pending changes and revert Undo stay; the preference keeps auto-tracking from recapturing the baseline. */
const untracked = (value: Record<string, unknown>) => ({ ...value, external: undefined, externalCapturedAt: undefined, externalDecidedAt: undefined, externalPreference: false, notice: 'Change tracking stopped by Storage cleanup to free space. Turn it on again to capture a new baseline.' });
const add = (set: Set<string>, id: unknown, pattern: RegExp) => {
  if (id === undefined) return;
  if (typeof id !== 'string' || !pattern.test(id)) throw new Error('Invalid storage reference. Cleanup was blocked.');
  set.add(id);
};
export interface StorageState {
  status: 'idle' | 'loading' | 'ready' | 'cleaning' | 'error'; root: string; total?: number;
  categories?: { label: string; bytes: number; files: number }[];
  cleanable?: { bytes: number; files: number }; cleanupBlocked?: string; error?: string;
  plan?: CleanupPlan; result?: CleanupResult; progress?: StorageProgress;
  histories?: StoredHistory[]; historyPlan?: HistoryDeletionPlan; historyResult?: HistoryDeletionResult;
}
const category = (name: string) => name.startsWith('reviews/') ? 'Review snapshots & tracking' : /^(blobs|snapshots|sessions)\//.test(name) ? 'Recorded demo history' : name.startsWith('checkpoints/') ? 'Message checkpoints & Undo' : name.startsWith('attachments/') ? 'Chat attachments' : name.startsWith('usage/') ? 'Usage & account evidence' : 'Preferences & other data';

export class StorageManager {
  constructor(readonly root: string) {}
  private async inventory(): Promise<StoredFile[]> {
    const result: StoredFile[] = [];
    const walk = async (directory: string, prefix: string) => {
      let info;
      try { info = await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink()) {
        if (nativeTemporary(prefix)) return;
        throw new Error(`Linked storage directory cannot be managed: ${prefix || this.root}`);
      }
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (vanishedTemporary(error, prefix)) return []; throw error; });
      for (const entry of entries) {
        if (!prefix && entry.name === '.snapshot-lock') continue;
        const relative = `${prefix}${entry.name}`, full = path.join(directory, entry.name);
        const stat = await lstat(full).catch(error => { if (vanishedTemporary(error, relative)) return undefined; throw error; });
        if (!stat) continue;
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
          if (nativeTemporary(relative)) continue;
          throw new Error(`Linked storage file cannot be managed: ${relative}`);
        }
        if (stat.isDirectory()) await walk(full, `${relative}/`);
        else if (stat.isFile()) result.push({ relative, bytes: stat.size, modified: stat.mtimeMs, changed: stat.ctimeMs, inode: stat.ino });
      }
    };
    await walk(this.root, ''); return result;
  }
  private async json(file: StoredFile): Promise<any> {
    if (file.bytes > 16 * 1024 * 1024) throw new Error(`Storage metadata exceeds the cleanup limit: ${file.relative}`);
    try { return JSON.parse(await readFile(path.join(this.root, file.relative), 'utf8')); }
    catch { throw new Error(`Cleanup blocked by unreadable metadata: ${file.relative}`); }
  }
  /** Snapshots and blobs a project's Review state keeps: tracking baseline (unless `tracking` is false), active capture, pending changes and revert Undo. */
  private async reviewReferences(file: StoredFile, snapshots: Set<string>, blobs: Set<string>, override?: unknown, tracking = true) {
    const value = override ?? await this.json(file);
    if (value.version !== 1 || typeof value.project !== 'string' || !Array.isArray(value.files) || (value.active !== undefined && (!value.active || typeof value.active.requestId !== 'string' || !uuid.test(value.active.before)))) throw new Error(`Invalid review metadata: ${file.relative}`);
    add(tracking ? snapshots : new Set(), value.external, uuid); add(snapshots, value.active?.before, uuid);
    const protectedFiles = [...value.files];
    if (value.revertUndo !== undefined) {
      const undo = value.revertUndo;
      if (!undo || typeof undo.id !== 'string' || !Number.isFinite(undo.createdAt) || !Array.isArray(undo.files) || (undo.phase !== undefined && !['reverting', 'undoing'].includes(undo.phase))) throw new Error(`Invalid revert Undo: ${file.relative}`);
      for (const entry of undo.files) {
        if (!entry?.original || (entry.remaining && (entry.remaining.path !== entry.original.path || entry.remaining.after !== entry.after))) throw new Error(`Invalid revert Undo file: ${file.relative}`);
        add(blobs, entry.after, hash); protectedFiles.push(entry.original);
        if (entry.remaining) protectedFiles.push(entry.remaining);
      }
    }
    for (const change of protectedFiles) {
      assertPath(change.path); add(blobs, change.before, hash); add(blobs, change.after, hash);
      if (change.captures !== undefined && !Array.isArray(change.captures)) throw new Error(`Invalid capture references: ${file.relative}`);
      for (const capture of change.captures ?? []) { add(blobs, capture.before, hash); add(blobs, capture.after, hash); }
    }
    return value as { project: string; external?: string; externalCapturedAt?: number };
  }
  private async candidates(files: StoredFile[], now: number, overrides = new Map<string, unknown>(), released = new Set<string>(), selectedOnly = false): Promise<StoredFile[]> {
    const snapshots = { review: new Set<string>(), demo: new Set<string>() }, blobs = { review: new Set<string>(), demo: new Set<string>() };
    for (const file of files) {
      if (reviewFile.test(file.relative)) await this.reviewReferences(file, snapshots.review, blobs.review, overrides.get(file.relative));
      else if (checkpointFile.test(file.relative)) {
        const value = overrides.get(file.relative) ?? await this.json(file);
        if (!Array.isArray(value)) throw new Error(`Invalid checkpoint metadata: ${file.relative}`);
        for (const record of value) { if (!record || !uuid.test(record.id) || !uuid.test(record.snapshot)) throw new Error(`Invalid checkpoint reference: ${file.relative}`); add(snapshots.review, record.snapshot, uuid); }
      } else if (/^sessions\/[^/]+\.json$/.test(file.relative)) {
        const value = await this.json(file);
        if (value.version !== 1 || value.source !== 'demo' || !uuid.test(value.id) || !uuid.test(value.baseline) || !Array.isArray(value.steps)) throw new Error(`Invalid demo metadata: ${file.relative}`);
        add(snapshots.demo, value.baseline, uuid);
        for (const step of value.steps) {
          if (!step || !uuid.test(step.before) || !Array.isArray(step.changes)) throw new Error(`Invalid demo step: ${file.relative}`);
          add(snapshots.demo, step.before, uuid); add(snapshots.demo, step.after, uuid);
          for (const change of step.changes) { add(blobs.demo, change.before, hash); add(blobs.demo, change.after, hash); }
        }
      } else if (/^(reviews|checkpoints)\/[^/]+\.json$/.test(file.relative)) throw new Error(`Unrecognized reference metadata: ${file.relative}`);
    }
    const removable: StoredFile[] = [], manifests = new Set<string>();
    for (const file of files) {
      const match = /^(reviews\/history\/)?snapshots\/([^/]+)\.json$/.exec(file.relative);
      if (!match) continue;
      const scope = match[1] ? 'review' : 'demo', id = match[2]!;
      if (!uuid.test(id)) throw new Error(`Invalid snapshot filename: ${file.relative}`);
      const value = await this.json(file);
      if (value.id !== id || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new Error(`Invalid snapshot: ${file.relative}`);
      manifests.add(`${scope}:${id}`);
      const unused = !snapshots[scope].has(id) && (released.has(file.relative) || (!selectedOnly && now - file.modified >= grace));
      for (const [name, blob] of Object.entries(value.files)) { assertPath(name); if (typeof blob !== 'string' || !hash.test(blob)) throw new Error(`Invalid snapshot blob: ${file.relative}`); if (!unused) blobs[scope].add(blob); }
      if (unused) removable.push(file);
    }
    for (const scope of ['review', 'demo'] as const) for (const id of snapshots[scope]) if (!manifests.has(`${scope}:${id}`)) throw new Error('A referenced snapshot is missing. Repair storage before cleanup.');
    const blobFiles = new Set(files.map(file => file.relative));
    for (const scope of ['review', 'demo'] as const) for (const id of blobs[scope]) if (!blobFiles.has(`${scope === 'review' ? 'reviews/history/' : ''}blobs/${id}`)) throw new Error('A protected snapshot blob is missing. Repair storage before cleanup.');
    for (const file of files) {
      const match = /^(reviews\/history\/)?blobs\/([a-f0-9]{64})$/.exec(file.relative);
      if (match && (released.has(file.relative) || (!selectedOnly && now - file.modified >= grace)) && !blobs[match[1] ? 'review' : 'demo'].has(match[2]!)) removable.push(file);
    }
    return removable;
  }
  private async historyInventory(files: StoredFile[]) {
    const byPath = new Map(files.map(file => [file.relative, file])), projects = new Map<string, string>();
    const reviewSnapshots = new Set<string>(), reviewBlobs = new Set<string>(), tracked: { file: StoredFile; project: string; baseline: string; at?: number }[] = [];
    // Tracking baselines become their own history so users can release them; other Review state stays kept.
    for (const file of files.filter(file => reviewFile.test(file.relative))) {
      const value = await this.reviewReferences(file, reviewSnapshots, reviewBlobs, undefined, false);
      projects.set(path.basename(file.relative, '.json'), value.project);
      if (value.external) tracked.push({ file, project: value.project, baseline: value.external, at: value.externalCapturedAt });
    }
    const manifests = new Map<string, string[]>();
    const manifestBlobs = async (id: string) => {
      const manifestPath = `reviews/history/snapshots/${id}.json`;
      let blobs = manifests.get(manifestPath);
      if (!blobs) {
        const file = byPath.get(manifestPath);
        if (!file) throw new Error('A referenced snapshot is missing. Repair storage before cleanup.');
        const snapshot = await this.json(file);
        if (snapshot.id !== id || !snapshot.files || typeof snapshot.files !== 'object' || Array.isArray(snapshot.files)) throw new Error(`Invalid snapshot: ${manifestPath}`);
        blobs = Object.entries(snapshot.files).map(([name, blob]) => {
          assertPath(name); if (typeof blob !== 'string' || !hash.test(blob)) throw new Error(`Invalid snapshot blob: ${manifestPath}`);
          return `reviews/history/blobs/${blob}`;
        });
        manifests.set(manifestPath, blobs);
      }
      return [manifestPath, ...blobs];
    };
    const groups = new Map<string, { history: StoredHistory; relative: string; records: CheckpointRecord[]; paths: Set<string> }>();
    for (const { file, project, baseline, at } of tracked) {
      const projectId = path.basename(file.relative, '.json'), id = digest(JSON.stringify([projectId, 'tracking'])), time = Number.isFinite(at) ? at! : file.modified;
      const history: StoredHistory = { id, projectId, project, label: 'Change tracking baseline', kind: 'tracking', count: 0, bytes: 0, reclaimable: 0, createdAt: time, updatedAt: time };
      groups.set(id, { history, relative: file.relative, records: [], paths: new Set(await manifestBlobs(baseline)) });
    }
    for (const file of files.filter(file => checkpointFile.test(file.relative))) {
      const records: CheckpointRecord[] = await this.json(file), projectId = path.basename(file.relative, '.json');
      if (!Array.isArray(records)) throw new Error(`Invalid checkpoint metadata: ${file.relative}`);
      const ids = new Set<string>();
      for (const record of records) {
        if (!record || !uuid.test(record.id) || ids.has(record.id) || !uuid.test(record.snapshot) || typeof record.key !== 'string' || !Number.isFinite(record.createdAt) || (record.undo !== undefined && typeof record.undo !== 'boolean')) throw new Error(`Invalid checkpoint record: ${file.relative}`);
        ids.add(record.id);
        const id = digest(JSON.stringify([projectId, !!record.undo, record.key]));
        let group = groups.get(id);
        if (!group) {
          group = { history: { id, projectId, project: projects.get(projectId) ?? `Project ${projectId.slice(0, 12)}`, label: record.undo ? 'Last restore backup' : typeof record.title === 'string' && record.title ? record.title : record.key, kind: record.undo ? 'undo' : 'checkpoints', count: 0, bytes: 0, reclaimable: 0, createdAt: record.createdAt, updatedAt: record.createdAt }, relative: file.relative, records: [], paths: new Set() };
          groups.set(id, group);
        }
        group.records.push(record); group.history.count++;
        if (!record.undo && typeof record.title === 'string' && record.title) group.history.label = record.title;
        group.history.createdAt = Math.min(group.history.createdAt, record.createdAt); group.history.updatedAt = Math.max(group.history.updatedAt, record.createdAt);
        for (const relative of await manifestBlobs(record.snapshot)) group.paths.add(relative);
      }
    }
    // A file frees space only when no other history and no Review state keeps it.
    const kept = new Set([...reviewBlobs].map(blob => `reviews/history/blobs/${blob}`)), owners = new Map<string, number>();
    for (const id of reviewSnapshots) for (const relative of await manifestBlobs(id)) kept.add(relative);
    for (const group of groups.values()) for (const relative of group.paths) owners.set(relative, (owners.get(relative) ?? 0) + 1);
    for (const group of groups.values()) for (const relative of group.paths) {
      const file = byPath.get(relative); if (!file) throw new Error('A protected snapshot blob is missing. Repair storage before cleanup.');
      group.history.bytes += file.bytes;
      if (owners.get(relative) === 1 && !kept.has(relative)) group.history.reclaimable += file.bytes;
    }
    return groups;
  }
  async previewHistoryDeletion(selected: string[]): Promise<HistoryDeletionPlan> {
    return withStorageLock(this.root, async () => {
      if (!Array.isArray(selected) || !selected.length || selected.some(id => typeof id !== 'string' || !hash.test(id))) throw new Error('Select saved history to delete.');
      const inventory = await this.inventory();
      return this.planDeletion(inventory, await this.historyInventory(inventory), selected, false);
    });
  }
  /** Every history of the chosen kinds, plus unused snapshots past the grace period when `unused` is chosen; deletion revalidates both sets. */
  async previewKindCleanup(kinds: unknown): Promise<HistoryDeletionPlan> {
    return withStorageLock(this.root, async () => {
      if (!Array.isArray(kinds) || !kinds.length || kinds.some(kind => !CLEANUP_KINDS.includes(kind))) throw new Error('Choose what to clean up.');
      const chosen = CLEANUP_KINDS.filter(kind => kinds.includes(kind)), inventory = await this.inventory(), groups = await this.historyInventory(inventory);
      const ids = [...groups.values()].filter(group => chosen.includes(group.history.kind)).map(group => group.history.id);
      const plan = await this.planDeletion(inventory, groups, ids, chosen.includes('unused'));
      if (!plan.histories.length && !plan.files.length) throw new Error('Nothing to clean up.');
      return { ...plan, kinds: chosen };
    });
  }
  private async planDeletion(inventory: StoredFile[], groups: Awaited<ReturnType<StorageManager['historyInventory']>>, selected: string[], unused: boolean): Promise<HistoryDeletionPlan> {
    const histories: StoredHistory[] = [], removals = new Map<string, Set<string>>(), untrack = new Set<string>(), released = new Set<string>();
    for (const id of new Set(selected)) {
      const group = groups.get(id); if (!group) throw new Error('Saved history changed. Refresh and select it again.');
      const review = inventory.find(file => file.relative === `reviews/${group.history.projectId}.json`);
      if (review && (await this.json(review)).active) throw new Error('Wait for the agent and change capture to finish before deleting history.');
      histories.push(group.history);
      if (group.history.kind === 'tracking') untrack.add(group.relative);
      else { const ids = removals.get(group.relative) ?? new Set<string>(); for (const record of group.records) ids.add(record.id); removals.set(group.relative, ids); }
      for (const relative of group.paths) released.add(relative);
    }
    const overrides = new Map<string, unknown>(), records: HistoryDeletionPlan['records'] = [];
    for (const [relative, ids] of removals) {
      const text = await readFile(path.join(this.root, relative), 'utf8');
      overrides.set(relative, (JSON.parse(text) as CheckpointRecord[]).filter(record => !ids.has(record.id)));
      records.push({ relative, digest: digest(text), ids: [...ids] });
    }
    for (const relative of untrack) {
      const text = await readFile(path.join(this.root, relative), 'utf8');
      overrides.set(relative, untracked(JSON.parse(text))); records.push({ relative, digest: digest(text), ids: [] });
    }
    // Every external scan leaves the previous baseline unreferenced, sharing nearly all its blobs; releasing a
    // baseline also sweeps those old unused snapshots, or they would keep the space it was meant to free.
    const files = await this.candidates(inventory, Date.now(), overrides, released, !unused && !untrack.size);
    return { token: randomUUID(), createdAt: Date.now(), histories, records, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  }
  async deleteHistory(plan: HistoryDeletionPlan, onProgress?: StorageProgressListener): Promise<HistoryDeletionResult> {
    return withStorageLock(this.root, async () => {
      if (Date.now() - plan.createdAt > 10 * 60 * 1000) throw new Error('History preview expired. Preview again.');
      const progress = (phase: StorageProgress['phase']) => onProgress?.({ phase, done: 0, total: plan.files.length, bytes: 0, totalBytes: plan.bytes });
      progress('checking');
      const inventory = await this.inventory(), byPath = new Map(inventory.map(file => [file.relative, file]));
      const updates: { relative: string; value: unknown; removed: number; untracked: boolean }[] = [];
      for (const edit of plan.records) {
        const review = reviewFile.test(edit.relative);
        if ((!review && !checkpointFile.test(edit.relative)) || !byPath.has(edit.relative)) throw new Error('Saved history changed. Preview deletion again.');
        const text = await readFile(path.join(this.root, edit.relative), 'utf8');
        if (digest(text) !== edit.digest) throw new Error('Saved history changed. Preview deletion again.');
        const state = byPath.get(edit.relative.replace('checkpoints/', 'reviews/')), current = review ? JSON.parse(text) : state && await this.json(state);
        if (current?.active) throw new Error('Wait for the agent and change capture to finish before deleting history.');
        if (review) { updates.push({ relative: edit.relative, value: untracked(current), removed: 0, untracked: true }); continue; }
        const saved: CheckpointRecord[] = JSON.parse(text), ids = new Set(edit.ids), records = saved.filter(record => !ids.has(record.id));
        updates.push({ relative: edit.relative, value: records, removed: saved.length - records.length, untracked: false });
      }
      const overrides = new Map(updates.map(edit => [edit.relative, edit.value]));
      const released = new Set(plan.files.filter(file => {
        const current = byPath.get(file.relative);
        return current && ['bytes', 'modified', 'changed', 'inode'].every(key => current[key as keyof StoredFile] === file[key as keyof StoredFile]);
      }).map(file => file.relative));
      // Validate every reference before removing any checkpoint. Shared blobs stay protected.
      await this.candidates(inventory, Date.now(), overrides, released, true);
      const result: HistoryDeletionResult = { removed: 0, bytes: 0, skipped: 0, failures: [], checkpointsRemoved: 0, trackingStopped: 0 };
      progress('history');
      for (const edit of updates) {
        const full = path.join(this.root, edit.relative), temporary = `${full}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(edit.value), { flag: 'wx' }); await rename(temporary, full);
          result.checkpointsRemoved += edit.removed; if (edit.untracked) result.trackingStopped++;
        } catch (error) { result.failures.push(`${edit.relative}: ${error instanceof Error ? error.message : String(error)}`); }
        finally { await unlink(temporary).catch(() => undefined); }
      }
      let fresh: StoredFile[];
      progress('checking');
      try { fresh = await this.candidates(await this.inventory(), Date.now(), new Map(), released, true); }
      catch (error) {
        return { ...result, skipped: plan.files.length, failures: [...result.failures, `Snapshot cleanup: ${error instanceof Error ? error.message : String(error)}`] };
      }
      const cleaned = await this.removeFiles(plan.files, fresh, onProgress);
      return { ...cleaned, failures: [...result.failures, ...cleaned.failures], checkpointsRemoved: result.checkpointsRemoved, trackingStopped: result.trackingStopped };
    });
  }
  async inspect(): Promise<StorageState> {
    return withStorageLock(this.root, async () => {
      const files = await this.inventory(), groups = new Map<string, { label: string; bytes: number; files: number }>();
      for (const file of files) { const label = category(file.relative), row = groups.get(label) ?? { label, bytes: 0, files: 0 }; row.bytes += file.bytes; row.files++; groups.set(label, row); }
      const state: StorageState = { status: 'ready', root: this.root, total: files.reduce((n, file) => n + file.bytes, 0), categories: [...groups.values()] };
      try {
        state.histories = [...(await this.historyInventory(files)).values()].map(group => group.history).sort((a, b) => b.reclaimable - a.reclaimable || b.bytes - a.bytes || a.id.localeCompare(b.id));
        const unused = await this.candidates(files, Date.now()); state.cleanable = { files: unused.length, bytes: unused.reduce((n, file) => n + file.bytes, 0) };
      }
      catch (error) { state.cleanupBlocked = error instanceof Error ? error.message : String(error); }
      return state;
    });
  }
  async preview(): Promise<CleanupPlan> {
    return withStorageLock(this.root, async () => {
      const files = await this.candidates(await this.inventory(), Date.now());
      return { token: randomUUID(), createdAt: Date.now(), files, bytes: files.reduce((n, file) => n + file.bytes, 0) };
    });
  }
  async cleanup(plan: CleanupPlan, onProgress?: StorageProgressListener): Promise<CleanupResult> {
    return withStorageLock(this.root, async () => {
      if (Date.now() - plan.createdAt > 10 * 60 * 1000) throw new Error('Cleanup preview expired. Preview again.');
      onProgress?.({ phase: 'checking', done: 0, total: plan.files.length, bytes: 0, totalBytes: plan.bytes });
      return this.removeFiles(plan.files, await this.candidates(await this.inventory(), Date.now()), onProgress);
    });
  }
  private async removeFiles(approved: StoredFile[], candidates: StoredFile[], onProgress?: StorageProgressListener): Promise<CleanupResult> {
      const fresh = new Map(candidates.map(file => [file.relative, file]));
      const result: CleanupResult = { removed: 0, bytes: 0, skipped: 0, failures: [] };
      const totalBytes = approved.reduce((sum, file) => sum + file.bytes, 0);
      const report = () => onProgress?.({ phase: 'removing', done: result.removed + result.skipped + result.failures.length, total: approved.length, bytes: result.bytes, totalBytes });
      report();
      for (const file of approved) {
        if (result.failures.length && file.relative.includes('blobs/')) { result.skipped++; report(); continue; }
        const current = fresh.get(file.relative);
        if (!current || ['bytes', 'modified', 'changed', 'inode'].some(key => current[key as keyof StoredFile] !== file[key as keyof StoredFile])) { result.skipped++; report(); continue; }
        try {
          assertPath(file.relative);
          let full = this.root;
          for (const part of file.relative.split('/')) { full = path.join(full, part); const info = await lstat(full); if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error('Linked path was kept.'); }
          await unlink(full); result.removed++; result.bytes += file.bytes;
        } catch (error) { result.failures.push(`${file.relative}: ${error instanceof Error ? error.message : String(error)}`); }
        report();
      }
      return result;
  }
}
