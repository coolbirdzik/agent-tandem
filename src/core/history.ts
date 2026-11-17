import { createHash, randomUUID, type Hash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, unlink, link, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { FileChange, Manifest, Session, Snapshot } from './types';
import { streamFile } from './blob';
import { withStorageLock } from './storage-lock';
import { gitRefOfFile, gitRefPattern, readGitRefs } from './git-refs';

/** A manifest as stored: complete, or the difference from a complete `base`. */
interface StoredManifest { id: string; files: Manifest; base?: string; removed?: string[]; refs: Record<string, string>; repo?: string }
/** A difference from the base manifest larger than this share of it is written as a new complete manifest. */
const deltaShare = 0.25, deltaMinimum = 256;
/** Git-backed content up to this size is buffered in memory while it is written back as a blob. */
const materializeInMemory = 4 * 1024 * 1024;

const idPattern = /^[a-f0-9-]{36}$/;
const hashPattern = /^[a-f0-9]{64}$/;
export function assertPath(value: string): void {
  if (!value || value.includes('\\') || value.startsWith('/') || value.includes(':') || value.includes('\0') || value.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Invalid snapshot path.');
  }
}
function assertId(id: string) { if (!idPattern.test(id)) throw new Error('Invalid history ID.'); }
function assertHash(hash: string) { if (!hashPattern.test(hash)) throw new Error('Invalid blob hash.'); }
function hashBytes(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    try { return new TextDecoder('utf-16le', { fatal: true }).decode(bytes); } catch { return undefined; }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    try { return new TextDecoder('utf-16be', { fatal: true }).decode(bytes); } catch { return undefined; }
  }
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return undefined; }
}
/** Readable text of legacy Japanese files. EUC-JP first: Shift_JIS text rarely decodes as EUC-JP, while the reverse often succeeds as mojibake. */
export function decodeLegacy(bytes: Uint8Array): { text: string; encoding: string } | undefined {
  if (bytes.includes(0) || decodeText(bytes) !== undefined) return undefined;
  for (const encoding of ['euc-jp', 'shift_jis']) {
    let text: string;
    // Runtimes built without full ICU lack these decoders; such files stay binary.
    try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch { continue; }
    if (/[぀-ヿ一-鿿]/.test(text)) return { text, encoding };
  }
  return undefined;
}
export function decodeLegacyText(bytes: Uint8Array): string | undefined { return decodeLegacy(bytes)?.text; }
/** Text for people to read; editing must still go through byte-preserving views. */
export function displayText(bytes: Uint8Array): string | undefined { return decodeText(bytes) ?? decodeLegacyText(bytes); }

export class HistoryStore {
  /** Content Git can rebuild, learned from manifests this process read or wrote: SHA-256 → repository and ref spec. */
  private gitRefs = new Map<string, { repo: string; spec: string }>();
  /** Parsed manifests are immutable; a large workspace's baseline is read on every scan. */
  private manifests = new Map<string, { size: number; mtimeMs: number; value: StoredManifest }>();
  constructor(readonly directory: string, readonly maxBytes = 10 * 1024 * 1024, readonly lockDirectory = directory) {}

