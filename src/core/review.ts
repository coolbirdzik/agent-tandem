import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, unlink, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import { createTwoFilesPatch, diffLines } from 'diff';
import { HistoryStore, assertPath } from './history';
import type { FileChange, Manifest, Snapshot } from './types';
import { streamFile } from './blob';
import { reviewHunks, textSnapshot, encodeSnapshot, type ReviewHunk } from './review-hunks';
import { withStorageLock } from './storage-lock';
import { captureConversations, editOverlapsCapture, type ReviewCapture, type ReviewConversation, type ConversationEdit } from './review-conversations';
import { reviewGroup } from './review-groups';
import { imageSnapshots, type ImageComparison } from './media-preview';
import { reviewGitHead, reviewCommittedPaths, reviewCommittedFile, reviewUncommittedPaths, reviewGitEquivalentFiles } from './review-git';

const execute = promisify(execFile);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
class ReviewTargetError extends Error {
  constructor(message: string, readonly nonFile = false) { super(message); }
}
export interface ReviewFile extends FileChange { additions?: number; deletions?: number; captures?: ReviewCapture[] }
export interface ReviewState { revision: string; files: ReviewFile[]; busy: boolean; notice?: string; externalTracking?: boolean; undo?: { id: string; createdAt: number; files: string[] } }
export interface ReviewRequest { project: string; revision: string; file?: string; group?: string }
export interface ReviewHunkRequest extends ReviewRequest { file: string; hunk: string }
interface PendingReview {
  version: 1; project: string; revision: string; files: ReviewFile[];
  gitHead?: string | null;
  active?: { requestId: string; before: string; from?: number; conversation?: ReviewConversation }; external?: string; externalCapturedAt?: number; externalDecidedAt?: Record<string, number>; externalPreference?: boolean; notice?: string;
  revertUndo?: { id: string; createdAt: number; files: RevertFile[]; phase?: 'reverting' | 'undoing' };
}
interface RevertFile { original: ReviewFile; after?: string; remaining?: ReviewFile }
export interface ReviewPreview { path: string; patch?: string; notice?: string; before: string; after: string }
export interface ReviewWebviewFile extends ReviewFile {
  beforeText?: string; afterText?: string; hunks: ReviewHunk[];
  beforeSize: number; afterSize: number; notice?: string;
  images?: ImageComparison;
}
export interface CheckpointPlan { target: string; current: string; revision: string; files: ReviewFile[] }

