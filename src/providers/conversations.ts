import { createReadStream } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { claudeUserText, isRuntimeContextOnly } from './history-context';
import { codexHistoryUsage, claudeHistoryUsage, type ContextUsage } from './context-usage';
import { chatAttachments, type ChatAttachment } from '../core/attachments';
import { conversationEdits, type ConversationEdit } from '../core/review-conversations';

export type ConversationProvider = 'Codex' | 'Claude';
export interface Conversation {
  key: string; id: string; provider: ConversationProvider; title: string;
  cwd: string; updatedAt: number; revision: string;
}
export interface ConversationMessage {
  id: string; role: 'user' | 'assistant' | 'tool'; text: string;
  timestamp?: string; toolName?: string; toolCallId?: string;
  attachments?: ChatAttachment[];
}
export interface ConversationContent { conversation: Conversation; messages: ConversationMessage[]; notice?: string; usage?: ContextUsage }
export interface ConversationIndex { conversations: Conversation[]; errors: string[] }
export interface ClaudeHistoryAPI {
  deleteSession?(id: string): Promise<void>;
  listSessions(options: { dir?: string; includeWorktrees: boolean }): Promise<Array<{ sessionId: string; summary: string; cwd?: string; lastModified: number; fileSize?: number }>>;
  getSessionMessages(id: string, options: { dir: string }): Promise<Array<{ uuid: string; type: string; message: unknown }>>;
}

/** Match full directory boundaries, including Windows paths read on other hosts. */
export function belongsToProject(cwd: string, project: string): boolean {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(project);
  const normalize = (value: string) => {
    const clean = value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
    return windows ? path.win32.resolve(clean).replace(/[\\/]+$/, '').toLowerCase() : path.posix.resolve(clean).replace(/\/+$/, '');
  };
  const root = normalize(project), candidate = normalize(cwd);
  return candidate === root || candidate.startsWith(`${root}${windows ? '\\' : '/'}`);
}
function object(value: unknown): Record<string, any> { return value && typeof value === 'object' ? value as Record<string, any> : {}; }
/** Keep AgentTandem's old test runs out of their parent project's chat list.
 * Opening a test workspace itself still shows that workspace's conversations.
 * Match the run directory, never the prompt text (a user can paste MODEL_OK).
 */
export function projectHistoryAllowed(cwd: string, project: string): boolean {
  if (!belongsToProject(cwd, project)) return false;
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(project);
  const relative = (windows ? path.win32 : path.posix).relative(project.replace(/^\\\\\?\\/, ''), cwd.replace(/^\\\\\?\\/, '')).replace(/\\/g, '/');
  const [folder, run] = relative.split('/');
  return folder?.toLowerCase() !== '.test-runtime' || !(run?.toLowerCase() === 'workspace' || /^(models-live|stop-live|edit-live|access-live|review-live|cli-manager|context-history|checkpoints|attachments-live)-\d+$/i.test(run ?? ''));
}
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(block => {
    const b = object(block);
    if (typeof b.text === 'string') return b.text;
    if (b.type === 'image' || b.type === 'input_image' || b.type === 'localImage') return '[Image]';
    if (b.type === 'document') return '[File]';
    if (b.type === 'audio' || b.type === 'localAudio') return '[Audio]';
    if (b.type === 'mention') return `[File: ${b.name ?? 'Attachment'}]`;
    return '';
  }).filter(Boolean).join('\n');
}
function printable(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2); }
function contentAttachments(blocks: unknown): ChatAttachment[] | undefined {
  if (!Array.isArray(blocks)) return;
  const result: ChatAttachment[] = [];
  for (const block of blocks) {
    const b = object(block), source = object(b.source);
    let item: ChatAttachment | undefined;
    if ((b.type === 'image' || b.type === 'document') && source.type === 'base64') item = { name: typeof b.title === 'string' ? b.title : b.type === 'image' ? `Image ${result.length + 1}` : `File ${result.length + 1}`, mimeType: source.media_type, data: source.data };
    else if (b.type === 'input_image' || b.type === 'image') {
      const url = b.image_url ?? b.url, match = typeof url === 'string' ? /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/s.exec(url) : undefined;
      if (match) item = { name: `Image ${result.length + 1}`, mimeType: match[1]!, data: match[2]! };
    }
    if (item) { try { result.push(...chatAttachments([item])); } catch { /* Keep the marker when native data exceeds UI limits. */ } }
  }
  try { return result.length ? chatAttachments(result) : undefined; } catch { return undefined; }
}

