import { lstat, mkdir, readdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { codexSessionMetadata, type ConversationProvider } from '../providers/conversations';
import { transcriptPrefix } from '../providers/transcript-prefix';
import { transcriptMessageTime } from '../providers/transcript-message-time';
import { conversationFilter, conversationTime, matchesConversation, validCutoff } from './conversation-filter';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const grace = 10 * 60 * 1000;
export interface TranscriptFile { path: string; bytes: number; modified: number; changed: number; inode: number }
export interface CleanupConversation {
  key: string; id: string; provider: ConversationProvider; title: string; project: string;
  archived: boolean; updatedAt: number; lastMessageAt?: number; bytes: number; files: TranscriptFile[]; parent?: string; blocked?: string;
  /** Pre-session_meta Codex rollouts the CLI never indexed and cannot read, so thread/delete rejects them. */
  legacy?: true;
}
export interface ConversationCleanupPlan { token: string; createdAt: number; conversations: CleanupConversation[]; bytes: number }
/** A requested conversation left in place, with the reason shown to the user. */
export interface ConversationKept { key: string; title: string; reason: string }
export interface ConversationCleanupResult {
  removed: string[]; bytes: number; skipped: string[]; failures: string[];
  kept?: ConversationKept[]; titles?: Record<string, string>; cancelled?: boolean;
}
export interface DeletionProgress {
  deleting?: (done: number, total: number) => void;
  dates?: (dates: { done: number; total: number }) => void;
  confirm?: (plan: ConversationCleanupPlan) => Promise<boolean>;
  onError?: (row: CleanupConversation, reason: string) => Promise<'skip' | 'skipAll' | 'cancel'>;
  signal?: AbortSignal;
}
export interface ConversationCleanupState {
  status: 'idle' | 'loading' | 'ready' | 'cleaning' | 'error'; roots: Record<ConversationProvider, string>;
  conversations?: CleanupConversation[]; errors?: string[]; error?: string;
  plan?: ConversationCleanupPlan; result?: ConversationCleanupResult; done?: number; total?: number;
  /** Compressed transcripts whose last message is still being read; their rows use the file time meanwhile. */
  dates?: { done: number; total: number };
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const ordered = (rows: CleanupConversation[]) => rows.sort((a, b) => conversationTime(a) - conversationTime(b) || a.key.localeCompare(b.key));
const fingerprint = (row: CleanupConversation) => createHash('sha256').update(JSON.stringify([row.key, row.archived, row.parent, row.legacy, row.files])).digest('hex');

/** Local transcript inventory. Only the provider's own deletion API mutates its store, except unindexed legacy Codex rollouts. */
export class ConversationCleanup {
  readonly roots: Record<ConversationProvider, string>;
  private plan?: ConversationCleanupPlan;
  private headers = new Map<string, { stamp: string; records: any[] }>();
  private messageTimes = new Map<string, { stamp: string; time?: number }>();
  private pending = new Map<string, TranscriptFile>();
  private compressed = new Set<string>();
  private loaded?: Promise<void>;
  constructor(private remove: (conversation: CleanupConversation) => Promise<void>, private protectedKeys: () => Set<string> = () => new Set(),
    homes: Partial<Record<ConversationProvider, string>> = {}, private cacheFile?: string) {
    this.roots = { Codex: homes.Codex ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), Claude: homes.Claude ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude') };
  }
  cancel() { this.plan = undefined; }
  private async lastMessage(file: TranscriptFile, deferred?: Map<string, TranscriptFile>, signal?: AbortSignal) {
    const stamp = JSON.stringify(file), cached = this.messageTimes.get(file.path);
    if (cached?.stamp === stamp) return;
    // Compressed rollouts are decoded in full; resolveDates() reads them after the list is shown.
    if (deferred && file.path.endsWith('.zst')) { deferred.set(file.path, file); return; }
    const time = await transcriptMessageTime(file.path, signal);
    if (this.messageTimes.size >= 20000) this.messageTimes.clear();
    this.messageTimes.set(file.path, { stamp, time });
  }
  /** Undefined until every file is read, so callers fall back to the newer file time, never an older partial date. */
  private knownMessageAt(row: CleanupConversation) {
    let latest = 0;
    for (const file of row.files) {
      const cached = this.messageTimes.get(file.path);
      if (cached?.stamp !== JSON.stringify(file)) return;
      latest = Math.max(latest, cached.time ?? 0);
    }
    return latest || undefined;
  }
  private load() {
    return this.loaded ??= (async () => {
      if (!this.cacheFile) return;
      try {
        const saved = JSON.parse(await readFile(this.cacheFile, 'utf8'));
        if (saved?.version !== 1 || !Array.isArray(saved.entries)) return;
        for (const entry of saved.entries) {
          if (!Array.isArray(entry)) continue;
          const [file, stamp, time] = entry;
          if (typeof file === 'string' && typeof stamp === 'string' && (time === null || Number.isFinite(time)) && !this.messageTimes.has(file)) this.messageTimes.set(file, { stamp, time: time ?? undefined });
        }
      } catch { /* Missing or partial cache: dates are read again. */ }
    })();
  }
  private async save() {
    if (!this.cacheFile) return;
    // Only compressed dates are slow to rebuild; plain transcripts are read from their tail.
    const entries = [...this.messageTimes].filter(([file]) => this.compressed.has(file)).map(([file, { stamp, time }]) => [file, stamp, time ?? null]);
    await mkdir(path.dirname(this.cacheFile), { recursive: true });
    await writeFile(this.cacheFile, JSON.stringify({ version: 1, entries }));
  }
  private async checked(file: string, root: string): Promise<TranscriptFile> {
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Path outside transcript store: ${file}`);
    // Check every component, including the configured home; never traverse junctions.
    for (let current = file; ; current = path.dirname(current)) {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Linked transcript path: ${current}`);
      if (current === root) break;
    }
    const canonicalRoot = await realpath(root), canonical = await realpath(file), rel = path.relative(canonicalRoot, canonical);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Transcript escaped its store: ${file}`);
    const info = await lstat(file);
    if (!info.isFile()) throw new Error(`Not a transcript file: ${file}`);
    return { path: file, bytes: info.size, modified: info.mtimeMs, changed: info.ctimeMs, inode: info.ino };
  }
  private async walk(directory: string, root: string, all = false): Promise<TranscriptFile[]> {
    let info;
    try { info = await lstat(directory); } catch (error) { if (absent(error)) return []; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Linked or invalid transcript directory: ${directory}`);
    // Validate the home before descending, even if the directory is empty.
    if ((await lstat(root)).isSymbolicLink()) throw new Error(`Linked transcript home: ${root}`);
    const files: TranscriptFile[] = [];
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Linked transcript path: ${file}`);
      if (entry.isDirectory()) files.push(...await this.walk(file, root, all));
      else if (!all && /\.jsonl\.gz$/i.test(entry.name)) throw new Error(`Unsupported transcript compression: ${file}`);
      else if (all || /\.jsonl(?:\.zst)?$/.test(entry.name)) files.push(await this.checked(file, root));
    }
    return files;
  }
  private async header(file: TranscriptFile): Promise<any[]> {
    const stamp = JSON.stringify(file), cached = this.headers.get(file.path);
    if (cached?.stamp === stamp) return cached.records;
    const { text, truncated } = await transcriptPrefix(file.path), lines = text.split('\n');
    if (truncated) lines.pop();
    const records = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    // Early Codex rollouts begin with a flat metadata record, before session_meta existed.
    const first = records[0];
    if (first && first.type === undefined && typeof first.id === 'string' && uuid.test(first.id)
      && typeof first.timestamp === 'string' && Number.isFinite(Date.parse(first.timestamp))
      && (Object.hasOwn(first, 'instructions') || Object.hasOwn(first, 'git'))) {
      if (!path.basename(file.path).replace(/\.jsonl(?:\.zst)?$/, '').endsWith(`-${first.id}`)) throw new Error(`Legacy transcript ID does not match its filename: ${file.path}`);
      records[0] = { type: 'session_meta', legacy: true, payload: first };
    }
    // Cache compact metadata only, never entire prompt/tool records.
    const compact = records.map(row => ({ type: row.type, cwd: row.cwd, customTitle: row.customTitle, summary: row.summary, ...(row.legacy ? { legacy: true } : {}),
      ...(row.type === 'session_meta' ? { payload: { id: row.payload?.id, cwd: row.payload?.cwd, parent_thread_id: row.payload?.parent_thread_id, source: row.payload?.source } } : {}),
      ...(row.type === 'event_msg' && row.payload?.type === 'user_message' ? { payload: { type: 'user_message', message: typeof row.payload.message === 'string' ? row.payload.message.slice(0, 140) : undefined } } : {}),
      ...(row.type === 'user' && typeof row.message?.content === 'string' ? { message: { content: row.message.content.slice(0, 140) } } : {}) }));
    if (this.headers.size >= 20000) this.headers.clear();
    this.headers.set(file.path, { stamp, records: compact }); return compact;
  }
  async inspect(): Promise<ConversationCleanupState> {
    await this.load();
    const conversations: CleanupConversation[] = [], errors: string[] = [], deferred = new Map<string, TranscriptFile>();
    this.compressed.clear();
    for (const provider of ['Codex', 'Claude'] as const) {
      const root = path.resolve(this.roots[provider]), rows = new Map<string, CleanupConversation>();
      try {
        const files = provider === 'Codex'
          ? [...await this.walk(path.join(root, 'sessions'), root), ...await this.walk(path.join(root, 'archived_sessions'), root)]
          : await this.walk(path.join(root, 'projects'), root);
        const native = provider === 'Codex' ? await codexSessionMetadata(root) : new Map();
        // Warm the header cache with bounded parallel reads; the loop below rethrows any failure in order.
        for (let offset = 0; offset < files.length; offset += 16) await Promise.all(files.slice(offset, offset + 16).map(file => file.bytes && (provider === 'Codex' || uuid.test(path.basename(file.path, '.jsonl'))) ? this.header(file).catch(() => {}) : undefined));
        for (const file of files) {
          // Empty rollout placeholders contain no conversation metadata or reclaimable payload.
          if (!file.bytes) continue;
          if (provider === 'Claude' && !uuid.test(path.basename(file.path, '.jsonl'))) continue;
          const records = await this.header(file), session = records.find(row => row.type === 'session_meta'), meta = session?.payload;
          const id = provider === 'Codex' ? meta?.id : path.basename(file.path, '.jsonl');
          if (typeof id !== 'string' || !uuid.test(id)) { errors.push(`Skipped unrecognized transcript: ${file.path}`); continue; }
          const saved = native.get(id), first = records.find(row => typeof row.cwd === 'string');
          // Codex's migration skips flat-header rollouts; once one is indexed, its native delete applies again.
          const legacy = provider === 'Codex' && session?.legacy === true && !saved;
          const user = records.find(row => row.type === 'user' && typeof row.message?.content === 'string')?.message.content
            ?? records.find(row => row.type === 'event_msg' && row.payload?.type === 'user_message')?.payload.message;
          const recent = [...records].reverse();
          const title = saved?.title ?? recent.find(row => typeof row.customTitle === 'string')?.customTitle
            ?? recent.find(row => typeof row.summary === 'string')?.summary ?? (typeof user === 'string' ? user.replace(/\s+/g, ' ').slice(0, 120) : undefined) ?? `${provider} · ${id.slice(0, 8)}`;
          const parent = meta?.parent_thread_id ?? meta?.source?.subagent?.thread_spawn?.parent_thread_id;
          const key = `${provider}:${id}`, existing = rows.get(key);
          if (existing) {
            if (provider === 'Claude') existing.blocked = 'Duplicate session ID in multiple project folders.';
            existing.files.push(file); existing.bytes += file.bytes; existing.updatedAt = Math.max(existing.updatedAt, file.modified);
            existing.archived ||= provider === 'Codex' && path.relative(root, file.path).split(path.sep)[0] === 'archived_sessions';
            if (!legacy) delete existing.legacy;
            continue;
          }
          const payloads = [file];
          if (provider === 'Claude') payloads.push(...await this.walk(path.join(path.dirname(file.path), id), root, true));
          rows.set(key, { key, id, provider, title, project: saved?.cwd ?? meta?.cwd ?? first?.cwd ?? (provider === 'Codex' ? 'Unknown project' : path.basename(path.dirname(file.path))),
            archived: provider === 'Codex' && (saved?.archived === true || path.relative(root, file.path).split(path.sep)[0] === 'archived_sessions'),
            updatedAt: Math.max(...payloads.map(item => item.modified)), bytes: payloads.reduce((sum, item) => sum + item.bytes, 0), files: payloads,
            ...(typeof parent === 'string' ? { parent: `Codex:${parent}` } : {}), ...(legacy ? { legacy: true as const } : {}) });
        }
        for (const row of rows.values()) {
          for (const file of row.files) { if (file.path.endsWith('.zst')) this.compressed.add(file.path); await this.lastMessage(file, deferred); }
          row.lastMessageAt = this.knownMessageAt(row);
        }
        conversations.push(...rows.values());
      } catch (error) { errors.push(`${provider}: ${message(error)}`); }
    }
    const protectedKeys = this.protectedKeys();
    for (const row of conversations) {
      if (protectedKeys.has(row.key)) row.blocked = 'Open conversation or pending message queue.';
      else if (Date.now() - Math.max(row.updatedAt, row.lastMessageAt ?? 0) < grace) row.blocked = 'Updated within the last 10 minutes.';
    }
    this.pending = deferred;
    return { status: 'ready', roots: this.roots, conversations: ordered(conversations), errors, ...(deferred.size ? { dates: { done: 0, total: deferred.size } } : {}) };
  }
  /** Reads the compressed transcripts the last inspect() deferred, or only those in `only`. Returns undefined when aborted. */
  async resolveDates(state: ConversationCleanupState, signal: AbortSignal, progress: (state: ConversationCleanupState) => void = () => {}, only?: Set<string>): Promise<ConversationCleanupState | undefined> {
    const queue = [...this.pending.values()].filter(file => !only || only.has(file.path)), total = queue.length, errors: string[] = [];
    let done = 0, shownAt = Date.now();
    const current = (): ConversationCleanupState => ({ ...state, errors: [...state.errors ?? [], ...errors],
      conversations: state.conversations && ordered(state.conversations.map(row => ({ ...row, lastMessageAt: this.knownMessageAt(row) }))),
      dates: done < total ? { done, total } : undefined });
    // zlib decodes on the libuv pool; a few at once keeps the extension host responsive.
    await Promise.all(Array.from({ length: Math.min(3, total) }, async () => {
      for (let file; !signal.aborted && (file = queue.shift());) {
        try { await this.lastMessage(file, undefined, signal); }
        catch (error) { if (!signal.aborted && !absent(error)) errors.push(`Could not read message dates from ${file.path}: ${message(error)}`); }
        this.pending.delete(file.path); done++;
        // Each update re-sorts every row and posts the whole dashboard, so ticks are throttled.
        if (!signal.aborted && done < total && Date.now() - shownAt >= 500) { shownAt = Date.now(); progress(current()); }
      }
    }));
    await this.save().catch(() => {});
    return signal.aborted ? undefined : current();
  }
  private expand(rows: CleanupConversation[], keys: Set<string>) {
    let changed = true;
    while (changed) { changed = false; for (const row of rows) if (row.parent && keys.has(row.parent) && !keys.has(row.key)) { keys.add(row.key); changed = true; } }
    return rows.filter(row => keys.has(row.key));
  }
  async preview(value: unknown): Promise<ConversationCleanupState> {
    this.cancel();
    if (!Array.isArray(value) || !value.length || value.some(key => typeof key !== 'string')) throw new Error('Select conversations to delete.');
    const state = await this.inspect(), keys = new Set<string>(value);
    if (state.errors?.length) throw new Error('Resolve transcript scan errors before deleting conversations.');
    if ([...keys].some(key => !state.conversations!.some(row => row.key === key))) throw new Error('Conversation list changed. Refresh and select again.');
    const selected = this.expand(state.conversations!, keys);
    if (selected.some(row => row.blocked)) throw new Error('An included conversation is open, recently updated or cannot be safely deleted.');
    this.plan = { token: randomUUID(), createdAt: Date.now(), conversations: selected, bytes: selected.reduce((sum, row) => sum + row.bytes, 0) };
    return { ...state, plan: this.plan };
  }
  private async exactDates(state: ConversationCleanupState, progress: DeletionProgress, only?: Set<string>) {
    if (!state.dates) return state;
    const resolved = await this.resolveDates(state, progress.signal ?? new AbortController().signal, next => { if (next.dates) progress.dates?.(next.dates); }, only);
    if (!resolved) throw new Error('Conversation cleanup was cancelled. Nothing was deleted.');
    return resolved;
  }
  /** Deletes every requested conversation that can go with all of its subagent history; the rest are reported as kept. */
  private async deleteEligible(state: ConversationCleanupState, keys: string[], before: number, progress: DeletionProgress): Promise<ConversationCleanupState> {
    if (state.errors?.length) throw new Error('Resolve transcript scan errors before deleting conversations.');
    const rows = state.conversations!, byKey = new Map(rows.map(row => [row.key, row])), kept: ConversationKept[] = [], approved = new Set<string>();
    for (const key of keys) {
      const row = byKey.get(key);
      if (!row) { kept.push({ key, title: key, reason: 'No longer found. Refresh the list.' }); continue; }
      // Native deletion cascades, so a conversation goes only together with all of its subagent history.
      const family = this.expand(rows, new Set([key]));
      const blocked = family.find(item => item.blocked), newer = family.find(item => conversationTime(item) >= before);
      if (blocked) kept.push({ key, title: row.title, reason: blocked === row ? blocked.blocked! : `Subagent history is protected: ${blocked.blocked}` });
      else if (newer) kept.push({ key, title: row.title, reason: newer === row ? 'Newer than the cutoff.' : 'Has subagent history newer than the cutoff.' });
      else for (const item of family) approved.add(item.key);
    }
    const conversations = rows.filter(row => approved.has(row.key));
    if (!conversations.length) return { ...state, result: { removed: [], bytes: 0, skipped: [], failures: [], kept, titles: {} } };
    this.plan = { token: randomUUID(), createdAt: Date.now(), conversations, bytes: conversations.reduce((sum, row) => sum + row.bytes, 0) };
    progress.deleting?.(0, conversations.length);
    const next = await this.delete(this.plan.token, progress);
    return { ...next, result: { ...next.result!, kept } };
  }
  async deleteSelected(keys: unknown, before: unknown, progress: DeletionProgress = {}): Promise<ConversationCleanupState> {
    const cutoff = validCutoff(before);
    if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== 'string')) throw new Error('Select conversations to delete.');
    this.cancel();
    const state = await this.inspect(), wanted = new Set<string>(keys);
    // Only the selection and its subagents need exact dates.
    const files = new Set(this.expand(state.conversations!, new Set(wanted)).flatMap(row => row.files.map(file => file.path)));
    return this.deleteEligible(await this.exactDates(state, progress, files), [...wanted], cutoff, progress);
  }
  /** Deletes everything the filters match in one run, after reading every message date the match depends on. */
  async deleteMatching(value: unknown, progress: DeletionProgress = {}): Promise<ConversationCleanupState> {
    const filter = conversationFilter(value);
    this.cancel();
    const state = await this.exactDates(await this.inspect(), progress);
    return this.deleteEligible(state, state.conversations!.filter(row => matchesConversation(row, filter)).map(row => row.key), filter.before, progress);
  }
  async delete(token: unknown, options: DeletionProgress | ((done: number, total: number) => void) = {}): Promise<ConversationCleanupState> {
    const progress = typeof options === 'function' ? { deleting: options } : options;
    const plan = this.plan; this.cancel();
    if (!plan || token !== plan.token || Date.now() - plan.createdAt > 10 * 60 * 1000) throw new Error('Preview conversation deletion again before deleting.');
    const result: ConversationCleanupResult = { removed: [], bytes: 0, skipped: [], failures: [], titles: Object.fromEntries(plan.conversations.map(row => [row.key, row.title])) };
    if (progress.signal?.aborted || (progress.confirm && !await progress.confirm(plan))) {
      result.cancelled = true;
      return { ...await this.inspect(), result };
    }
    const current = await this.inspect();
    if (current.errors?.length) throw new Error('Transcript scan failed. Nothing was deleted.');
    const fresh = this.expand(current.conversations!, new Set(plan.conversations.map(row => row.key)));
    if (fresh.length !== plan.conversations.length || plan.conversations.some(row => {
      const latest = fresh.find(item => item.key === row.key); return !latest || latest.blocked || fingerprint(latest) !== fingerprint(row);
    })) throw new Error('Conversations changed or became protected. Preview deletion again.');
    const ignoredErrors = new Set<string>();
    const remaining = new Set(fresh.map(row => row.key));
    // Children first: a parent's native deletion may cascade to spawned children.
    const pending = new Map(plan.conversations.map(row => [row.key, row]));
    while (pending.size) {
      if (progress.signal?.aborted) { result.cancelled = true; break; }
      const row = [...pending.values()].find(item => ![...pending.values()].some(child => child.parent === item.key));
      if (!row) { result.failures.push('Cyclic conversation ancestry. Remaining conversations were kept.'); break; }
      pending.delete(row.key);
      try {
        const root = path.resolve(this.roots[row.provider]);
        const files = await Promise.all(row.files.map(file => this.checked(file.path, root)));
        if (row.provider === 'Claude') {
          const sidecars = await this.walk(path.join(path.dirname(row.files[0]!.path), row.id), root, true);
          if (sidecars.some(file => !files.some(approved => approved.path === file.path))) throw new Error('New session sidecar files appeared. Preview again.');
        }
        const latest = { ...row, files }, descendants = this.expand(fresh.filter(child => remaining.has(child.key)), new Set([row.key]));
        // A failed or changed child must also keep its ancestors: native delete cascades.
        if (this.protectedKeys().has(row.key) || fingerprint(latest) !== fingerprint(row)
          || descendants.some(child => child.key !== row.key)) { result.skipped.push(row.key); }
        else {
          // No native index entry to keep consistent, so the rechecked files are the whole conversation.
          if (row.legacy) for (const file of files) await unlink(file.path).catch(error => { if (!absent(error)) throw error; });
          else await this.remove(row);
          for (const file of row.files) {
            const exists = await lstat(file.path).then(() => true, error => { if (absent(error)) return false; throw error; });
            if (exists) throw new Error('Provider did not remove all previewed transcript files. Refresh before retrying.');
          }
          remaining.delete(row.key);
          result.removed.push(row.key); result.bytes += row.bytes;
        }
      } catch (error) {
        const reason = message(error), signature = JSON.stringify([row.provider, reason]);
        result.failures.push(`${row.provider} · ${row.title}: ${reason}`);
        if (progress.onError && !ignoredErrors.has(signature)) {
          const choice = await progress.onError(row, reason);
          if (choice === 'cancel') { result.cancelled = true; break; }
          if (choice === 'skipAll') ignoredErrors.add(signature);
        }
      }
      progress.deleting?.(result.removed.length + result.skipped.length + result.failures.length, plan.conversations.length);
    }
    return { ...await this.inspect(), result };
  }
}
