import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, unlink, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { assertPath } from './history';
import { withStorageLock } from './storage-lock';
import { gitRefPattern } from './git-refs';
import { TIMELINE_KEY } from './checkpoints';

const uuid = /^[a-f0-9-]{36}$/i, hash = /^[a-f0-9]{64}$/;
// Blobs and snapshot manifests are written under one lock and referenced under a later one (another
// window may be mid-capture). Ten minutes covers that gap without making users wait a day to clean.
const grace = 10 * 60 * 1000;
// Native Codex homes create linked tool launchers here. Never follow or clean
// these links; they are unrelated to our snapshot references and candidates.
const nativeTemporary = (relative: string) => /^accounts\/profiles\/[a-f0-9-]{36}\/tmp(?:\/|$)/i.test(relative);
const vanishedTemporary = (error: unknown, relative: string) => nativeTemporary(relative) && (error as NodeJS.ErrnoException).code === 'ENOENT';
// Cleanup parses metadata to find what is still referenced. A snapshot manifest lists every file of a project, so a
// large repository needs tens of MB; this only stops files that could not be parsed safely at all.
const maxMetadataBytes = 256 * 1024 * 1024;
export interface StoredFile { relative: string; bytes: number; modified: number; changed: number; inode: number }
/** `fileCount` is set only on display copies whose `files` were trimmed (see `storageView`); it is the full count. */
export interface CleanupPlan { token: string; createdAt: number; files: StoredFile[]; bytes: number; fileCount?: number }
export interface CleanupResult { removed: number; bytes: number; skipped: number; failures: string[] }
export interface StoredHistory {
  id: string; projectId: string; project: string; label: string; kind: 'checkpoints' | 'undo' | 'tracking';
  /**
   * `bytes` counts every referenced snapshot file; `reclaimable` only those no other history or Review keeps.
   * A `tracking` history is one project's change tracking: its baseline plus the tracking timeline restore points
   * (`count`), which share the baseline's snapshots and so can only free space together.
   */
  count: number; bytes: number; reclaimable: number; createdAt: number; updatedAt: number;
}
export interface HistoryDeletionPlan extends CleanupPlan {
  histories: StoredHistory[];
  /** Checkpoint files lose `ids`; a Review file (no ids) stops change tracking. */
  records: { relative: string; digest: string; ids: string[]; discardReview?: boolean }[];
  /** Categories chosen in "Clean up…"; absent for restore history picked row by row. */
  kinds?: CleanupKind[];
  /** One-click presets limited to Review history; demo snapshots are never included. */
  reviewScope?: 'accepted' | 'all' | 'discard';
  discardedReviews?: { project: string; files: number; undo: number }[];
}
export const CLEANUP_KINDS = ['checkpoints', 'undo', 'tracking', 'unused'] as const;
export type CleanupKind = typeof CLEANUP_KINDS[number];
export interface HistoryDeletionResult extends CleanupResult { checkpointsRemoved: number; trackingStopped: number }
export interface AutoCleanResult extends CleanupResult { remaining: number }
/** `total` is the size before this pass; `limitReached` is false only when protected data alone stays above the limit. */
export interface StorageLimitResult extends HistoryDeletionResult { total: number; limitReached: boolean; remaining: boolean }
// Automatic cleanup waits far longer than the manual one: it runs unattended.
const autoCleanAge = 60 * 60 * 1000, autoCleanBatch = 3000, removeConcurrency = 16, scanConcurrency = 32;
/** Deletion progress: reference checks and history edits are indeterminate; removal counts approved files. */
export interface StorageProgress { phase: 'checking' | 'history' | 'removing' | 'refreshing'; done: number; total: number; bytes: number; totalBytes: number }
export type StorageProgressListener = (progress: StorageProgress) => void;
interface CheckpointRecord { id: string; key: string; snapshot: string; createdAt: number; undo?: boolean; title?: string }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const reviewFile = /^reviews\/[a-f0-9]{64}\.json$/, checkpointFile = /^checkpoints\/[a-f0-9]{64}\.json$/;
/** Review state with change tracking stopped. Pending changes and revert Undo stay; the preference keeps auto-tracking from recapturing the baseline. */
const untracked = (value: Record<string, unknown>) => ({ ...value, external: undefined, externalCapturedAt: undefined, externalDecidedAt: undefined, externalPreference: false, notice: 'Change tracking stopped by Storage cleanup to free space. Turn it on again to capture a new baseline.' });
const discardedReview = (value: Record<string, unknown>) => ({ ...untracked(value), revision: randomUUID(), files: [], revertUndo: undefined, notice: 'Saved review comparisons and Undo were cleared by Storage cleanup. Workspace files were kept. Change tracking is off.' });
/** A stored snapshot manifest: complete, or the difference (`files`, `removed`) from a complete `base`. Content in `refs` is rebuilt from Git and has no blob. */
interface ManifestInfo { base?: string; files: Record<string, string>; removed: Set<string>; refs: Set<string> }
function manifestInfo(value: any, id: string, relative: string): ManifestInfo {
  if (value.id !== id || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new Error(`Invalid snapshot: ${relative}`);
  if (value.base !== undefined && (typeof value.base !== 'string' || !uuid.test(value.base) || value.base === id)) throw new Error(`Invalid snapshot: ${relative}`);
  if (value.removed !== undefined) {
    if (!value.base || !Array.isArray(value.removed)) throw new Error(`Invalid snapshot: ${relative}`);
    for (const name of value.removed) { if (typeof name !== 'string') throw new Error(`Invalid snapshot: ${relative}`); assertPath(name); }
  }
  const refs = new Set<string>();
  if (value.git !== undefined) {
    if (!value.git || typeof value.git.repo !== 'string' || !value.git.refs || typeof value.git.refs !== 'object' || Array.isArray(value.git.refs)) throw new Error(`Invalid snapshot Git reference: ${relative}`);
    for (const [blob, spec] of Object.entries(value.git.refs)) { if (!hash.test(blob) || typeof spec !== 'string' || !gitRefPattern.test(spec)) throw new Error(`Invalid snapshot Git reference: ${relative}`); refs.add(blob); }
  }
  for (const [name, blob] of Object.entries(value.files)) { assertPath(name); if (typeof blob !== 'string' || !hash.test(blob)) throw new Error(`Invalid snapshot blob: ${relative}`); }
  return { base: value.base, files: value.files, removed: new Set(value.removed ?? []), refs };
}
/** Blobs a manifest needs on disk. A difference manifest needs only the base entries it does not replace. */
function neededBlobs(info: ManifestInfo, base?: ManifestInfo): Set<string> {
  const blobs = new Set<string>(), rebuilt = (blob: string) => info.refs.has(blob) || !!base?.refs.has(blob);
  for (const blob of Object.values(info.files)) if (!rebuilt(blob)) blobs.add(blob);
  if (base) for (const [name, blob] of Object.entries(base.files)) if (!Object.hasOwn(info.files, name) && !info.removed.has(name) && !rebuilt(blob)) blobs.add(blob);
  return blobs;
}
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
  retainedReviews?: { project: string; files: number; undo: number; bytes: number }[];
}
/** Files a display copy of a plan lists: the largest ones. Deletion always uses the full plan the host keeps. */
export const VIEW_PLAN_FILES = 200;
const trimmed = new WeakMap<CleanupPlan, CleanupPlan>();
function viewPlan<T extends CleanupPlan>(plan: T | undefined): T | undefined {
  if (!plan || plan.files.length <= VIEW_PLAN_FILES) return plan;
  let view = trimmed.get(plan);
  if (!view) { view = { ...plan, fileCount: plan.files.length, files: [...plan.files].sort((a, b) => b.bytes - a.bytes).slice(0, VIEW_PLAN_FILES) }; trimmed.set(plan, view); }
  return view as T;
}
/**
 * Storage state for the Settings webview. A full review cleanup lists every snapshot file (160,000 on one machine,
 * 30 MB of JSON) and the dashboard posts the whole state on every progress tick, so plans carry only the largest files.
 */
