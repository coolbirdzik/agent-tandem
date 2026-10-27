import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { FileChange, Manifest, Session, Snapshot } from './types';
import { streamFile } from './blob';
import { withStorageLock } from './storage-lock';

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

  async readBlob(hash: string): Promise<Buffer> {
    assertHash(hash);
    const bytes = await readFile(path.join(this.directory, 'blobs', hash));
    if (hashBytes(bytes) !== hash) throw new Error('Snapshot blob is corrupt.');
    return bytes;
  }

  /** Review snapshots can exceed the demo quota; stream large files to disk. */
  async putFileBlob(file: string, signal?: AbortSignal): Promise<string> {
    return withStorageLock(this.lockDirectory, () => this.putFileBlobUnlocked(file, signal));
  }
  private async putFileBlobUnlocked(file: string, signal?: AbortSignal): Promise<string> {
    const directory = path.join(this.directory, 'blobs');
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      const { hash } = await streamFile(file, { target: temporary, signal });
      await link(temporary, path.join(directory, hash)).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.inspectBlob(hash); // Verify existing bytes without loading a large blob.
      });
      return hash;
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  async inspectBlob(hash: string): Promise<{ size: number; binary: boolean; text?: string; legacy?: boolean }> {
    assertHash(hash);
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

  async snapshot(id: string): Promise<Snapshot> {
    assertId(id);
    const value = JSON.parse(await readFile(path.join(this.directory, 'snapshots', `${id}.json`), 'utf8')) as Snapshot;
    if (value.id !== id || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new Error('Invalid snapshot manifest.');
    for (const [name, hash] of Object.entries(value.files)) { assertPath(name); assertHash(hash); }
    return value;
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