export function claudeMessages(records: Array<{ uuid: string; type: string; message: unknown }>): ConversationMessage[] {
  return records.flatMap(record => {
    const msg = object(record.message), blocks = msg.content;
    const result: ConversationMessage[] = [];
    const raw = contentText(blocks), text = record.type === 'user' ? claudeUserText(raw) : raw;
    if (text && (record.type === 'user' || record.type === 'assistant')) {
      const attachments = record.type === 'user' ? contentAttachments(blocks) : undefined;
      result.push({ id: record.uuid, role: record.type, text, ...(attachments ? { attachments } : {}) });
    }
    if (Array.isArray(blocks)) blocks.forEach((value, index) => {
      const block = object(value);
      if (block.type === 'tool_use') result.push({ id: `${record.uuid}:${index}`, role: 'tool', toolName: String(block.name ?? 'Tool'), toolCallId: block.id, text: printable(block.input) });
      if (block.type === 'tool_result') result.push({ id: `${record.uuid}:${index}`, role: 'tool', toolName: 'Result', toolCallId: block.tool_use_id, text: contentText(block.content) || printable(block.content) });
    });
    return result;
  });
}

/** Rollouts are read-only compatibility data, never rewritten or resumed here. */
export function codexMessages(records: unknown[]): ConversationMessage[] {
  const hasUserEvents = records.some(value => { const r = object(value); return r.type === 'event_msg' && object(r.payload).type === 'user_message'; });
  const hasAssistantResponses = records.some(value => { const r = object(value), p = object(r.payload); return r.type === 'response_item' && p.type === 'message' && p.role === 'assistant'; });
  const result: ConversationMessage[] = [];
  const seen = new Set<string>();
  const responseImages = records.flatMap(value => {
    const r = object(value), p = object(r.payload);
    return r.type === 'response_item' && p.type === 'message' && p.role === 'user' && !isRuntimeContextOnly(contentText(p.content)) ? [contentAttachments(p.content)] : [];
  });
  let userEventIndex = 0;
  records.forEach((value, index) => {
    const r = object(value), p = object(r.payload);
    const id = String(p.id ?? p.client_id ?? `line-${index}`);
    let message: ConversationMessage | undefined;
    if (r.type === 'event_msg' && p.type === 'user_message') {
      const images = Array.isArray(p.images) ? p.images : [];
      const attachments = contentAttachments(images.map((url: unknown) => ({ type: 'image', url }))) ?? responseImages[userEventIndex]; userEventIndex++;
      message = { id, role: 'user', text: String(p.message ?? '') || (images.length || p.local_images?.length ? '[Image]' : ''), ...(attachments ? { attachments } : {}) };
    }
    if (r.type === 'event_msg' && p.type === 'agent_message' && !hasAssistantResponses) message = { id, role: 'assistant', text: String(p.message ?? '') };
    if (r.type === 'response_item') {
      if (p.type === 'message' && (p.role === 'assistant' || (p.role === 'user' && !hasUserEvents))) {
        const text = contentText(p.content);
        if (p.role !== 'user' || !isRuntimeContextOnly(text)) {
          const attachments = p.role === 'user' ? contentAttachments(p.content) : undefined;
          message = { id, role: p.role, text, ...(attachments ? { attachments } : {}) };
        }
      }
      if (p.type === 'function_call' || p.type === 'custom_tool_call') message = { id, role: 'tool', toolName: String(p.name ?? 'Tool'), toolCallId: p.call_id, text: printable(p.arguments ?? p.input) };
      if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') message = { id, role: 'tool', toolName: 'Result', toolCallId: p.call_id, text: printable(p.output) };
    }
    if (r.type === 'event_msg' && p.type === 'thread_rolled_back' && Number.isInteger(p.num_turns) && p.num_turns > 0) {
      for (let count = 0; count < p.num_turns; count++) {
        let lastUser = result.length - 1;
        while (lastUser >= 0 && result[lastUser]?.role !== 'user') lastUser--;
        if (lastUser < 0) break;
        result.splice(lastUser);
      }
    }
    if (message?.text && !seen.has(`${message.role}:${message.id}`)) {
      message.timestamp = typeof r.timestamp === 'string' ? r.timestamp : undefined;
      seen.add(`${message.role}:${message.id}`); result.push(message);
    }
  });
  return result;
}