export function storageView(state: StorageState): StorageState {
  if ((state.plan?.files.length ?? 0) <= VIEW_PLAN_FILES && (state.historyPlan?.files.length ?? 0) <= VIEW_PLAN_FILES) return state;
  return { ...state, plan: viewPlan(state.plan), historyPlan: viewPlan(state.historyPlan) };
}
/** `fn` over `items` with at most `limit` running at once; results keep their order. The first failure rejects. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) { const index = next++; try { results[index] = await fn(items[index]!); } catch (error) { failed = true; throw error; } }
  }));
  return results;
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
      const entries = (await readdir(directory, { withFileTypes: true }).catch(error => { if (vanishedTemporary(error, prefix)) return []; throw error; }))
        .filter(entry => prefix || entry.name !== '.snapshot-lock');
      // One lstat at a time took 15 s for 160,000 blobs on Windows; overlapping them takes about 3 s. Results keep folder order.
      const stats = await mapLimit(entries, scanConcurrency, entry => lstat(path.join(directory, entry.name)).catch(error => { if (vanishedTemporary(error, `${prefix}${entry.name}`)) return undefined; throw error; }));
      for (const [index, entry] of entries.entries()) {
        const relative = `${prefix}${entry.name}`, full = path.join(directory, entry.name), stat = stats[index];
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
  /** `files` with fresh entries for `changed`, which this process rewrote while holding the storage lock. */
  private async restat(files: StoredFile[], changed: string[]): Promise<StoredFile[]> {
    const fresh = new Map<string, StoredFile | undefined>();
    for (const relative of changed) {
      const stat = await lstat(path.join(this.root, relative)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1)) throw new Error(`Linked storage file cannot be managed: ${relative}`);
      fresh.set(relative, stat && { relative, bytes: stat.size, modified: stat.mtimeMs, changed: stat.ctimeMs, inode: stat.ino });
    }
    return files.flatMap(file => fresh.has(file.relative) ? fresh.get(file.relative) ?? [] : [file]);
  }
  private async json(file: StoredFile): Promise<any> {
    if (file.bytes > maxMetadataBytes) throw new Error(`Storage metadata exceeds the cleanup limit: ${file.relative}`);
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
  private async candidates(files: StoredFile[], now: number, overrides = new Map<string, unknown>(), released = new Set<string>(), selectedOnly = false, minAge = grace): Promise<StoredFile[]> {
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
    const removable: StoredFile[] = [], manifests = new Map<string, { file: StoredFile; scope: 'review' | 'demo'; info: ManifestInfo }>();
    for (const file of files) {
      const match = /^(reviews\/history\/)?snapshots\/([^/]+)\.json$/.exec(file.relative);
      if (!match) continue;
      const scope = match[1] ? 'review' : 'demo', id = match[2]!;
      if (!uuid.test(id)) throw new Error(`Invalid snapshot filename: ${file.relative}`);
      manifests.set(`${scope}:${id}`, { file, scope, info: manifestInfo(await this.json(file), id, file.relative) });
    }
    for (const scope of ['review', 'demo'] as const) for (const id of snapshots[scope]) if (!manifests.has(`${scope}:${id}`)) throw new Error('A referenced snapshot is missing. Repair storage before cleanup.');
    // Referenced and recent manifests need every entry. Others stay unless they are candidates for removal.
    const needed = new Set<string>(), kept = new Set<string>(), bases = new Set<string>();
    for (const [key, { file, scope }] of manifests) {
      const recent = now - file.modified < minAge;
      if (snapshots[scope].has(key.slice(scope.length + 1)) || (recent && !released.has(file.relative))) needed.add(key);
      if (needed.has(key) || !(released.has(file.relative) || (!selectedOnly && !recent))) kept.add(key);
    }
    // A difference manifest is only readable with its complete base. A base that is otherwise unused keeps just the
    // entries its differences still show, so content every later capture replaced can go.
    // Builds before difference snapshots could remove a base they did not know was in use. Such a difference can never
    // be restored, so there is nothing left to protect for it: it stays where it is and cleanup carries on.
    const damaged = new Set<string>();
    for (const key of [...kept]) {
      const { scope, info } = manifests.get(key)!;
      if (!info.base) continue;
      const base = manifests.get(`${scope}:${info.base}`);
      if (!base) { damaged.add(key); continue; }
      if (base.info.base) throw new Error(`Invalid snapshot: ${base.file.relative}`);
      kept.add(`${scope}:${info.base}`); bases.add(`${scope}:${info.base}`);
    }
    const blobFiles = new Set(files.map(file => file.relative)), blobPath = (scope: 'review' | 'demo', id: string) => `${scope === 'review' ? 'reviews/history/' : ''}blobs/${id}`;
    for (const [key, { file, scope, info }] of manifests) {
      if (!kept.has(key)) { removable.push(file); continue; }
      if (!info.base && bases.has(key) && !needed.has(key)) continue;
      const base = info.base ? manifests.get(`${scope}:${info.base}`)?.info : undefined;
      for (const blob of neededBlobs(info, base)) if (!damaged.has(key) || blobFiles.has(blobPath(scope, blob))) blobs[scope].add(blob);
    }
    for (const scope of ['review', 'demo'] as const) for (const id of blobs[scope]) if (!blobFiles.has(blobPath(scope, id))) throw new Error('A protected snapshot blob is missing. Repair storage before cleanup.');
    for (const file of files) {
      const match = /^(reviews\/history\/)?blobs\/([a-f0-9]{64})$/.exec(file.relative);
      if (match && (released.has(file.relative) || (!selectedOnly && now - file.modified >= minAge)) && !blobs[match[1] ? 'review' : 'demo'].has(match[2]!)) removable.push(file);
    }
    return removable;
  }
  /** Every stored file a Review snapshot needs: its manifest, a difference manifest's base, and blobs Git cannot rebuild. */
  private manifestPaths(byPath: Map<string, StoredFile>) {
    const infos = new Map<string, Promise<ManifestInfo>>(), paths = new Map<string, Promise<string[]>>();
    const relative = (id: string) => `reviews/history/snapshots/${id}.json`;
    const info = (id: string) => {
      let entry = infos.get(id);
      if (!entry) {
        const file = byPath.get(relative(id));
        entry = file ? this.json(file).then(value => manifestInfo(value, id, relative(id))) : Promise.reject(new Error('A referenced snapshot is missing. Repair storage before cleanup.'));
        infos.set(id, entry);
      }
      return entry;
    };
    return (id: string) => {
      let entry = paths.get(id);
      if (!entry) {
        entry = (async () => {
          const own = await info(id);
          // A difference whose base is gone cannot be restored, but it must stay listable so users can release it.
          // Builds before difference snapshots did not know a base was in use and could clean it up.
          const base = own.base && byPath.has(relative(own.base)) ? await info(own.base) : undefined;
          if (base?.base) throw new Error(`Invalid snapshot: ${relative(id)}`);
          return [relative(id), ...(base ? [relative(own.base!)] : []), ...[...neededBlobs(own, base)].map(blob => `reviews/history/blobs/${blob}`)];
        })();
        paths.set(id, entry);
      }
      return entry;
    };
  }
  /** One scan's histories: a preview and its summary share them (each scan returns a new array). */
  private histories = new WeakMap<StoredFile[], ReturnType<StorageManager['buildHistoryInventory']>>();
  private historyInventory(files: StoredFile[]) {
    let groups = this.histories.get(files);
    if (!groups) { groups = this.buildHistoryInventory(files); this.histories.set(files, groups); }
    return groups;
  }
  private async buildHistoryInventory(files: StoredFile[]) {
    const byPath = new Map(files.map(file => [file.relative, file])), projects = new Map<string, string>();
    const reviewSnapshots = new Set<string>(), reviewBlobs = new Set<string>(), tracked: { file: StoredFile; project: string; baseline: string; at?: number }[] = [];
    // Tracking baselines become their own history so users can release them; other Review state stays kept.
    for (const file of files.filter(file => reviewFile.test(file.relative))) {
      const value = await this.reviewReferences(file, reviewSnapshots, reviewBlobs, undefined, false);
      projects.set(path.basename(file.relative, '.json'), value.project);
      if (value.external) tracked.push({ file, project: value.project, baseline: value.external, at: value.externalCapturedAt });
    }
    const manifestBlobs = this.manifestPaths(byPath);
    // `review` is the Review file whose tracking a deletion stops; `checkpoint` the file its restore points live in.
    const groups = new Map<string, { history: StoredHistory; review?: string; checkpoint?: string; records: CheckpointRecord[]; paths: Set<string> }>();
    const trackingId = (projectId: string) => digest(JSON.stringify([projectId, 'tracking']));
    for (const { file, project, baseline, at } of tracked) {
      const projectId = path.basename(file.relative, '.json'), id = trackingId(projectId), time = Number.isFinite(at) ? at! : file.modified;
      const history: StoredHistory = { id, projectId, project, label: 'Change tracking baseline', kind: 'tracking', count: 0, bytes: 0, reclaimable: 0, createdAt: time, updatedAt: time };
      groups.set(id, { history, review: file.relative, records: [], paths: new Set(await manifestBlobs(baseline)) });
    }
    for (const file of files.filter(file => checkpointFile.test(file.relative))) {
      const records: CheckpointRecord[] = await this.json(file), projectId = path.basename(file.relative, '.json');
      if (!Array.isArray(records)) throw new Error(`Invalid checkpoint metadata: ${file.relative}`);
      const ids = new Set<string>();
      for (const record of records) {
        if (!record || !uuid.test(record.id) || ids.has(record.id) || !uuid.test(record.snapshot) || typeof record.key !== 'string' || !Number.isFinite(record.createdAt) || (record.undo !== undefined && typeof record.undo !== 'boolean')) throw new Error(`Invalid checkpoint record: ${file.relative}`);
        ids.add(record.id);
        // Tracking timeline points always include the current baseline's snapshot: they join the tracking history.
        const timeline = !record.undo && record.key === TIMELINE_KEY;
        const id = timeline ? trackingId(projectId) : digest(JSON.stringify([projectId, !!record.undo, record.key]));
        let group = groups.get(id);
        if (!group) {
          group = { history: { id, projectId, project: projects.get(projectId) ?? `Project ${projectId.slice(0, 12)}`, label: record.undo ? 'Last restore backup' : timeline ? 'Change tracking history' : typeof record.title === 'string' && record.title ? record.title : record.key, kind: record.undo ? 'undo' : timeline ? 'tracking' : 'checkpoints', count: 0, bytes: 0, reclaimable: 0, createdAt: record.createdAt, updatedAt: record.createdAt }, records: [], paths: new Set() };
          groups.set(id, group);
        }
        group.checkpoint = file.relative; group.records.push(record); group.history.count++;
        if (timeline) { if (group.review) group.history.label = 'Change tracking'; }
        else if (!record.undo && typeof record.title === 'string' && record.title) group.history.label = record.title;
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
    return withStorageLock(this.root, async () => this.historyPlan(await this.inventory(), selected));
  }
  private async historyPlan(inventory: StoredFile[], selected: unknown): Promise<HistoryDeletionPlan> {
    if (!Array.isArray(selected) || !selected.length || selected.some(id => typeof id !== 'string' || !hash.test(id))) throw new Error('Select saved history to delete.');
    return this.planDeletion(inventory, await this.historyInventory(inventory), selected, false);
  }
  /** Every history of the chosen kinds, plus unused snapshots past the grace period when `unused` is chosen; deletion revalidates both sets. */
  async previewKindCleanup(kinds: unknown): Promise<HistoryDeletionPlan> {
    return withStorageLock(this.root, async () => this.kindPlan(await this.inventory(), kinds));
  }
  private async kindPlan(inventory: StoredFile[], kinds: unknown): Promise<HistoryDeletionPlan> {
    if (!Array.isArray(kinds) || !kinds.length || kinds.some(kind => !CLEANUP_KINDS.includes(kind))) throw new Error('Choose what to clean up.');
    const chosen = CLEANUP_KINDS.filter(kind => kinds.includes(kind)), groups = await this.historyInventory(inventory);
    const ids = [...groups.values()].filter(group => chosen.includes(group.history.kind)).map(group => group.history.id);
    const plan = await this.planDeletion(inventory, groups, ids, chosen.includes('unused'));
    if (!plan.histories.length && !plan.files.length) throw new Error('Nothing to clean up.');
    return { ...plan, kinds: chosen };
  }
  /** Accepted edits leave unreferenced snapshots. Keep live references and the capture grace period. */
  async previewReviewCleanup(scope: unknown): Promise<HistoryDeletionPlan> {
    if (scope !== 'accepted' && scope !== 'all' && scope !== 'discard') throw new Error('Choose accepted snapshots or all review history.');
    return withStorageLock(this.root, async () => this.reviewPlan(await this.inventory(), scope));
  }
  private async reviewPlan(inventory: StoredFile[], scope: unknown): Promise<HistoryDeletionPlan> {
    if (scope !== 'accepted' && scope !== 'all' && scope !== 'discard') throw new Error('Choose accepted snapshots or all review history.');
    const groups = await this.historyInventory(inventory);
    const plan = await this.planDeletion(inventory, groups, scope !== 'accepted' ? [...groups.keys()] : [], true);
    if (scope === 'discard') {
      const overrides = new Map<string, unknown>(), released = new Set(plan.files.map(file => file.relative));
      plan.discardedReviews = [];
      for (const edit of plan.records) {
        const value = await this.json(inventory.find(file => file.relative === edit.relative)!);
        overrides.set(edit.relative, reviewFile.test(edit.relative) ? untracked(value) : value.filter((record: CheckpointRecord) => !edit.ids.includes(record.id)));
      }
      for (const file of inventory.filter(file => reviewFile.test(file.relative))) {
        const blobs = new Set<string>(), value = await this.reviewReferences(file, new Set(), blobs);
        const saved = await this.json(file);
        if (!saved.files.length && !saved.revertUndo) continue;
        if (saved.active || saved.revertUndo?.phase) throw new Error('Wait for capture or review to finish before clearing saved review.');
        plan.discardedReviews.push({ project: value.project, files: saved.files.length, undo: saved.revertUndo?.files.length ?? 0 });
        const text = await readFile(path.join(this.root, file.relative), 'utf8');
        const edit = plan.records.find(record => record.relative === file.relative);
        if (edit) edit.discardReview = true;
        else plan.records.push({ relative: file.relative, digest: digest(text), ids: [], discardReview: true });
        overrides.set(file.relative, discardedReview(saved));
        for (const blob of blobs) released.add(`reviews/history/blobs/${blob}`);
      }
      plan.files = await this.candidates(inventory, Date.now(), overrides, released);
    }
    const files = plan.files.filter(file => file.relative.startsWith('reviews/history/'));
    return { ...plan, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0), reviewScope: scope };
  }
  /**
   * The Storage summary and a deletion preview from one scan of the data folder. With 160,000 snapshot files each
   * scan takes seconds, and showing a preview used to scan twice. Unreadable metadata blocks the preview.
   */
  async inspectAndPreview(request: { history: unknown } | { kinds: unknown } | { review: unknown }): Promise<StorageState & { historyPlan: HistoryDeletionPlan }> {
    return withStorageLock(this.root, async () => {
      const files = await this.inventory(), state = await this.summarize(files);
      if (state.cleanupBlocked) throw new Error(state.cleanupBlocked);
      const historyPlan = 'history' in request ? await this.historyPlan(files, request.history) : 'kinds' in request ? await this.kindPlan(files, request.kinds) : await this.reviewPlan(files, request.review);
      return { ...state, historyPlan };
    });
  }
  private async planDeletion(inventory: StoredFile[], groups: Awaited<ReturnType<StorageManager['buildHistoryInventory']>>, selected: string[], unused: boolean): Promise<HistoryDeletionPlan> {
    const histories: StoredHistory[] = [], removals = new Map<string, Set<string>>(), untrack = new Set<string>(), released = new Set<string>();
    for (const id of new Set(selected)) {
      const group = groups.get(id); if (!group) throw new Error('Saved history changed. Refresh and select it again.');
      const review = inventory.find(file => file.relative === `reviews/${group.history.projectId}.json`);
      if (review && (await this.json(review)).active) throw new Error('Wait for the agent and change capture to finish before deleting history.');
      histories.push(group.history);
      if (group.review) untrack.add(group.review);
      if (group.checkpoint && group.records.length) { const ids = removals.get(group.checkpoint) ?? new Set<string>(); for (const record of group.records) ids.add(record.id); removals.set(group.checkpoint, ids); }
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
        if (edit.discardReview && (plan.reviewScope !== 'discard' || !review || current?.revertUndo?.phase)) throw new Error('Preview saved review cleanup again.');
        if (review) { updates.push({ relative: edit.relative, value: edit.discardReview ? discardedReview(current) : untracked(current), removed: 0, untracked: true }); continue; }
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
      // The lock is still held, so only the files just rewritten can differ from the scan above.
      try { fresh = await this.candidates(await this.restat(inventory, updates.map(edit => edit.relative)), Date.now(), new Map(), released, true); }
      catch (error) {
        return { ...result, skipped: plan.files.length, failures: [...result.failures, `Snapshot cleanup: ${error instanceof Error ? error.message : String(error)}`] };
      }
      const cleaned = await this.removeFiles(plan.files, fresh, onProgress);
      return { ...cleaned, failures: [...result.failures, ...cleaned.failures], checkpointsRemoved: result.checkpointsRemoved, trackingStopped: result.trackingStopped };
    });
  }
  async inspect(): Promise<StorageState> {
    return withStorageLock(this.root, async () => this.summarize(await this.inventory()));
  }
  private async summarize(files: StoredFile[]): Promise<StorageState> {
    const groups = new Map<string, { label: string; bytes: number; files: number }>();
    for (const file of files) { const label = category(file.relative), row = groups.get(label) ?? { label, bytes: 0, files: 0 }; row.bytes += file.bytes; row.files++; groups.set(label, row); }
    const state: StorageState = { status: 'ready', root: this.root, total: files.reduce((n, file) => n + file.bytes, 0), categories: [...groups.values()] };
    try {
      state.histories = [...(await this.historyInventory(files)).values()].map(group => group.history).sort((a, b) => b.reclaimable - a.reclaimable || b.bytes - a.bytes || a.id.localeCompare(b.id));
      const unused = await this.candidates(files, Date.now()); state.cleanable = { files: unused.length, bytes: unused.reduce((n, file) => n + file.bytes, 0) };
      const byPath = new Map(files.map(file => [file.relative, file]));
      state.retainedReviews = [];
      for (const file of files.filter(file => reviewFile.test(file.relative))) {
        const blobs = new Set<string>();
        await this.reviewReferences(file, new Set(), blobs, undefined, false);
        const value = await this.json(file);
        if (value.files.length || value.revertUndo) state.retainedReviews.push({ project: value.project, files: value.files.length, undo: value.revertUndo?.files.length ?? 0, bytes: [...blobs].reduce((sum, blob) => sum + (byPath.get(`reviews/history/blobs/${blob}`)?.bytes ?? 0), 0) });
      }
      state.retainedReviews.sort((first, second) => second.bytes - first.bytes);
    }
    catch (error) { state.cleanupBlocked = error instanceof Error ? error.message : String(error); }
    return state;
  }
  /**
   * Automatic cleanup of Review data nothing needs any more: snapshots and blobs that no tracking baseline, pending
   * change, Undo, active capture or restore point refers to, once they are older than `minAgeMs`. Everything else
   * stays: references, demo history, restore points, usage, accounts and attachments are never candidates.
   * One pass holds the storage lock only briefly, so it removes at most `maxFiles` files; `remaining` says whether
   * another pass is worth running.
   */
  async autoCleanReview(options: { minAgeMs?: number; maxFiles?: number } = {}): Promise<AutoCleanResult> {
    const minAge = Math.max(grace, options.minAgeMs ?? autoCleanAge), maxFiles = Math.max(1, options.maxFiles ?? autoCleanBatch);
    return withStorageLock(this.root, async () => {
      const now = Date.now(), inventory = await this.inventory();
      const orphans = (await this.candidates(inventory, now, new Map(), new Set(), false, minAge)).filter(file => file.relative.startsWith('reviews/history/'));
      // Leftovers of an interrupted capture. Captures hold this lock, so nothing live can match while we hold it.
      const leftovers = inventory.filter(file => now - file.modified >= minAge && /^reviews\/[a-f0-9-]{36}\.git-review(?:\.normalized)?$|^reviews\/history\/(?:blobs|snapshots)\/[^/]+\.tmp$/i.test(file.relative));
      const all = [...orphans, ...leftovers], batch = all.slice(0, maxFiles);
      const result = batch.length ? await this.removeFiles(batch, batch) : { removed: 0, bytes: 0, skipped: 0, failures: [] };
      return { ...result, remaining: all.length - batch.length };
    });
  }
  /**
   * Keep AgentTandem data under `limitBytes`, rolling: unused review snapshots go first (ten minutes old or more),
   * then message checkpoints, oldest first across projects, until the total is back to `target` of the limit.
   * Pending review changes, tracking baselines, the restore backup (Undo), active captures, token usage, accounts and
   * attachments are never removed. `limitReached` is false when only protected data is left above the limit;
   * `remaining` says another pass is needed because this one hit `maxRecords`.
   */
  async enforceLimit(limitBytes: number, options: { target?: number; maxRecords?: number } = {}): Promise<StorageLimitResult> {
    const empty = { removed: 0, bytes: 0, skipped: 0, failures: [] as string[], checkpointsRemoved: 0, trackingStopped: 0 };
    if (!Number.isFinite(limitBytes) || limitBytes <= 0) return { ...empty, total: 0, limitReached: true, remaining: false };
    const target = Math.floor(limitBytes * Math.min(1, Math.max(0.5, options.target ?? 0.9))), maxRecords = Math.max(1, options.maxRecords ?? 500);
    return withStorageLock(this.root, async () => {
      let inventory = await this.inventory();
      const total = inventory.reduce((sum, file) => sum + file.bytes, 0);
      if (total <= limitBytes) return { ...empty, total, limitReached: true, remaining: false };
      const unused = await this.autoCleanReview({ minAgeMs: grace });
      if (unused.removed) inventory = await this.inventory();
      let current = inventory.reduce((sum, file) => sum + file.bytes, 0);
      const swept = { ...empty, removed: unused.removed, bytes: unused.bytes, skipped: unused.skipped, failures: unused.failures };
      if (current <= target || unused.remaining) return { ...swept, total, limitReached: current <= limitBytes || unused.remaining > 0, remaining: unused.remaining > 0 };
      const byPath = new Map(inventory.map(file => [file.relative, file]));
      // Everything Review keeps, including tracking baselines and active captures, stays.
      const kept = new Set<string>(), busy = new Set<string>(), snapshots = new Set<string>(), blobs = new Set<string>();
      for (const file of inventory.filter(file => reviewFile.test(file.relative))) {
        await this.reviewReferences(file, snapshots, blobs);
        if ((await this.json(file)).active) busy.add(path.basename(file.relative, '.json'));
      }
      const pathsOf = this.manifestPaths(byPath);
      for (const blob of blobs) kept.add(`reviews/history/blobs/${blob}`);
      for (const id of snapshots) for (const relative of await pathsOf(id)) kept.add(relative);
      const records: { relative: string; record: CheckpointRecord; removable: boolean }[] = [];
      for (const file of inventory.filter(file => checkpointFile.test(file.relative))) {
        const saved = await this.json(file);
        if (!Array.isArray(saved)) throw new Error(`Invalid checkpoint metadata: ${file.relative}`);
        for (const record of saved as CheckpointRecord[]) {
          if (!record || !uuid.test(record.id) || !uuid.test(record.snapshot) || !Number.isFinite(record.createdAt)) throw new Error(`Invalid checkpoint record: ${file.relative}`);
          records.push({ relative: file.relative, record, removable: !record.undo && !busy.has(path.basename(file.relative, '.json')) });
        }
      }
      // Snapshots no checkpoint names (recent captures still inside the grace period) keep their blobs too.
      const named = new Set(records.map(entry => entry.record.snapshot));
      for (const file of inventory) {
        const match = /^reviews\/history\/snapshots\/([a-f0-9-]{36})\.json$/i.exec(file.relative);
        if (match && !named.has(match[1]!)) for (const relative of await pathsOf(match[1]!)) kept.add(relative);
      }
      // Consecutive checkpoints share most blobs; a file frees space only once its last checkpoint goes.
      const owners = new Map<string, number>();
      for (const entry of records) for (const relative of await pathsOf(entry.record.snapshot)) owners.set(relative, (owners.get(relative) ?? 0) + 1);
      const chosen = new Map<string, Set<string>>(), released = new Set<string>();
      let freed = 0, count = 0;
      for (const entry of records.filter(entry => entry.removable).sort((a, b) => a.record.createdAt - b.record.createdAt)) {
        if (current - freed <= target || count >= maxRecords) break;
        const ids = chosen.get(entry.relative) ?? new Set<string>(); ids.add(entry.record.id); chosen.set(entry.relative, ids); count++;
        for (const relative of await pathsOf(entry.record.snapshot)) {
          const left = owners.get(relative)! - 1; owners.set(relative, left);
          if (!left && !kept.has(relative)) { released.add(relative); freed += byPath.get(relative)?.bytes ?? 0; }
        }
      }
      if (!count) return { ...swept, total, limitReached: current <= limitBytes, remaining: false };
      const more = current - freed > target && records.some(entry => entry.removable && !chosen.get(entry.relative)?.has(entry.record.id));
      const overrides = new Map<string, unknown>(), edits: HistoryDeletionPlan['records'] = [];
      for (const [relative, ids] of chosen) {
        const text = await readFile(path.join(this.root, relative), 'utf8');
        overrides.set(relative, (JSON.parse(text) as CheckpointRecord[]).filter(record => !ids.has(record.id)));
        edits.push({ relative, digest: digest(text), ids: [...ids] });
      }
      const files = await this.candidates(inventory, Date.now(), overrides, released, true);
      const result = await this.deleteHistory({ token: randomUUID(), createdAt: Date.now(), histories: [], records: edits, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) });
      current -= result.bytes;
      return { ...result, removed: result.removed + swept.removed, bytes: result.bytes + swept.bytes, skipped: result.skipped + swept.skipped, failures: [...swept.failures, ...result.failures], total, limitReached: current <= limitBytes || more, remaining: more && !result.failures.length };
    });
  }
  /** Size-only background inventory: no snapshot parsing or cleanup planning. */
  async usage(): Promise<{ total: number; files: number; categories: NonNullable<StorageState['categories']> }> {
    const files = await this.inventory(), groups = new Map<string, { label: string; bytes: number; files: number }>();
    for (const file of files) {
      const label = category(file.relative), row = groups.get(label) ?? { label, bytes: 0, files: 0 };
      row.bytes += file.bytes; row.files++; groups.set(label, row);
    }
    return { total: files.reduce((sum, file) => sum + file.bytes, 0), files: files.length, categories: [...groups.values()].sort((a, b) => b.bytes - a.bytes) };
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
      let unsafe = false;
      const folders = new Map<string, Promise<void>>();
      const realFolder = async (full: string) => { const info = await lstat(full); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Linked path was kept.'); };
      const removeOne = async (file: StoredFile) => {
        // A manifest (or other non-blob file) that could not be removed may still name these blobs, so then no blob
        // goes. A blob that fails names nothing: the other blobs still go, so one locked file cannot keep gigabytes.
        const isBlob = file.relative.includes('blobs/');
        if (unsafe && isBlob) { result.skipped++; report(); return; }
        const current = fresh.get(file.relative);
        if (!current || ['bytes', 'modified', 'changed', 'inode'].some(key => current[key as keyof StoredFile] !== file[key as keyof StoredFile])) { result.skipped++; report(); return; }
        try {
          assertPath(file.relative);
          // Every folder on the way must be a real folder, not a link. 160,000 blobs share the same three, so each
          // folder is checked once per run (the storage lock is held); the file itself is checked every time.
          const parts = file.relative.split('/'), name = parts.pop()!;
          let full = this.root;
          for (const part of parts) { full = path.join(full, part); await (folders.get(full) ?? folders.set(full, realFolder(full)).get(full)); }
          full = path.join(full, name);
          const info = await lstat(full); if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error('Linked path was kept.');
          // Antivirus scanners and indexers briefly hold files open on Windows; retry those before giving up.
          for (let attempt = 0; ; attempt++) {
            try { await unlink(full); break; }
            catch (error) { if (attempt >= 2 || !['EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1))); }
          }
          result.removed++; result.bytes += file.bytes;
        } catch (error) { if (!isBlob) unsafe = true; result.failures.push(`${file.relative}: ${error instanceof Error ? error.message : String(error)}`); }
        report();
      };
      // A full review cleanup removes 100,000+ files; one at a time that takes minutes. Manifests and other files go
      // first and must all finish before any blob is touched.
      const pool = async (files: StoredFile[]) => {
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(removeConcurrency, files.length) }, async () => { while (next < files.length) await removeOne(files[next++]!); }));
      };
      const blob = (file: StoredFile) => file.relative.includes('blobs/');
      await pool(approved.filter(file => !blob(file))); await pool(approved.filter(blob));
      return result;
  }
}
