import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ConversationContent } from '../providers/conversations';
import type { ReviewFile } from './review';
import { withStorageLock } from './storage-lock';

export interface MessageCheckpoint { id: string; messageId: string; createdAt: number }
export interface CheckpointPreview { id: string; token: string; files: ReviewFile[]; createdAt: number; undo: boolean }
interface SavedCheckpoint { id: string; key: string; prefix: string[]; snapshot: string; createdAt: number; undo?: boolean; title?: string; end?: number }
/**
 * Change tracking timeline: workspace states saved by tracking, each recorded once its capture finished. A message sent
 * outside AgentTandem restores to the latest state saved at or before it. `end` closes a point when tracking stopped.
 */
export const TIMELINE_KEY = 'tracking:timeline';
export interface TimelinePoint { id: string; snapshot: string; createdAt: number; end?: number }
/** Points whose successor arrived this recently stay: a message sent just before may not be in the native index yet. */
export const TIMELINE_SETTLE_MS = 10 * 60 * 1000;
const timelineTitle = 'Change tracking history';
const isPoint = (entry: SavedCheckpoint) => !entry.undo && entry.key === TIMELINE_KEY;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const uuid = /^[a-f0-9-]{36}$/;

/** Native history replaces message IDs on reload. Match the exact user prefix,
 * including its ordinal, rather than IDs or a search for duplicate text. */
function timeline(records: SavedCheckpoint[]): TimelinePoint[] {
  return records.filter(isPoint).map(({ id, snapshot, createdAt, end }) => ({ id, snapshot, createdAt, ...(end !== undefined ? { end } : {}) })).sort((a, b) => a.createdAt - b.createdAt);
}
/** The latest state saved at or before `at`, unless tracking stopped before `at`. */
function pointAt(points: TimelinePoint[], at: number): TimelinePoint | undefined {
  let found: TimelinePoint | undefined;
  for (const point of points) { if (point.createdAt > at) break; found = point; }
  return found && (found.end === undefined || at < found.end) ? found : undefined;
}

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
      if (!entry || !uuid.test(entry.id) || !uuid.test(entry.snapshot) || typeof entry.key !== 'string' || !Array.isArray(entry.prefix) || !entry.prefix.every((hash: unknown) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) || !Number.isFinite(entry.createdAt) || (entry.undo !== undefined && typeof entry.undo !== 'boolean') || (entry.end !== undefined && !Number.isFinite(entry.end))) throw new Error('Invalid checkpoint record.');
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
  /** Checkpoints saved when a message was sent from AgentTandem, then tracking states for the other messages. */
  list(project: string, content: ConversationContent) { return this.serial(async (): Promise<MessageCheckpoint[]> => {
    const users = content.messages.filter(message => message.role === 'user'), hashes = users.map(message => digest(message.text));
    const records = await this.load(project);
    const result = records.filter(entry => !entry.undo && entry.key === content.conversation.key && entry.prefix.length > 0 && entry.prefix.length <= hashes.length && entry.prefix.every((hash, i) => hash === hashes[i]))
      .map(entry => ({ id: entry.id, messageId: users[entry.prefix.length - 1]!.id, createdAt: entry.createdAt }));
    const own = new Set(result.map(entry => entry.messageId)), points = timeline(records);
    for (const message of users) {
      const at = Date.parse(message.timestamp ?? '');
      if (own.has(message.id) || !Number.isFinite(at)) continue;
      const point = pointAt(points, at);
      if (point) result.push({ id: point.id, messageId: message.id, createdAt: point.createdAt });
    }
    return result;
  }); }
  /** Record the workspace state tracking just saved, or close the timeline when `snapshot` is undefined (tracking stopped). */
  track(project: string, snapshot: string | undefined, at = Date.now()) { return this.serial(async () => {
    if (snapshot !== undefined && !uuid.test(snapshot)) throw new Error('Invalid tracking state.');
    const records = await this.load(project), last = timeline(records).at(-1);
    if (snapshot === undefined) {
      if (!last || last.end !== undefined) return;
      records.find(entry => entry.id === last.id)!.end = at;
    } else {
      if (last?.snapshot === snapshot && last.end === undefined) return;
      records.push({ id: randomUUID(), key: TIMELINE_KEY, prefix: [], snapshot, createdAt: at, title: timelineTitle });
    }
    await this.save(project, records);
  }); }
  timeline(project: string) { return this.serial(async () => timeline(await this.load(project))); }
  /**
   * Keep only tracking states a message can restore to: for each time in `messages`, the latest state at or before it.
   * The newest state, states whose successor is still settling, and states decided before `since` stay. Returns how
   * many were removed; their snapshots then become ordinary unused data for cleanup.
   */
  prune(project: string, messages: number[], now = Date.now(), since = 0) { return this.serial(async () => {
    const records = await this.load(project), points = timeline(records), drop = new Set<string>();
    points.forEach((point, index) => {
      const next = points[index + 1];
      if (!next) return;
      const until = Math.min(next.createdAt, point.end ?? Infinity);
      if (next.createdAt <= since || next.createdAt > now - TIMELINE_SETTLE_MS) return;
      if (!messages.some(time => time >= point.createdAt && time < until)) drop.add(point.id);
    });
    if (drop.size) await this.save(project, records.filter(entry => !drop.has(entry.id)));
    return drop.size;
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
    // Keep the last restore backup. Message checkpoints stay until the user deletes them or the storage limit removes the oldest.
    await this.save(project, [...records.filter(record => !record.undo), entry]); return { id: entry.id, createdAt: entry.createdAt };
  }); }
  undo(project: string) { return this.serial(async () => {
    const entry = (await this.load(project)).find(entry => entry.undo);
    return entry ? { id: entry.id, createdAt: entry.createdAt } : undefined;
  }); }
}
