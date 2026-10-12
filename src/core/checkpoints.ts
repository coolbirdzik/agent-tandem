import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ConversationContent } from '../providers/conversations';
import type { ReviewFile } from './review';
import { withStorageLock } from './storage-lock';

export interface MessageCheckpoint { id: string; messageId: string; createdAt: number }
export interface CheckpointPreview { id: string; token: string; files: ReviewFile[]; createdAt: number; undo: boolean }
interface SavedCheckpoint { id: string; key: string; prefix: string[]; snapshot: string; createdAt: number; undo?: boolean; title?: string }
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const uuid = /^[a-f0-9-]{36}$/;

/** Native history replaces message IDs on reload. Match the exact user prefix,
 * including its ordinal, rather than IDs or a search for duplicate text. */
export class CheckpointStore {
  constructor(readonly directory: string) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    return withStorageLock(path.dirname(this.directory), operation);
  }
  private filename(project: string) {
    const root = path.resolve(project); return path.join(this.directory, `${digest(process.platform === 'win32' ? root.toLowerCase() : root)}.json`);
  }
  private async load(project: string): Promise<SavedCheckpoint[]> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.filename(project), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (!Array.isArray(value)) throw new Error('Invalid checkpoint history.');
    for (const entry of value) {
      if (!entry || !uuid.test(entry.id) || !uuid.test(entry.snapshot) || typeof entry.key !== 'string' || !Array.isArray(entry.prefix) || !entry.prefix.every((hash: unknown) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) || !Number.isFinite(entry.createdAt) || (entry.undo !== undefined && typeof entry.undo !== 'boolean')) throw new Error('Invalid checkpoint record.');
    }
    return value;
  }
  private async save(project: string, records: SavedCheckpoint[]) {
    await mkdir(this.directory, { recursive: true });
    const file = this.filename(project), temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(records), { flag: 'wx' }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  record(project: string, key: string, texts: string[], snapshot: string, sourceKey?: string, title?: string) { return this.serial(async () => {
    if (!uuid.test(snapshot) || !texts.length) throw new Error('Invalid message checkpoint.');
    const records = await this.load(project), prefix = texts.map(digest);
    if (sourceKey && sourceKey !== key) {
      for (const entry of records.filter(entry => !entry.undo && entry.key === sourceKey && entry.prefix.length < prefix.length && entry.prefix.every((hash, i) => hash === prefix[i]))) {
        records.push({ ...entry, id: randomUUID(), key });
      }
    }
    const entry: SavedCheckpoint = { id: randomUUID(), key, prefix, snapshot, createdAt: Date.now(), ...(title ? { title } : {}) };
    records.push(entry); await this.save(project, records); return entry.id;
  }); }
  bind(project: string, draftKey: string, key: string) { return this.serial(async () => {
    const records = await this.load(project);
    for (const entry of records) if (entry.key === draftKey && !entry.undo) entry.key = key;
    await this.save(project, records);
  }); }
  list(project: string, content: ConversationContent) { return this.serial(async (): Promise<MessageCheckpoint[]> => {
    const users = content.messages.filter(message => message.role === 'user'), hashes = users.map(message => digest(message.text));
    return (await this.load(project)).filter(entry => !entry.undo && entry.key === content.conversation.key && entry.prefix.length > 0 && entry.prefix.length <= hashes.length && entry.prefix.every((hash, i) => hash === hashes[i]))
      .map(entry => ({ id: entry.id, messageId: users[entry.prefix.length - 1]!.id, createdAt: entry.createdAt }));
  }); }
  get(project: string, id: string) { return this.serial(async () => {
    const entry = (await this.load(project)).find(entry => entry.id === id);
    if (!entry) throw new Error('This checkpoint is no longer available.');
    return entry;
  }); }
  saveUndo(project: string, snapshot: string) { return this.serial(async () => {
    if (!uuid.test(snapshot)) throw new Error('Invalid restore backup.');
    const records = await this.load(project);
    const entry: SavedCheckpoint = { id: randomUUID(), snapshot, key: '', prefix: [], createdAt: Date.now(), undo: true };
    // Keep the last restore backup. Message checkpoints remain indefinitely available.
    await this.save(project, [...records.filter(record => !record.undo), entry]); return { id: entry.id, createdAt: entry.createdAt };
  }); }
  undo(project: string) { return this.serial(async () => {
    const entry = (await this.load(project)).find(entry => entry.undo);
    return entry ? { id: entry.id, createdAt: entry.createdAt } : undefined;
  }); }
}