/** Workspace changes are already applied. Review owns snapshots and decisions only. */
export class ReviewStore {
  readonly history: HistoryStore;
  constructor(readonly directory: string, private canReadGit = () => true) {
    this.history = new HistoryStore(path.join(directory, 'history'), undefined, path.dirname(directory));
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    return withStorageLock(path.dirname(this.directory), operation);
  }
  private filename(project: string) { const resolved = path.resolve(project); return path.join(this.directory, `${hash(process.platform === 'win32' ? resolved.toLowerCase() : resolved)}.json`); }
  private async load(project: string, reconcileCommits = false): Promise<PendingReview> {
    let value: PendingReview;
    try { value = JSON.parse(await readFile(this.filename(project), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      value = { version: 1, project, revision: randomUUID(), files: [] };
    }
    if (value.version !== 1 || value.project !== project || typeof value.revision !== 'string' || !Array.isArray(value.files)) throw new Error('Invalid pending change review.');
    if (value.gitHead !== undefined && value.gitHead !== null && (typeof value.gitHead !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.gitHead))) throw new Error('Invalid review Git commit.');
    if (value.external !== undefined && !/^[a-f0-9-]{36}$/i.test(value.external)) throw new Error('Invalid external review baseline.');
    if (value.externalPreference !== undefined && typeof value.externalPreference !== 'boolean') throw new Error('Invalid external tracking preference.');
    if (value.externalCapturedAt !== undefined && !Number.isFinite(value.externalCapturedAt)) throw new Error('Invalid external capture timestamp.');
    if (value.externalDecidedAt !== undefined) {
      if (!value.externalDecidedAt || typeof value.externalDecidedAt !== 'object' || Array.isArray(value.externalDecidedAt)) throw new Error('Invalid review decision timestamps.');
      for (const [name, at] of Object.entries(value.externalDecidedAt)) { assertPath(name); if (!Number.isFinite(at)) throw new Error('Invalid review decision timestamp.'); }
    }
    const protectedFiles = [...value.files];
    if (value.revertUndo !== undefined) {
      const undo = value.revertUndo;
      if (!undo || typeof undo.id !== 'string' || !Number.isFinite(undo.createdAt) || !Array.isArray(undo.files) || (undo.phase !== undefined && !['reverting', 'undoing'].includes(undo.phase))) throw new Error('Invalid revert Undo.');
      const paths = new Set<string>();
      for (const entry of undo.files) {
        if (!entry?.original || (entry.after !== undefined && !/^[a-f0-9]{64}$/.test(entry.after)) || paths.has(entry.original.path) || (entry.remaining && (entry.remaining.path !== entry.original.path || entry.remaining.after !== entry.after))) throw new Error('Invalid revert Undo file.');
        paths.add(entry.original.path); protectedFiles.push(entry.original);
        if (entry.remaining) protectedFiles.push(entry.remaining);
      }
    }
    for (const file of protectedFiles) {
      assertPath(file.path);
      if (!['added', 'modified', 'deleted'].includes(file.kind) || typeof file.binary !== 'boolean' || file.before === file.after) throw new Error('Invalid pending file change.');
      for (const id of [file.before, file.after]) if (id !== undefined && !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid review snapshot.');
      if (file.captures !== undefined) {
        if (!Array.isArray(file.captures)) throw new Error('Invalid review provenance.');
        for (const capture of file.captures) {
          if (!Number.isFinite(capture.from) || !Number.isFinite(capture.to) || capture.from > capture.to) throw new Error('Invalid review capture interval.');
          for (const id of [capture.before, capture.after]) if (id !== undefined && !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid capture snapshot.');
          if (capture.conversations !== undefined && (!Array.isArray(capture.conversations) || capture.conversations.some(item => !item || typeof item.key !== 'string' || typeof item.title !== 'string' || !['Codex', 'Claude'].includes(item.provider)))) throw new Error('Invalid review conversation.');
          if (capture.assignment !== undefined && (capture.assignment !== 'manual' || capture.conversations?.length !== 1)) throw new Error('Invalid manual conversation link.');
        }
      }
    }
    if (value.revertUndo?.phase) await this.recoverRevert(value);
    if (reconcileCommits && !value.active && await this.acceptCommitted(value)) await this.save(value);
    return value;
  }
  private async save(value: PendingReview) {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.filename(value.project)}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx' }); await rename(temporary, this.filename(value.project)); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  private view(value: PendingReview): ReviewState { return { revision: value.revision, files: value.files, busy: !!value.active, notice: value.notice, ...(value.external ? { externalTracking: true } : {}), ...(value.revertUndo ? { undo: { id: value.revertUndo.id, createdAt: value.revertUndo.createdAt, files: value.revertUndo.files.map(entry => entry.original.path) } } : {}) }; }
  read(project: string) { return this.serial(async () => this.view(await this.load(project, true))); }

  private async acceptCommitted(value: PendingReview): Promise<boolean> {
    if (!this.canReadGit()) return false;
    const head = await reviewGitHead(value.project);
    if (head === undefined || value.gitHead === head) return false;
    if (head === null) { value.gitHead = null; return true; }
    const initializing = value.gitHead === undefined;
    const names = initializing ? value.files.map(file => file.path) : await reviewCommittedPaths(value.project, value.gitHead!, head);
    const dirty = names.length ? await reviewUncommittedPaths(value.project, head) : new Set<string>();
    const committed: Record<string, string | undefined> = Object.create(null), current: Record<string, string | undefined> = Object.create(null);
    for (const name of names) {
      assertPath(name);
      const temporary = path.join(this.directory, `${randomUUID()}.git-review`);
      const normalizedFile = `${temporary}.normalized`;
      await mkdir(this.directory, { recursive: true });
      try {
        const kind = await reviewCommittedFile(value.project, head, name, temporary);
        if (kind === 'unsupported') continue;
        const id = kind === 'file' ? await this.history.putFileBlob(temporary) : undefined;
        const pending = value.files.find(file => file.path === name);
        if (initializing && id !== pending?.after && (kind !== 'file' || dirty.has(name))) continue;
        committed[name] = id;
        if (pending || (kind === 'file' && !dirty.has(name))) {
          try { current[name] = await this.history.putFileBlob(await this.safePath(value.project, name)); }
          catch (error) {
            const replaced = kind === 'deleted' && ((error instanceof ReviewTargetError && error.nonFile) || (error as NodeJS.ErrnoException).code === 'ENOTDIR');
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !replaced) throw error;
            current[name] = undefined;
          }
          // Git can commit LF bytes without rewriting an LF worktree even when
          // checkout filters would produce CRLF. Keep its clean working bytes.
          if (kind === 'file' && !dirty.has(name)) committed[name] = current[name];
          else if (id && current[name]) {
            const [left, right] = await Promise.all([this.history.inspectBlob(id), this.history.inspectBlob(current[name]!)]);
            if (left.text !== undefined && right.text !== undefined && !left.binary && !right.binary) {
              const crlf = right.text.includes('\r\n') && !right.text.replace(/\r\n/g, '').includes('\n');
              const normalized = crlf ? left.text.replace(/\r?\n/g, '\r\n') : !right.text.includes('\r\n') ? left.text.replace(/\r\n/g, '\n') : left.text;
              if (normalized !== left.text) {
                const bytes = encodeSnapshot(normalized, await this.history.readBlob(id));
                await writeFile(normalizedFile, bytes, { flag: 'wx' });
                if (await reviewGitEquivalentFiles(value.project, name, temporary, normalizedFile)) committed[name] = await this.history.putBlob(bytes);
              }
            }
          }
        }
      } finally { await unlink(temporary).catch(() => undefined); await unlink(normalizedFile).catch(() => undefined); }
    }
    // A second commit during the scan is reconciled on the next refresh.
    if (await reviewGitHead(value.project) !== head) return false;
    if (Object.keys(committed).length) {
      const before: Snapshot = { id: randomUUID(), files: Object.create(null) }, after: Snapshot = { id: randomUUID(), files: Object.create(null) };
      const to = Date.now(), from = Math.min(to, ...value.files.filter(file => Object.hasOwn(current, file.path)).flatMap(file => file.captures?.map(capture => capture.from) ?? []));
      for (const [name, id] of Object.entries(current)) {
        if (committed[name]) before.files[name] = committed[name]!;
        if (id) after.files[name] = id;
      }
      const previous = new Map(value.files.filter(file => Object.hasOwn(committed, file.path)).map(file => [file.path, file]));
      value.files = value.files.filter(file => !Object.hasOwn(committed, file.path));
      await this.mergeChanges(value, before, after, { from, to });
      for (const file of value.files) {
        const prior = previous.get(file.path);
        if (!prior) continue;
        // Historical captures still identify the authors of the remaining edits.
        // Only bytes changed since the last capture need new, unassigned evidence.
        const captures = prior.captures ?? [{ before: prior.before, after: prior.after, from: 0, to: 0 }];
        file.captures = [...captures, ...(prior.after === file.after ? [] : [{ before: prior.after, after: file.after,
          from: Math.min(to, Math.max(from, ...captures.map(capture => capture.to))), to }])];
      }
      // Already reconciled working bytes must not be captured a second time.
      // Other committed paths start at HEAD so their next edits remain reviewable.
      await this.saveExternalBaseline(value, { ...committed, ...current });
      if (value.revertUndo) {
        value.revertUndo.files = value.revertUndo.files.filter(entry => !Object.hasOwn(committed, entry.original.path));
        if (!value.revertUndo.files.length) value.revertUndo = undefined;
      }
      value.revision = randomUUID();
      value.notice = 'Committed changes were accepted automatically. Uncommitted changes remain available for review.';
    }
    value.gitHead = head;
    return true;
  }

  private async safePath(project: string, name: string, resolvedRoot?: string) {
    assertPath(name);
    const root = resolvedRoot ?? await realpath(project), target = path.resolve(root, ...name.split('/'));
    const relative = path.relative(root, target);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`File escapes project: ${name}`);
    let current = root;
    for (const segment of name.split('/')) {
      current = path.join(current, segment);
      let info;
      try { info = await lstat(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new ReviewTargetError(`Linked file cannot be reviewed: ${name}`);
      if (current === target && !info.isFile()) throw new ReviewTargetError(`Review target is not a file: ${name}`, true);
    }
    return target;
  }
  private async fingerprint(project: string, name: string): Promise<string | undefined> {
    const full = await this.safePath(project, name);
    try { return (await streamFile(full)).hash; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async capture(project: string, known: string[] = [], previous?: Pick<Snapshot, 'files'>, signal?: AbortSignal, tolerateFileErrors = false): Promise<Snapshot & { notice?: string }> {
    signal?.throwIfAborted();
    const root = await realpath(project);
    const skipped = new Map<string, string>();
    const canSkip = (error: unknown) => {
      if (error instanceof ReviewTargetError) return error.nonFile || tolerateFileErrors;
      if (!tolerateFileErrors) return false;
      const failure = error as NodeJS.ErrnoException;
      // A workspace read failure must not hide a failure to write snapshot storage.
      const changedPrefix = 'File changed while preparing review: ';
      const changed = error instanceof Error && error.message.startsWith(changedPrefix);
      const file = failure.path ?? (changed ? error.message.slice(changedPrefix.length) : undefined);
      if (!file || (!changed && !['EACCES', 'EPERM', 'EBUSY', 'EISDIR', 'ENOTDIR'].includes(failure.code ?? ''))) return false;
      const within = (directory: string) => {
        const relative = path.relative(directory, path.resolve(root, file));
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      };
      return within(root) && !within(path.resolve(this.history.directory));
    };
    const skip = (name: string, error: unknown) => skipped.set(name, error instanceof Error ? error.message : String(error));
    let names: string[];
    try {
      const { stdout } = await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: project, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      names = stdout.split('\0').filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error as { stderr?: string }).stderr?.includes('not a git repository')) throw error;
      names = [];
      const scan = async (folder: string, prefix: string, rules: ReturnType<typeof ignore>) => {
        const local = ignore().add(rules);
        try { local.add((await readFile(path.join(folder, '.gitignore'), 'utf8')).split(/\r?\n/).map(line => {
          if (!prefix || line.startsWith('#') || !line) return line;
          const negative = line.startsWith('!'), pattern = negative ? line.slice(1) : line;
          const scoped = pattern.replace(/\/$/, '').includes('/') || pattern.startsWith('/') ? `${prefix}${pattern.replace(/^\//, '')}` : `${prefix}**/${pattern}`;
          return `${negative ? '!' : ''}${scoped}`;
        })); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          signal?.throwIfAborted();
          const name = `${prefix}${entry.name}`;
          if (local.ignores(name + (entry.isDirectory() ? '/' : ''))) continue;
          if (entry.isDirectory()) {
            try { await scan(path.join(folder, entry.name), `${name}/`, local); }
            catch (error) { if (!canSkip(error)) throw error; skip(name, error); }
          }
          else names.push(name);
        }
      };
      await scan(project, '', ignore().add(['.git/', 'node_modules/', '.test-runtime/', '.vscode-test/']));
    }
    const keys = new Set<string>();
    names = [...known, ...names].filter(name => {
      const key = process.platform === 'win32' ? name.toLowerCase() : name;
      if (keys.has(key)) return false; keys.add(key); return true;
    }).sort();
    const files: Manifest = Object.create(null);
    // Workspace size is not a chat limit. Reuse immutable blobs for unchanged
    // files and identical contents; avoid publishing thousands of duplicate blobs.
    const blobs = new Map<string, Promise<string>>();
    let next = 0;
    let failed = false;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(8, names.length) }, async () => {
      try { while (next < names.length && !failed) {
        signal?.throwIfAborted();
        const name = names[next++]!;
        try {
          const full = await this.safePath(project, name, root);
          let info;
          try { info = await lstat(full); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
          if (info.size > 512 * 1024) {
            if (previous?.files[name]) {
              const current = await streamFile(full, { signal });
              if (current.hash === previous.files[name]) { files[name] = current.hash; continue; }
            }
            files[name] = await this.history.putFileBlob(full, signal);
            continue;
          }
          const content = await readFile(full);
          if (content.length !== info.size) throw new Error(`File changed while preparing review: ${name}`);
          const id = hash(content);
          if (previous?.files[name] === id) files[name] = id;
          else {
            let blob = blobs.get(id);
            if (!blob) { blob = this.history.putBlob(content); blobs.set(id, blob); }
            files[name] = await blob;
          }
        } catch (error) {
          signal?.throwIfAborted();
          if ((error as NodeJS.ErrnoException).code === 'ENOENT'
            && (error as NodeJS.ErrnoException).path === path.resolve(root, ...name.split('/'))) continue;
          if (!canSkip(error)) throw error;
          skip(name, error);
          // Preserve the last captured bytes while a path is unreadable or has
          // become a directory/link; omitting it would invent a deletion.
          if (previous?.files[name]) files[name] = previous.files[name]!;
        }
      } } catch (error) { failed = true; throw error; }
    }));
    for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
    signal?.throwIfAborted();
    const snapshot = { id: randomUUID(), files };
    const directory = path.join(this.history.directory, 'snapshots'); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${snapshot.id}.json`), JSON.stringify(snapshot), { flag: 'wx' });
    const issues = [...skipped].sort(([a], [b]) => a.localeCompare(b));
    const notice = issues.length ? `Skipped ${issues.length} review ${issues.length === 1 ? 'path' : 'paths'}: ${issues.slice(0, 5).map(([name, reason]) => `${name} (${reason})`).join('; ')}${issues.length > 5 ? '; …' : ''}. Other files are still captured; skipped paths are checked again on the next capture.` : undefined;
    return { ...snapshot, notice };
  }
  begin(project: string, requestId: string, signal?: AbortSignal, conversation?: ReviewConversation) { return this.serial(async () => {
    const value = await this.load(project, true);
    if (value.active) throw new Error('A change review is still capturing an agent turn.');
    if (value.external) await this.scanExternalValue(value);
    const previous = value.external ? await this.history.snapshot(value.external) : undefined;
    const before = await this.capture(project, value.files.map(file => file.path), previous, signal, !!value.external);
    for (const file of value.files) if (before.files[file.path] !== file.after) throw new Error(`Pending ${file.path} changed outside the agent. Accept its review before starting another turn; your edits were kept.`);
    value.active = { requestId, before: before.id, from: Date.now(), conversation }; value.notice = before.notice;
    await this.save(value); return this.view(value);
  }); }
  checkpointBefore(project: string, requestId: string) { return this.serial(async () => {
    const value = await this.load(project);
    if (value.active?.requestId !== requestId) throw new Error('The message checkpoint is no longer available.');
    return value.active.before;
  }); }
  finish(project: string, requestId?: string, recovered = false) { return this.serial(() => this.finishTurn(project, requestId, recovered)); }
  private async finishTurn(project: string, requestId?: string, recovered = false) {
    const value = await this.load(project);
    if (!value.active || (requestId && value.active.requestId !== requestId)) return this.view(value);
    const before = await this.history.snapshot(value.active.before);
    const after = await this.capture(project, [...Object.keys(before.files), ...value.files.map(file => file.path)], before, undefined, !!value.external);
    const to = Date.now();
    await this.mergeChanges(value, before, after, { from: value.active.from ?? to, to, conversations: value.active.conversation ? [value.active.conversation] : undefined });
    if (value.external) { value.external = after.id; value.externalCapturedAt = to; }
    value.files.sort((a, b) => a.path.localeCompare(b.path)); value.active = undefined; value.revision = randomUUID();
    value.notice = [recovered ? 'Recovered changes from an interrupted agent turn.' : undefined, after.notice].filter(Boolean).join(' ') || undefined;
    await this.acceptCommitted(value);
    await this.save(value); return this.view(value);
  }
  private async mergeChanges(value: PendingReview, before: Snapshot, after: Snapshot, capture?: Omit<ReviewCapture, 'before' | 'after'>) {
    let changed = false;
    const names = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
    for (const name of names) {
      const prior = before.files[name], next = after.files[name];
      if (prior === next) continue;
      changed = true;
      const change: FileChange = { path: name, before: prior, after: next, kind: !prior ? 'added' : !next ? 'deleted' : 'modified', binary: false };
      const old = value.files.find(file => file.path === change.path);
      // Successive agent turns share the original pending baseline.
      const original = old ? old.before : change.before;
      value.files = value.files.filter(file => file.path !== change.path);
      if (original === change.after) continue;
      const file: ReviewFile = { ...change, before: original, kind: !original ? 'added' : !change.after ? 'deleted' : 'modified' };
      const decidedAt = value.externalDecidedAt && Object.hasOwn(value.externalDecidedAt, name) ? value.externalDecidedAt[name]! : 0;
      const from = capture && !capture.conversations?.length ? Math.min(capture.to, Math.max(capture.from, decidedAt)) : capture?.from;
      file.captures = [...(old?.captures ?? (old ? [{ before: old.before, after: old.after, from: 0, to: 0 }] : [])), ...(capture ? [{ ...capture, from: from!, before: prior, after: next }] : [])];
      const [left, right] = await Promise.all([original ? this.history.inspectBlob(original) : { size: 0, binary: false, text: '' }, change.after ? this.history.inspectBlob(change.after) : { size: 0, binary: false, text: '' }]);
      file.binary = left.binary || right.binary;
      if (!file.binary) {
        if (left.size + right.size <= 512 * 1024) {
          const parts = diffLines(left.text!, right.text!);
          file.additions = parts.filter(part => part.added).reduce((n, part) => n + part.count, 0);
          file.deletions = parts.filter(part => part.removed).reduce((n, part) => n + part.count, 0);
        }
      }
      value.files.push(file);
    }
    value.files.sort((a, b) => a.path.localeCompare(b.path));
    return changed;
  }
  private async saveExternalBaseline(value: PendingReview, changes: Record<string, string | undefined>) {
    if (!value.external) return;
    const saved = await this.history.snapshot(value.external);
    const snapshot: Snapshot = { id: randomUUID(), files: { ...saved.files } };
    for (const [name, id] of Object.entries(changes)) {
      if (id) snapshot.files[name] = id; else delete snapshot.files[name];
      value.externalDecidedAt ??= Object.create(null); value.externalDecidedAt![name] = Date.now();
    }
    await writeFile(path.join(this.history.directory, 'snapshots', `${snapshot.id}.json`), JSON.stringify(snapshot), { flag: 'wx' });
    value.external = snapshot.id;
  }
  initializeExternalTracking(project: string, enabledByDefault = true) { return this.serial(async () => {
    const value = await this.load(project, true);
    if (!enabledByDefault || value.externalPreference !== undefined || value.external || value.active) return this.view(value);
    return this.setExternalValue(value, true);
  }); }
  setExternalTracking(project: string, enabled: boolean) { return this.serial(async () => this.setExternalValue(await this.load(project, true), enabled)); }
  private async setExternalValue(value: PendingReview, enabled: boolean) {
    const project = value.project;
    if (value.active) throw new Error('Wait for the active agent turn to finish.');
    if (enabled && !value.external) {
      const previous = { files: Object.fromEntries(value.files.filter(file => file.after).map(file => [file.path, file.after!])) };
      const before = await this.capture(project, value.files.map(file => file.path), previous, undefined, true);
      for (const file of value.files) if (before.files[file.path] !== file.after) throw new Error(`Pending ${file.path} changed outside review. Resolve its pending review first; your edits were kept.`);
      value.external = before.id;
      value.externalCapturedAt = Date.now();
      value.notice = 'Saved workspace changes are tracked. Conversation groups use native edit history or manual links; other edits remain unassigned. Existing changes are the starting baseline.';
      if (before.notice) value.notice += ` ${before.notice}`;
    } else if (!enabled && value.external) {
      await this.scanExternalValue(value);
      value.external = undefined;
      value.notice = value.files.length ? 'Captured external changes. Tracking stopped; pending changes remain available for review.' : undefined;
    }
    value.externalPreference = enabled;
    await this.save(value); return this.view(value);
  }
  scanExternal(project: string) { return this.serial(async () => {
    const value = await this.load(project, true);
    if (!value.external) return this.view(value);
    if (value.active) throw new Error('Wait for the active agent turn to finish.');
    await this.scanExternalValue(value); await this.save(value); return this.view(value);
  }); }
  private async scanExternalValue(value: PendingReview) {
    const before = await this.history.snapshot(value.external!);
    const after = await this.capture(value.project, [...Object.keys(before.files), ...value.files.map(file => file.path)], before, undefined, true);
    const to = Date.now();
    if (await this.mergeChanges(value, before, after, { from: value.externalCapturedAt ?? to, to })) value.revision = randomUUID();
    value.external = after.id;
    value.externalCapturedAt = to;
    value.externalDecidedAt = undefined;
    value.notice = 'Already applied · Conversation groups use native edit history or manual links. Other saved edits remain unassigned.';
    if (after.notice) value.notice += ` ${after.notice}`;
  }
  bindConversation(project: string, previous: string, conversation: ReviewConversation) { return this.serial(async () => {
    const value = await this.load(project);
    if (value.active?.conversation?.key === previous) value.active.conversation = conversation;
    for (const file of value.files) for (const capture of file.captures ?? []) capture.conversations = capture.conversations?.map(item => item.key === previous && !item.id ? conversation : item);
    await this.save(value); return this.view(value);
  }); }
  attributeConversations(project: string, edits: ConversationEdit[]) { return this.serial(async () => {
    const value = await this.load(project);
    if (value.active) return this.view(value);
    let changed = false;
    for (const file of value.files) for (const capture of file.captures ?? []) {
      if (capture.conversations?.length || !edits.some(edit => (process.platform === 'win32' ? edit.path.toLowerCase() === file.path.toLowerCase() : edit.path === file.path) && editOverlapsCapture(edit, capture))) continue;
      const blobs = await Promise.all([capture.before, capture.after].map(id => id ? this.history.inspectBlob(id) : undefined));
      if (blobs.some(blob => blob && (blob.binary || blob.size > 4 * 1024 * 1024 || blob.text === undefined))) continue;
      const sources = captureConversations(capture, file.path, blobs[0]?.text, blobs[1]?.text, edits);
      if (sources) { capture.conversations = sources; changed = true; }
    }
    if (changed) { value.revision = randomUUID(); await this.save(value); }
    return this.view(value);
  }); }
  /** Preview the complete saved workspace, including files now ignored or deleted. */
  prepareCheckpoint(project: string, target: string) { return this.serial(async (): Promise<CheckpointPlan> => {
    const value = await this.load(project, true);
    if (value.active) throw new Error('Wait for the agent and change capture to finish.');
    if (value.external) throw new Error('Stop external change tracking before restoring a checkpoint.');
    const saved = await this.history.snapshot(target);
    const current = await this.capture(project, [...Object.keys(saved.files), ...value.files.map(file => file.path)], saved);
    const files: ReviewFile[] = [];
    for (const name of [...new Set([...Object.keys(current.files), ...Object.keys(saved.files)])].sort()) {
      const before = current.files[name], after = saved.files[name];
      if (before === after) continue;
      const blobs = await Promise.all([before, after].filter((id): id is string => !!id).map(id => this.history.inspectBlob(id)));
      files.push({ path: name, before, after, kind: !before ? 'added' : !after ? 'deleted' : 'modified', binary: blobs.some(blob => blob.binary) });
    }
    return { target, current: current.id, revision: value.revision, files };
  }); }
  restoreCheckpoint(project: string, plan: CheckpointPlan, backup?: (snapshot: string) => Promise<void>) { return this.serial(async () => {
    const value = await this.load(project, true);
    if (value.active) throw new Error('Wait for the agent and change capture to finish.');
    if (value.external) throw new Error('Stop external change tracking before restoring a checkpoint.');
    if (value.revision !== plan.revision) throw new Error('Changes were reviewed after this preview. Preview the checkpoint again.');
    const [before, target] = await Promise.all([this.history.snapshot(plan.current), this.history.snapshot(plan.target)]);
    const fresh = await this.capture(project, [...Object.keys(before.files), ...Object.keys(target.files)], before);
    const names = new Set([...Object.keys(before.files), ...Object.keys(fresh.files)]);
    for (const name of names) if (before.files[name] !== fresh.files[name]) throw new Error(`Cannot restore ${name}: it changed after the preview. Preview the checkpoint again; your edits were kept.`);
    // Derive write targets from immutable manifests, never from caller-supplied paths.
    const changes = [...new Set([...Object.keys(before.files), ...Object.keys(target.files)])].sort().filter(name => before.files[name] !== target.files[name]);
    for (const name of changes) {
      await this.safePath(project, name);
      if (target.files[name]) await this.history.inspectBlob(target.files[name]!);
    }
    if (!changes.length) return this.view(value);
    await backup?.(before.id);
    const requestId = `restore:${randomUUID()}`;
    // Journal before writing. Reload can recover an interrupted restore just like an agent turn.
    value.active = { requestId, before: before.id }; await this.save(value);
    let failure: unknown;
    try {
      for (const name of changes) {
        if (await this.fingerprint(project, name) !== before.files[name]) throw new Error(`Cannot restore ${name}: it changed during restore. Your edits were kept.`);
        const full = await this.safePath(project, name), saved = target.files[name];
        if (!saved) await unlink(full);
        else {
          await mkdir(path.dirname(full), { recursive: true });
          const temporary = `${full}.${randomUUID()}.agent-tandem-restore`;
          try {
            await this.history.copyBlob(saved, temporary);
            if (await this.fingerprint(project, name) !== before.files[name]) throw new Error(`Cannot restore ${name}: it changed during restore. Your edits were kept.`);
            await this.safePath(project, name); await rename(temporary, full);
          } finally { await unlink(temporary).catch(() => undefined); }
        }
      }
    } catch (error) { failure = error; }
    const result = await this.finishTurn(project, requestId);
    if (failure) throw failure;
    return result;
  }); }
  private selected(value: PendingReview, request: ReviewRequest) {
    if (value.active) throw new Error('Wait for the agent and change capture to finish.');
    if (request.revision !== value.revision) throw new Error('The pending changes updated. Review them again.');
    const files = value.files.filter(file => (!request.file || file.path === request.file) && (!request.group || reviewGroup(file) === request.group));
    if (!files.length) throw new Error('This change has already been reviewed.');
    return files;
  }
  /** Explicit links cover scripts and binary output without claiming native byte evidence. */
  setConversationLink(request: ReviewRequest, conversation?: ReviewConversation) { return this.serial(async () => {
    if (conversation && (!['Codex', 'Claude'].includes(conversation.provider) || typeof conversation.id !== 'string' || !conversation.id || conversation.key !== `${conversation.provider}:${conversation.id}` || typeof conversation.title !== 'string')) throw new Error('Choose a saved conversation.');
    const value = await this.load(request.project), files = this.selected(value, request);
    let changed = false;
    for (const file of files) {
      if (!file.captures?.length) file.captures = [{ before: file.before, after: file.after, from: 0, to: 0 }];
      for (const capture of file.captures) {
        if (conversation ? capture.conversations?.length : capture.assignment !== 'manual') continue;
        if (conversation) {
          const { key, id, provider, title } = conversation;
          capture.conversations = [{ key, id, provider, title }]; capture.assignment = 'manual';
        } else { delete capture.conversations; delete capture.assignment; }
        changed = true;
      }
    }
    if (!changed) throw new Error(conversation ? 'These changes already have conversation links.' : 'These changes have no manual links to remove.');
    value.revision = randomUUID();
    value.notice = conversation ? 'Conversation link saved manually. Workspace files and review snapshots were kept.' : 'Manual conversation links removed. Automatic matching remains available.';
    await this.save(value); return this.view(value);
  }); }
  accept(request: ReviewRequest) { return this.serial(async () => {
    const value = await this.load(request.project, true), selected = this.selected(value, request);
    if (value.external) for (const file of selected) if (await this.fingerprint(request.project, file.path) !== file.after) throw new Error(`Cannot accept ${file.path}: it changed since capture. Refresh the review.`);
    await this.saveExternalBaseline(value, Object.fromEntries(selected.map(file => [file.path, file.after])));
    value.files = value.files.filter(file => !selected.includes(file)); value.revision = randomUUID(); value.notice = undefined;
    await this.save(value); return this.view(value);
  }); }
  private setPending(value: PendingReview, name: string, pending?: ReviewFile) {
    value.files = value.files.filter(file => file.path !== name);
    if (pending) value.files.push(structuredClone(pending));
    value.files.sort((a, b) => a.path.localeCompare(b.path));
  }
  /** Reconcile an interrupted decision from actual bytes, without writing workspace files. */
  private async recoverRevert(value: PendingReview) {
    const undo = value.revertUndo!;
    const remaining: RevertFile[] = [];
    for (const entry of undo.files) {
      const name = entry.original.path, current = await this.fingerprint(value.project, name);
      if (undo.phase === 'reverting') {
        if (current === entry.after) {
          this.setPending(value, name, entry.remaining);
          await this.saveExternalBaseline(value, { [name]: entry.after }); remaining.push(entry);
        }
      } else if (current === entry.original.after) {
        this.setPending(value, name, entry.original);
        await this.saveExternalBaseline(value, { [name]: entry.original.after });
      } else remaining.push(entry);
    }
    value.revertUndo = remaining.length ? { id: undo.id, createdAt: undo.createdAt, files: remaining } : undefined;
    value.revision = randomUUID(); await this.save(value);
  }
  private async writeDecision(project: string, name: string, expected: string | undefined, target: string | undefined) {
    const current = await this.fingerprint(project, name);
    if (current !== expected) throw new Error(`Cannot update ${name}: it changed during review. Your edits were kept.`);
    if (current === target) return;
    const full = await this.safePath(project, name);
    if (target === undefined) { await unlink(full); return; }
    await mkdir(path.dirname(full), { recursive: true });
    const temporary = `${full}.${randomUUID()}.agent-tandem-revert`;
    try {
      await this.history.copyBlob(target, temporary);
      if (await this.fingerprint(project, name) !== expected) throw new Error(`Cannot update ${name}: it changed during review. Your edits were kept.`);
      await this.safePath(project, name); await rename(temporary, full);
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  private async applyRevert(value: PendingReview, files: RevertFile[]) {
    // Preflight the complete scope, and pin both sides before the first workspace write.
    for (const entry of files) {
      const current = await this.fingerprint(value.project, entry.original.path);
      if (current !== entry.original.after && current !== entry.after) throw new Error(`Cannot revert ${entry.original.path}: it changed after the agent. Your edits were kept.`);
      for (const id of [entry.original.after, entry.after]) if (id) await this.history.inspectBlob(id);
    }
    value.revertUndo = { id: randomUUID(), createdAt: Date.now(), files: structuredClone(files), phase: 'reverting' };
    await this.save(value);
    try {
      for (const entry of files) {
        const current = await this.fingerprint(value.project, entry.original.path);
        // A retry can finish publishing a revert whose bytes were written before a crash.
        if (current !== entry.after) await this.writeDecision(value.project, entry.original.path, entry.original.after, entry.after);
        this.setPending(value, entry.original.path, entry.remaining);
        await this.saveExternalBaseline(value, { [entry.original.path]: entry.after });
        value.revision = randomUUID(); await this.save(value);
      }
    } finally { await this.recoverRevert(value); }
    value.notice = 'Reverted saved changes. Undo is available until the affected files change.';
    await this.save(value); return this.view(value);
  }
  undoRevert(project: string, id: string) { return this.serial(async () => {
    const value = await this.load(project, true), undo = value.revertUndo;
    if (value.active) throw new Error('Wait for the agent and change capture to finish.');
    if (!undo || undo.id !== id) throw new Error('This Revert is no longer available to Undo.');
    // Other conversations can keep changing; only this Revert's files must still match.
    for (const entry of undo.files) {
      const pending = value.files.find(file => file.path === entry.original.path);
      if (await this.fingerprint(project, entry.original.path) !== entry.after || !!pending !== !!entry.remaining || (pending && (pending.before !== entry.remaining?.before || pending.after !== entry.remaining?.after))) throw new Error(`Cannot undo ${entry.original.path}: it changed or was reviewed after Revert. Your edits were kept.`);
      if (entry.original.after) await this.history.inspectBlob(entry.original.after);
    }
    undo.phase = 'undoing'; await this.save(value);
    try {
      for (const entry of undo.files) {
        await this.writeDecision(project, entry.original.path, entry.after, entry.original.after);
        this.setPending(value, entry.original.path, entry.original);
        await this.saveExternalBaseline(value, { [entry.original.path]: entry.original.after });
        value.revision = randomUUID(); await this.save(value);
      }
    } finally { await this.recoverRevert(value); }
    value.notice = 'Restored the reverted changes to pending review.';
    await this.save(value); return this.view(value);
  }); }
  private async hunkData(file: ReviewFile) {
    const sizes = await Promise.all([file.before, file.after].map(id => id ? this.history.inspectBlob(id) : { size: 0 }));
    if (sizes.reduce((sum, item) => sum + item.size, 0) > 4 * 1024 * 1024) throw new Error('Large changes need file-level review.');
    const [left, right] = await Promise.all([
      file.before ? this.history.readBlob(file.before) : Buffer.alloc(0),
      file.after ? this.history.readBlob(file.after) : Buffer.alloc(0),
    ]);
    const before = textSnapshot(left), after = textSnapshot(right);
    let hunks = reviewHunks(before, after);
    // Creating/deleting even an empty file is one complete change.
    if (!hunks.length && (!file.before || !file.after)) hunks = [{ id: hash(`${file.before}:${file.after}`), oldLine: 0, newLine: 0, oldLines: 0, newLines: 0, oldStart: 0, oldEnd: before.length, newStart: 0, newEnd: after.length }];
    return { left, right, before, after, hunks };
  }
  hunks(request: ReviewRequest) { return this.serial(async (): Promise<ReviewHunk[]> => {
    const value = await this.load(request.project), file = this.selected(value, request)[0]!;
    if (!request.file) throw new Error('Choose a file change.');
    return (await this.hunkData(file)).hunks;
  }); }
  decideHunk(request: ReviewHunkRequest, revert: boolean) { return this.serial(async () => {
    if (typeof request.file !== 'string' || !request.file || typeof request.hunk !== 'string') throw new Error('Choose a change to review.');
    const value = await this.load(request.project, true), file = this.selected(value, request)[0]!;
    const data = await this.hunkData(file), hunk = data.hunks.find(item => item.id === request.hunk);
    if (!hunk) throw new Error('This change is stale. Review the updated preview.');
    const text = revert
      ? data.after.slice(0, hunk.newStart) + data.before.slice(hunk.oldStart, hunk.oldEnd) + data.after.slice(hunk.newEnd)
      : data.before.slice(0, hunk.oldStart) + data.after.slice(hunk.newStart, hunk.newEnd) + data.before.slice(hunk.oldEnd);
    const encoding = revert && file.after ? data.right : data.left;
    const result = revert && !file.before ? undefined : encodeSnapshot(text, encoding);
    const resultHash = result ? hash(result) : undefined;
    const current = await this.fingerprint(request.project, file.path);
    // A retry can publish a partial revert whose bytes were saved before a crash.
    if (current !== file.after && !(revert && current === resultHash)) throw new Error(`Cannot review ${file.path}: it changed after the agent. Your edits were kept.`);
    if (revert) {
      const updated = result ? await this.history.putBlob(result) : undefined;
      let remaining: ReviewFile | undefined;
      if (file.before && file.after && file.before !== updated) {
        const pending = reviewHunks(data.before, text);
        remaining = { ...structuredClone(file), after: updated, additions: pending.reduce((n, h) => n + h.newLines, 0), deletions: pending.reduce((n, h) => n + h.oldLines, 0) };
      }
      return this.applyRevert(value, [{ original: file, after: updated, remaining }]);
    }
    await this.saveExternalBaseline(value, { [file.path]: file.after });
    // Added/deleted files are one change. Existing empty files retain their identity.
    if (!file.before || !file.after) value.files = value.files.filter(item => item !== file);
    else {
      const updated = result ? await this.history.putBlob(result) : undefined;
      const before = updated, after = file.after;
      if (before === after) value.files = value.files.filter(item => item !== file);
      else {
        file.before = before; file.after = after;
        const pending = reviewHunks(text, data.after);
        file.additions = pending.reduce((n, h) => n + h.newLines, 0); file.deletions = pending.reduce((n, h) => n + h.oldLines, 0);
      }
    }
    value.revision = randomUUID(); value.notice = undefined; await this.save(value); return this.view(value);
  }); }
  revert(request: ReviewRequest) { return this.serial(async () => {
    const value = await this.load(request.project, true), selected = this.selected(value, request);
    return this.applyRevert(value, selected.map(file => ({ original: file, after: file.before })));
  }); }
  editorFiles(request: ReviewRequest) { return this.serial(async () => {
    const value = await this.load(request.project);
    if (request.revision !== value.revision) throw new Error('The pending changes updated. Review them again.');
    const files = value.files.filter(file => (!request.file || file.path === request.file) && (!request.group || reviewGroup(file) === request.group));
    if (!files.length) throw new Error('Choose a pending file change.');
    return files.map(file => ({ ...file }));
  }); }
  /** Bounded, immutable text or images for the shared Webview review editor. */
  webviewFile(request: ReviewRequest) { return this.serial(async (): Promise<ReviewWebviewFile> => {
    if (!request.file) throw new Error('Choose a file change.');
    const value = await this.load(request.project), file = this.selected(value, request)[0]!;
    const [left, right] = await Promise.all([file.before, file.after].map(id => id ? this.history.inspectBlob(id) : { size: 0, binary: false }));
    const result: ReviewWebviewFile = { ...file, beforeSize: left!.size, afterSize: right!.size, hunks: [] };
    const images = await imageSnapshots(this.history, file.path, file.before, file.after);
    if (images) return { ...result, images, notice: 'Image snapshots · review the whole file.' };
    if (file.binary || left!.binary || right!.binary) return { ...result, notice: 'Binary file. Review the whole file or open its saved snapshots in the native editor.' };
    if (left!.size + right!.size > 4 * 1024 * 1024) return { ...result, notice: 'Large file. Review the whole file or open its full saved snapshots in the native editor.' };
    try {
      const data = await this.hunkData(file);
      return { ...result, beforeText: data.before, afterText: data.after, hunks: data.hunks };
    } catch (error) {
      if (error instanceof Error && error.message.includes('computing changes took too long')) return { ...result, notice: error.message };
      throw error;
    }
  }); }
  preview(request: ReviewRequest) { return this.serial(async (): Promise<ReviewPreview> => {
    const value = await this.load(request.project);
    if (request.revision !== value.revision) throw new Error('The pending changes updated. Review them again.');
    const file = value.files.find(entry => entry.path === request.file);
    if (!file) throw new Error('Choose a pending file change.');
    const [left, right] = await Promise.all([file.before ? this.history.inspectBlob(file.before) : { size: 0, binary: false, text: '' }, file.after ? this.history.inspectBlob(file.after) : { size: 0, binary: false, text: '' }]);
    const before = left.text, after = right.text;
    if (before === undefined || after === undefined || left.size + right.size > 512 * 1024) return { path: file.path, before: `${left.size} bytes`, after: `${right.size} bytes`, notice: file.binary ? 'Binary file · saved snapshots' : 'Large file · saved snapshots' };
    return { path: file.path, before, after, patch: createTwoFilesPatch(`before/${file.path}`, `after/${file.path}`, before, after, '', '', { context: 3, timeout: 1000 }) };
  }); }
}