async function rolloutFiles(directory: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const groups = await Promise.all(entries.map(async entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return rolloutFiles(file);
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [file] : [];
  }));
  return groups.flat(); // No symlinks followed.
}
async function firstRecord(file: string): Promise<Record<string, any>> {
  const handle = await open(file, 'r');
  try {
    const bytes = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, bytesRead).toString('utf8');
    const end = text.indexOf('\n');
    if (end < 0) throw new Error('Missing complete session metadata.');
    return object(JSON.parse(text.slice(0, end)));
  } finally { await handle.close(); }
}
async function readRecords(file: string): Promise<{ records: unknown[]; malformed: boolean }> {
  if ((await stat(file)).size > 128 * 1024 * 1024) throw new Error('Conversation exceeds the 128 MiB history reader limit.');
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const records: unknown[] = []; let malformed = false;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { malformed = true; } // An active writer can leave a partial final line.
    }
  } finally { lines.close(); stream.destroy(); }
  return { records, malformed };
}

async function codexTitle(file: string): Promise<string | undefined> {
  const stream = createReadStream(file, { encoding: 'utf8' }), lines = createInterface({ input: stream, crlfDelay: Infinity });
  let bytes = 0;
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line); if (bytes > 8 * 1024 * 1024) break;
      try {
        const record = object(JSON.parse(line)), payload = object(record.payload);
        const text = record.type === 'event_msg' && payload.type === 'user_message' ? payload.message : record.type === 'response_item' && payload.type === 'message' && payload.role === 'user' ? contentText(payload.content) : undefined;
        if (typeof text === 'string' && text.trim() && !isRuntimeContextOnly(text)) return text.replace(/\s+/g, ' ').slice(0, 140);
      } catch { /* An active transcript may end in a partial record. */ }
    }
  } finally { lines.close(); stream.destroy(); }
}

/** Read native titles/current cwd; transcript metadata can predate renames or project moves. */
export async function codexSessionMetadata(home: string): Promise<Map<string, { cwd?: string; title?: string; archived?: boolean }>> {
  const result = new Map<string, { cwd?: string; title?: string; archived?: boolean }>();
  try {
    const files = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (files[0]) {
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(path.join(home, files[0]), { readOnly: true });
      try {
        const columns = new Set(database.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
        if (columns.has('id') && columns.has('cwd') && columns.has('title')) {
          for (const row of database.prepare(`SELECT id, cwd, title${columns.has('archived') ? ', archived' : ''} FROM threads`).all()) {
            if (typeof row.id === 'string') result.set(row.id, { cwd: typeof row.cwd === 'string' ? row.cwd : undefined, title: typeof row.title === 'string' && row.title.trim() ? row.title : undefined, archived: row.archived === 1 });
          }
        }
      } finally { database.close(); }
    }
  } catch { /* Older Node/CLI versions use the append-only name index instead. */ }
  const nativeTitles = new Set([...result].filter(([, row]) => row.title).map(([id]) => id));
  try {
    const file = path.join(home, 'session_index.jsonl'); await stat(file);
    const stream = createReadStream(file, { encoding: 'utf8' }), lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        try {
          const row = object(JSON.parse(line));
          if (typeof row.id === 'string' && typeof row.thread_name === 'string' && row.thread_name.trim() && !nativeTitles.has(row.id)) result.set(row.id, { ...result.get(row.id), title: row.thread_name });
        } catch { /* Partial index writes are retried at the next sync. */ }
      }
    } finally { lines.close(); stream.destroy(); }
  } catch { /* No name index on old CLIs. */ }
  return result;
}