  private async saveJSON(file: string, value: unknown) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  async putBlob(bytes: Uint8Array): Promise<string> {
    return withStorageLock(this.lockDirectory, () => this.putBlobUnlocked(bytes));
  }
  private async putBlobUnlocked(bytes: Uint8Array): Promise<string> {
    if (bytes.byteLength > this.maxBytes) throw new Error('Snapshot exceeds the size limit.');
    const hash = hashBytes(bytes);
    const directory = path.join(this.directory, 'blobs');
    await mkdir(directory, { recursive: true });
    // Content-addressed: an existing blob needs verifying, never rewriting. Skipping the
    // temporary file avoids a write (and an antivirus scan) for every repeated content.
    if (await this.hasBlob(hash)) { await this.readBlob(hash); return hash; }
    // Publish only complete bytes; a crash cannot leave a partially written hash path.
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await link(temporary, path.join(directory, hash)).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.readBlob(hash); // Never silently reuse a corrupt existing blob.
      });
    } finally { await unlink(temporary).catch(() => undefined); }
    return hash;
  }

  /**
   * Write blobs for Git-backed content so it no longer depends on the repository, with one Git process per repository.
   * Content that already has a blob, or that no loaded manifest names, is left alone. Returns the content Git could not
   * rebuild (its object is gone); callers decide whether that is fatal.
   */
  async materialize(hashes: (string | undefined)[]): Promise<Set<string>> {
    const lost = new Set<string>(), wanted: string[] = [];
    for (const hash of new Set(hashes)) {
      if (!hash) continue;
      assertHash(hash);
      if (this.gitRefs.has(hash) && !await this.hasBlob(hash)) wanted.push(hash);
    }
    if (!wanted.length) return lost;
    await withStorageLock(this.lockDirectory, async () => {
      const directory = path.join(this.directory, 'blobs'), repositories = new Map<string, string[]>();
      await mkdir(directory, { recursive: true });
      for (const hash of wanted) if (!await this.hasBlob(hash)) {
        const { repo } = this.gitRefs.get(hash)!, list = repositories.get(repo) ?? [];
        list.push(hash); repositories.set(repo, list);
      }
      for (const [repo, list] of repositories) {
        // Objects arrive one after another. Small ones are written from memory a few at a time while Git sends the
        // next, since creating many files one by one is slow on Windows; large ones stream to disk.
        const temporaries: string[] = [], writing = new Set<Promise<void>>();
        let at = -1, chunks: Buffer[] = [], size = 0, handle: FileHandle | undefined, digest: Hash = createHash('sha256'), temporary = '', failure: unknown;
        const begin = (index: number) => {
          at = index; chunks = []; size = 0; handle = undefined; digest = createHash('sha256');
          temporary = path.join(directory, `${randomUUID()}.tmp`); temporaries.push(temporary);
        };
        // Verified bytes publish atomically under their hash; a crash leaves only a temporary file.
        const publish = async (hash: string, file: string, bytes?: Buffer) => {
          try { if (bytes) await writeFile(file, bytes, { flag: 'wx' }); await rename(file, path.join(directory, hash)); }
          catch (error) { if (!await this.hasBlob(hash)) failure ??= error; }
        };
        try {
          await readGitRefs(repo, list.map(hash => this.gitRefs.get(hash)!.spec), async (index, chunk) => {
            if (at !== index) begin(index);
            digest.update(chunk);
            if (!handle && size + chunk.length > materializeInMemory) {
              handle = await open(temporary, 'wx');
              for (const part of chunks) await handle.write(part);
              chunks = [];
            }
            if (handle) await handle.write(chunk); else chunks.push(chunk);
            size += chunk.length;
          }, async (index, found) => {
            const hash = list[index]!;
            if (found && at !== index) begin(index);
            const streamed = handle;
            handle = undefined;
            await streamed?.close();
            if (!found || digest.digest('hex') !== hash) { lost.add(hash); return; }
            const task = publish(hash, temporary, streamed ? undefined : Buffer.concat(chunks));
            writing.add(task); void task.finally(() => writing.delete(task));
            if (writing.size >= 8) await Promise.race(writing);
          });
          await Promise.all(writing);
        } catch {
          await Promise.allSettled(writing);
          for (const hash of list) if (!await this.hasBlob(hash)) lost.add(hash);
        }
        finally {
          await handle?.close().catch(() => undefined);
          await Promise.allSettled(writing);
          for (const file of temporaries) await unlink(file).catch(() => undefined);
        }
        // Failing to write snapshot storage is not Git losing content.
        if (failure) throw failure;
      }
    });
    return lost;
  }
  private async ensureBlob(hash: string) {
    if ((await this.materialize([hash])).size) throw new Error('Snapshot content is no longer available in Git. It may have been removed by history rewriting and garbage collection.');
  }

  /** The ref spec under which `oid` rebuilds the stored blob exactly, if any. */
  async gitRefForBlob(hash: string, oid: string): Promise<string | undefined> {
    assertHash(hash);
    const result = await gitRefOfFile(path.join(this.directory, 'blobs', hash), oid);
    if (result.hash !== hash) throw new Error('Snapshot blob is corrupt.');
    return result.ref;
  }

  async readBlob(hash: string): Promise<Buffer> {
    assertHash(hash);
    await this.ensureBlob(hash);
    const bytes = await readFile(path.join(this.directory, 'blobs', hash));
    if (hashBytes(bytes) !== hash) throw new Error('Snapshot blob is corrupt.');
    return bytes;
  }

  /** Review snapshots can exceed the demo quota; stream large files to disk. */
  async putFileBlob(file: string, signal?: AbortSignal): Promise<string> {
    return withStorageLock(this.lockDirectory, () => this.putFileBlobUnlocked(file, signal));
  }
  private async hasBlob(hash: string): Promise<boolean> {
    try { return (await lstat(path.join(this.directory, 'blobs', hash))).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private async putFileBlobUnlocked(file: string, signal?: AbortSignal): Promise<string> {
    const directory = path.join(this.directory, 'blobs');
    await mkdir(directory, { recursive: true });
    // Reading is far cheaper than writing a large temporary copy that an existing blob makes redundant.
    const probe = await streamFile(file, { signal });
    if (await this.hasBlob(probe.hash)) { await this.inspectBlob(probe.hash); return probe.hash; }
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      const { hash } = await streamFile(file, { target: temporary, signal });
      if (hash !== probe.hash) throw new Error(`File changed while preparing review: ${file}`);
      await link(temporary, path.join(directory, hash)).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.inspectBlob(hash); // Verify existing bytes without loading a large blob.
      });
      return hash;
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  async inspectBlob(hash: string): Promise<{ size: number; binary: boolean; text?: string; legacy?: boolean }> {
    assertHash(hash);
    await this.ensureBlob(hash);
    const chunks: Buffer[] = []; let length = 0, binary = false, utf16 = false;
    let decoder: TextDecoder | undefined;
    const result = await streamFile(path.join(this.directory, 'blobs', hash), { expectedHash: hash, chunk(bytes) {
      if (!decoder) {
        utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
        decoder = new TextDecoder(utf16 ? (bytes[0] === 0xff ? 'utf-16le' : 'utf-16be') : 'utf-8', { fatal: true, ignoreBOM: !utf16 });
      }
      length += bytes.length;
      if (length <= 512 * 1024) chunks.push(bytes); else chunks.length = 0;
      if (!binary) {
        if (!utf16 && bytes.includes(0)) binary = true;
        else try { decoder.decode(bytes, { stream: true }); } catch { binary = true; }
      }
    } });
    if (!binary) try { decoder?.decode(); } catch { binary = true; }
    if (binary && !utf16 && length <= 512 * 1024) {
      const text = decodeLegacyText(Buffer.concat(chunks));
      if (text !== undefined) return { size: result.size, binary: false, text, legacy: true };
    }
    return { size: result.size, binary, text: !binary && length <= 512 * 1024 ? decodeText(Buffer.concat(chunks)) : undefined };
  }

  async copyBlob(hash: string, target: string): Promise<void> {
    assertHash(hash);
    await this.ensureBlob(hash);
    await streamFile(path.join(this.directory, 'blobs', hash), { target, expectedHash: hash });
  }

  async capture(root: string): Promise<Snapshot> {
    return withStorageLock(this.lockDirectory, () => this.captureUnlocked(root));
  }
  private async captureUnlocked(root: string): Promise<Snapshot> {
    const files: Manifest = Object.create(null) as Manifest;
    const rootPath = await realpath(root);
    let bytes = 0;
    let count = 0;
    const scan = async (folder: string, prefix: string) => {
      const entries = await readdir(folder, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (['.git', 'node_modules'].includes(entry.name)) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        assertPath(relative);
        const full = path.join(folder, entry.name);
        const info = await lstat(full);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error(`Linked file is not supported: ${relative}`);
        const resolved = await realpath(full);
        const within = path.relative(rootPath, resolved);
        if (path.isAbsolute(within) || within === '..' || within.startsWith(`..${path.sep}`)) throw new Error('File escapes snapshot root.');
        if (info.isDirectory()) await scan(full, relative);
        else if (info.isFile()) {
          if (++count > 1000 || (bytes += info.size) > this.maxBytes) throw new Error('Snapshot exceeds the file or size limit.');
          const content = await readFile(full);
          if (content.length !== info.size) throw new Error(`File changed during snapshot: ${relative}`);
          files[relative] = await this.putBlob(content);
        } else throw new Error(`Unsupported file: ${relative}`);
      }
    };
    await scan(rootPath, '');
    const snapshot: Snapshot = { id: randomUUID(), files };
    await this.saveJSON(path.join(this.directory, 'snapshots', `${snapshot.id}.json`), snapshot);
    return snapshot;
  }

  private async storedManifest(id: string): Promise<StoredManifest> {
    assertId(id);
    const file = path.join(this.directory, 'snapshots', `${id}.json`), info = await lstat(file);
    const cached = this.manifests.get(id);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.value;
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value.id !== id || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new Error('Invalid snapshot manifest.');
    const files: Manifest = Object.create(null);
    for (const [name, hash] of Object.entries(value.files)) { assertPath(name); if (typeof hash !== 'string') throw new Error('Invalid blob hash.'); assertHash(hash); files[name] = hash; }
    if (value.base !== undefined) { if (typeof value.base !== 'string' || value.base === id) throw new Error('Invalid snapshot manifest.'); assertId(value.base); }
    if (value.removed !== undefined && (!value.base || !Array.isArray(value.removed) || value.removed.some((name: unknown) => typeof name !== 'string'))) throw new Error('Invalid snapshot manifest.');
    for (const name of value.removed ?? []) assertPath(name);
    const refs: Record<string, string> = Object.create(null);
    if (value.git !== undefined) {
      if (!value.git || typeof value.git.repo !== 'string' || !path.isAbsolute(value.git.repo) || !value.git.refs || typeof value.git.refs !== 'object' || Array.isArray(value.git.refs)) throw new Error('Invalid snapshot Git reference.');
      for (const [hash, spec] of Object.entries(value.git.refs)) {
        assertHash(hash); if (typeof spec !== 'string' || !gitRefPattern.test(spec)) throw new Error('Invalid snapshot Git reference.');
        refs[hash] = spec; this.gitRefs.set(hash, { repo: value.git.repo, spec });
      }
    }
    const stored: StoredManifest = { id, files, base: value.base, removed: value.removed, refs, repo: value.git?.repo };
    this.manifests.set(id, { size: info.size, mtimeMs: info.mtimeMs, value: stored });
    // A few recent manifests cover the baseline, the active turn and a checkpoint preview.
    while (this.manifests.size > 8) this.manifests.delete(this.manifests.keys().next().value!);
    return stored;
  }

  async snapshot(id: string): Promise<Snapshot> {
    const stored = await this.storedManifest(id);
    if (!stored.base) return { id, files: { ...stored.files }, refs: { ...stored.refs }, ...(stored.repo ? { repo: stored.repo } : {}) };
    const base = await this.storedManifest(stored.base);
    if (base.base) throw new Error('Invalid snapshot manifest.');
    const files: Manifest = Object.assign(Object.create(null), base.files);
    for (const name of stored.removed ?? []) delete files[name];
    Object.assign(files, stored.files);
    const repo = stored.repo ?? base.repo;
    return { id, files, base: base.id, refs: { ...base.refs, ...stored.refs }, ...(repo ? { repo } : {}) };
  }

  /**
   * Store a complete manifest. With a stored `previous`, only the difference from its complete base is written while
   * that stays small. `found` names content Git can rebuild in `repo`; `previous`'s references carry over, so content no
   * scan copied stays Git-backed. Callers hold the storage lock.
   */
  async saveSnapshot(files: Manifest, previous?: Partial<Snapshot>, found: Record<string, string> = {}, repo = previous?.repo): Promise<Snapshot> {
    const known: Record<string, string> = { ...previous?.refs, ...found };
    const pick = (hashes: Iterable<string>, skip: Record<string, string> = {}) => {
      const refs: Record<string, string> = Object.create(null);
      for (const hash of hashes) if (Object.hasOwn(known, hash) && !Object.hasOwn(skip, hash)) refs[hash] = known[hash]!;
      return refs;
    };
    const baseId = previous?.id ? previous.base ?? previous.id : undefined;
    const base = baseId ? await this.storedManifest(baseId).catch(() => undefined) : undefined;
    const id = randomUUID();
    let stored: StoredManifest | undefined;
    if (base && !base.base) {
      const delta: Manifest = Object.create(null), removed: string[] = [];
      for (const [name, hash] of Object.entries(files)) if (base.files[name] !== hash) delta[name] = hash;
      for (const name of Object.keys(base.files)) if (!Object.hasOwn(files, name)) removed.push(name);
      if (Object.keys(delta).length + removed.length <= Math.max(deltaMinimum, Object.keys(base.files).length * deltaShare)) {
        stored = { id, files: delta, base: base.id, removed: removed.length ? removed : undefined, refs: pick(Object.values(delta), base.refs), repo: repo ?? base.repo };
      }
    }
    stored ??= { id, files: Object.assign(Object.create(null), files), refs: pick(Object.values(files)), repo };
    if (Object.keys(stored.refs).length && !stored.repo) throw new Error('Git-backed snapshot content needs its repository.');
    const directory = path.join(this.directory, 'snapshots');
    await mkdir(directory, { recursive: true });
    const json = { id, ...(stored.base ? { base: stored.base } : {}), files: stored.files, ...(stored.removed ? { removed: stored.removed } : {}), ...(stored.repo ? { git: { repo: stored.repo, refs: stored.refs } } : {}) };
    const file = path.join(directory, `${id}.json`);
    await writeFile(file, JSON.stringify(json), { flag: 'wx' });
    if (stored.repo) for (const [hash, spec] of Object.entries(stored.refs)) this.gitRefs.set(hash, { repo: stored.repo, spec });
    // The written manifest is already parsed; later reads only confirm the file is still there.
    const info = await lstat(file);
    this.manifests.set(id, { size: info.size, mtimeMs: info.mtimeMs, value: stored });
    while (this.manifests.size > 8) this.manifests.delete(this.manifests.keys().next().value!);
    return this.snapshot(id);
  }

  async readSnapshotFile(snapshotId: string, name: string): Promise<Buffer> {
    assertPath(name);
    const snapshot = await this.snapshot(snapshotId);
    const hash = Object.hasOwn(snapshot.files, name) ? snapshot.files[name] : undefined;
    if (!hash) throw new Error('File is not in this snapshot.');
    return this.readBlob(hash);
  }

  async changes(beforeId: string, afterId: string): Promise<FileChange[]> {
    const [before, after] = await Promise.all([this.snapshot(beforeId), this.snapshot(afterId)]);
    const names = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
    const changes: FileChange[] = [];
    for (const name of names) {
      const original = Object.hasOwn(before.files, name) ? before.files[name] : undefined;
      const modified = Object.hasOwn(after.files, name) ? after.files[name] : undefined;
      if (original === modified) continue;
      const contents = await Promise.all([original, modified].filter((h): h is string => !!h).map(h => this.readBlob(h)));
      changes.push({ path: name, before: original, after: modified,
        kind: !original ? 'added' : !modified ? 'deleted' : 'modified',
        binary: contents.some(content => decodeText(content) === undefined) });
    }
    return changes;
  }

  async saveSession(session: Session) {
    this.validateSession(session);
    await withStorageLock(this.lockDirectory, () => this.saveJSON(path.join(this.directory, 'sessions', `${session.id}.json`), session));
  }

  private validateSession(session: Session) {
    assertId(session.id);
    if (session.version !== 1 || session.source !== 'demo' || typeof session.title !== 'string' || !Array.isArray(session.steps)) throw new Error('Unsupported session schema.');
    if (!['running', 'completed', 'failed', 'interrupted'].includes(session.status)) throw new Error('Invalid session status.');
    assertId(session.baseline);
    for (const step of session.steps) {
      assertId(step.id); assertId(step.before);
      if (step.after) assertId(step.after);
      if (typeof step.title !== 'string' || typeof step.output !== 'string' || !Array.isArray(step.changes) || !['running', 'completed', 'failed', 'interrupted'].includes(step.status)) throw new Error('Invalid step schema.');
      for (const change of step.changes) {
        assertPath(change.path);
        if (change.before) assertHash(change.before);
        if (change.after) assertHash(change.after);
      }
    }
  }

  async sessions(): Promise<Session[]> {
    const directory = path.join(this.directory, 'sessions');
    await mkdir(directory, { recursive: true });
    const result: Session[] = [];
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.json')) continue;
      const session = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as Session;
      this.validateSession(session);
      if (file !== `${session.id}.json`) throw new Error('Session file identity mismatch.');
      // A process cannot still be writing a local demo after its extension host exits.
      if (session.status === 'running') {
        session.status = 'interrupted';
        for (const step of session.steps) if (step.status === 'running') {
          step.status = 'interrupted';
          step.output = 'Interrupted during reload. No complete after-snapshot was captured.';
        }
        await this.saveSession(session);
      }
      result.push(session);
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