export class ProjectConversations {
  private metadata = new Map<string, { cwd: string; id: string }>();
  private codex = new Map<string, { file: string; conversation: Conversation }>();
  private claudeDirs = new Map<string, string>();
  private titles = new Map<string, string>();
  private codexErrors: string[] = [];
  private scope = new Map<string, string[]>();
  constructor(private claude: () => Promise<ClaudeHistoryAPI>, private codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), private claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) {}
  private editCache = new Map<string, { revision: string; edits: ConversationEdit[] }>();
  private claudeEditFiles = new Map<string, string>();
  private editIndexAt = 0;
  private editIndexJob?: Promise<void>;
  private async indexClaudeEdits() {
    if (this.editIndexJob) return this.editIndexJob;
    if (Date.now() - this.editIndexAt < 5000) return;
    this.editIndexJob = (async () => {
      const root = path.join(this.claudeHome, 'projects');
      let folders; try { folders = await readdir(root, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      const files = new Map<string, string>();
      for (const folder of folders) if (folder.isDirectory()) {
        for (const entry of await readdir(path.join(root, folder.name), { withFileTypes: true })) {
          if (entry.isFile() && /^[a-f0-9-]{36}\.jsonl$/i.test(entry.name)) files.set(entry.name.slice(0, -6), path.join(root, folder.name, entry.name));
        }
      }
      this.claudeEditFiles = files; this.editIndexAt = Date.now();
    })().finally(() => { this.editIndexJob = undefined; });
    return this.editIndexJob;
  }
  /** Raw local records retain edit timestamps omitted by the Claude history SDK. */
  async edits(conversation: Conversation, project: string): Promise<ConversationEdit[]> {
    if (!this.belongs(conversation.cwd, project)) throw new Error('Conversation does not belong to this workspace.');
    const cacheKey = `${project}:${conversation.key}`, cached = this.editCache.get(cacheKey);
    if (cached?.revision === conversation.revision) return cached.edits;
    let file: string | undefined, root: string;
    if (conversation.provider === 'Claude') {
      await this.indexClaudeEdits(); file = this.claudeEditFiles.get(conversation.id); root = path.join(this.claudeHome, 'projects');
    } else { file = this.codex.get(conversation.key)?.file; root = path.join(this.codexHome, 'sessions'); }
    if (!file) return [];
    if (!belongsToProject(await realpath(file), await realpath(root))) throw new Error('Edit history escaped the native session store.');
    const data = await readRecords(file);
    const edits = conversationEdits(data.records, conversation, conversation.cwd, project);
    if (!data.malformed) this.editCache.set(cacheKey, { revision: conversation.revision, edits });
    return edits;
  }

  async list(project: string): Promise<ConversationIndex> {
    let canonical = project; try { canonical = await realpath(project); } catch { /* Project may be temporarily unavailable. */ }
    this.scope.set(project, [project, canonical]);
    const results = await Promise.allSettled([this.listCodex(project), this.listClaude(project)]);
    const conversations: Conversation[] = [], errors: string[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') conversations.push(...result.value);
      else errors.push(`${index === 0 ? 'Codex' : 'Claude'} history: ${result.reason instanceof Error ? result.reason.message : 'Could not read history.'}`);
    });
    errors.push(...this.codexErrors);
    return { conversations: conversations.sort((a, b) => b.updatedAt - a.updatedAt), errors };
  }
  belongs(cwd: string, project: string) { return (this.scope.get(project) ?? [project]).some(root => belongsToProject(cwd, root)); }
  private allowed(cwd: string, project: string) { return (this.scope.get(project) ?? [project]).some(root => projectHistoryAllowed(cwd, root)); }
  private async allowedCanonical(cwd: string, project: string) {
    if (this.allowed(cwd, project)) return true;
    // Native metadata can use an 8.3 path or a different junction from the
    // selected workspace. Compare both canonical directories on a scope miss.
    let canonical: string;
    try { canonical = await realpath(cwd); } catch { return false; }
    if (!this.allowed(canonical, project)) return false;
    const roots = this.scope.get(project);
    if (roots && !roots.includes(cwd)) roots.push(cwd);
    return true;
  }
  private async listCodex(project: string): Promise<Conversation[]> {
    this.codexErrors = [];
    const native = await codexSessionMetadata(this.codexHome);
    const files = await rolloutFiles(path.join(this.codexHome, 'sessions'));
    const found = new Map<string, { file: string; conversation: Conversation }>();
    // Bound concurrent file handles for large session stores.
    for (let offset = 0; offset < files.length; offset += 24) await Promise.all(files.slice(offset, offset + 24).map(async file => {
      let metadata = this.metadata.get(file);
      if (!metadata) {
        try {
          const first = await firstRecord(file), payload = object(first.payload);
          if (first.type !== 'session_meta' || typeof payload.cwd !== 'string' || typeof payload.id !== 'string') return;
          metadata = { cwd: payload.cwd, id: payload.id }; this.metadata.set(file, metadata);
        } catch (error) {
          if (error instanceof SyntaxError || (error as Error).message === 'Missing complete session metadata.') return;
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.codexErrors.push(`Codex history: could not read ${path.basename(file)}. Other sessions remain available.`);
          return;
        }
      }
      const saved = native.get(metadata.id), cwd = saved?.cwd ?? metadata.cwd;
      if (saved?.archived || !await this.allowedCanonical(cwd, project)) return;
      try {
        const details = await stat(file), key = `Codex:${metadata.id}`;
        const revision = `${details.mtimeMs}:${details.size}`;
        if (!saved?.title && !this.titles.has(key)) this.titles.set(key, await codexTitle(file) || `Codex · ${metadata.id.slice(0, 8)}`);
        const title = saved?.title ?? this.titles.get(key)!;
        const conversation: Conversation = { key, id: metadata.id, cwd, provider: 'Codex', title, updatedAt: details.mtimeMs, revision: `${revision}:${title}` };
        const previous = found.get(key);
        if (!previous || previous.conversation.updatedAt < conversation.updatedAt) found.set(key, { file, conversation });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.codexErrors.push(`Codex history: could not index ${metadata.id.slice(0, 8)}. Other sessions remain available.`);
      }
    }));
    this.codex = found;
    return [...found.values()].map(value => value.conversation);
  }
  private async listClaude(project: string): Promise<Conversation[]> {
    const sdk = await this.claude();
    // Scoped discovery finds sessions without cwd metadata; global discovery adds nested roots.
    const results = await Promise.allSettled([sdk.listSessions({ dir: project, includeWorktrees: false }), sdk.listSessions({ includeWorktrees: false })]);
    if (results.every(result => result.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
    const sessions = new Map<string, { session: Awaited<ReturnType<ClaudeHistoryAPI['listSessions']>>[number]; dir: string }>();
    for (const [index, result] of results.entries()) if (result.status === 'fulfilled') for (const session of result.value) {
      const cwd = session.cwd ?? (index === 0 ? project : undefined);
      // Scoped lookup knows where the transcript was stored. A later cwd inside
      // the session must not redirect message lookup to another project bucket.
      if (cwd && await this.allowedCanonical(cwd, project) && !sessions.has(session.sessionId)) sessions.set(session.sessionId, { session: { ...session, cwd }, dir: index === 0 ? project : cwd });
    }
    this.claudeDirs.clear();
    return [...sessions.values()].map(({ session, dir }) => {
      const key = `Claude:${session.sessionId}`; this.claudeDirs.set(key, dir);
      return { key, id: session.sessionId, provider: 'Claude', title: session.summary || `Claude · ${session.sessionId.slice(0, 8)}`, cwd: session.cwd!, updatedAt: session.lastModified, revision: `${session.lastModified}:${session.fileSize ?? 0}:${session.summary}` };
    });
  }
  async read(conversation: Conversation, project: string): Promise<ConversationContent> {
    if (!this.belongs(conversation.cwd, project)) throw new Error('Conversation does not belong to the selected project.');
    if (conversation.provider === 'Claude') {
      const dir = this.claudeDirs.get(conversation.key);
      if (!dir) throw new Error('Refresh the project conversation list before opening this session.');
      const sdk = await this.claude();
      const records = await sdk.getSessionMessages(conversation.id, { dir });
      return { conversation, messages: claudeMessages(records), usage: claudeHistoryUsage(records) };
    }
    const entry = this.codex.get(conversation.key);
    if (!entry) throw new Error('Conversation is no longer available. Refresh the project.');
    const actual = await realpath(entry.file), store = await realpath(path.join(this.codexHome, 'sessions'));
    if (!belongsToProject(actual, store)) throw new Error('History path escaped the Codex session store.');
    const data = await readRecords(actual);
    return { conversation, messages: codexMessages(data.records), usage: codexHistoryUsage(data.records), notice: data.malformed ? 'An incomplete or invalid transcript record was skipped. Sync will retry when the file updates.' : undefined };
  }
}
