import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
// Use the package's ESM build so esbuild can bundle its relative imports into VSIX.
import { visit } from 'jsonc-parser/lib/esm/main.js';
import type { ConversationProvider } from './conversations';
import { addTotals, emptyTotals, localDay, type TokenTotals, type UsageDay, type UsageHistoryData, type RecentUsage, type UsageConversation } from '../core/usage-dashboard';
import { addApiCost, apiCost, emptyApiCost } from '../core/api-pricing';
import type { UsageAccountStore } from '../core/usage-account-store';
import { claudeHistoryOwner, type UsageAccount } from '../core/usage-account';
import { matchingAssignment, type KnownUsageAccount, type UsageAttributionStore } from '../core/usage-attribution-store';
import type { UsageAccountSource } from '../core/usage-dashboard';

const obj = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
interface UsageRecord extends TokenTotals { id: string; provider: ConversationProvider; model: string; timestamp: number; conversationId?: string; project?: string; accountKey?: string; cacheWrite1h?: number; kind?: 'modern' | 'legacy'; equivalent?: string; account?: UsageAccount; accountConflict?: boolean; creatorAccountId?: string; creatorConflict?: boolean; accountSource?: UsageAccountSource }
function totals(value: unknown, provider: ConversationProvider): TokenTotals & { cacheWrite1h?: number } {
  const u = obj(value), cacheRead = count(u.cache_read_input_tokens ?? u.cached_input_tokens ?? u.cachedInputTokens);
  const cacheWrite = count(u.cache_creation_input_tokens ?? u.cache_write_input_tokens ?? u.cacheWriteInputTokens);
  const input = count(u.input_tokens ?? u.inputTokens) + (provider === 'Claude' ? cacheRead + cacheWrite : 0);
  const output = count(u.output_tokens ?? u.outputTokens);
  return { input, output, cacheRead, cacheWrite, reasoning: count(u.reasoning_output_tokens ?? u.reasoningOutputTokens), total: input + output, requests: 1,
    ...(provider === 'Claude' ? { cacheWrite1h: count(obj(u.cache_creation).ephemeral_1h_input_tokens) } : {}) };
}
const fingerprint = (t: TokenTotals) => JSON.stringify([t.input, t.output, t.cacheRead, t.cacheWrite, t.reasoning]);

/** Read usage only, retaining no prompt, response text, tool payload or credential. */
export class UsageParser {
  private session = ''; private model = 'Unknown model'; private turn = ''; private rootTurn = '';
  private project?: string;
  private creatorAccountId?: string;
  private claudeOwners = new Map<string, Set<string>>();
  private previous?: TokenTotals;
  private modern: UsageRecord[] = [];
  private legacy: Array<{ record: UsageRecord; cumulative?: string }> = [];
  private modernTotals = new Set<string>();
  undated = 0;
  constructor(private provider: ConversationProvider) {}
  consume(value: unknown) {
    const r = obj(value), p = obj(r.payload), m = obj(r.message);
    if (this.provider === 'Claude') {
      this.session = text(r.sessionId) ?? this.session; this.project = text(r.cwd) ?? this.project;
      if (r.type === 'bridge-session' && text(r.sessionId)) {
        const owner = claudeHistoryOwner(r.ownerAccountUuid, r.ownerOrganizationUuid);
        if (owner) {
          const owners = this.claudeOwners.get(r.sessionId) ?? new Set<string>();
          owners.add(owner); this.claudeOwners.set(r.sessionId, owners);
        }
      }
      if (r.type !== 'assistant' || !Object.keys(obj(m.usage)).length || m.model === '<synthetic>') return;
      const id = text(m.id) ?? text(r.requestId) ?? text(r.uuid);
      if (!id) return;
      this.record(this.modern, `Claude:${id}`, totals(m.usage, 'Claude'), r.timestamp, text(m.model) ?? 'Unknown model');
      return;
    }
    if (r.type === 'session_meta') { this.session = text(p.id) ?? ''; this.project = text(p.cwd); this.model = text(p.model) ?? this.model; this.creatorAccountId = text(p.creator_account_id); }
    if (r.type === 'turn_context') { this.turn = text(p.turn_id) ?? this.turn; this.rootTurn = text(p.root_turn_id) ?? ''; this.model = text(p.model) ?? this.model; }
    if (r.type === 'event_msg' && p.type === 'model_rerouted') this.model = text(p.to_model ?? p.toModel) ?? this.model;
    if (r.type === 'token_usage_record') {
      const usage = totals(p.usage, 'Codex');
      const cumulative = totals(p.thread_token_usage, 'Codex');
      if (Object.keys(obj(p.thread_token_usage)).length) this.modernTotals.add(fingerprint(cumulative));
      const id = text(p.response_id) ?? `${p.thread_id ?? this.session}:${p.turn_id ?? this.turn}:${r.timestamp}:${fingerprint(cumulative)}`;
      const index = this.modern.length;
      this.record(this.modern, `Codex:${id}`, usage, r.timestamp, text(p.model) ?? this.model);
      if (this.modern[index]) {
        this.modern[index]!.conversationId = text(p.thread_id) ?? (this.session || undefined);
        this.modern[index]!.kind = 'modern';
        const turn = text(p.root_turn_id) || text(p.turn_id) || this.rootTurn || this.turn;
        if (turn) this.modern[index]!.accountKey = `Codex:turn:${turn}`;
        const context = text(p.turn_id) || this.turn || this.session;
        if (context && Object.keys(obj(p.thread_token_usage)).length) this.modern[index]!.equivalent = `${context}:${fingerprint(cumulative)}`;
      }
    }
    if (r.type === 'event_msg' && p.type === 'token_count') {
      const info = obj(p.info);
      if (!Object.keys(info).length) return;
      const totalValue = info.total_token_usage ?? info.totalTokenUsage;
      const lastValue = info.last_token_usage ?? info.lastTokenUsage;
      const cumulative = Object.keys(obj(totalValue)).length ? totals(totalValue, 'Codex') : undefined;
      let usage = totals(lastValue, 'Codex');
      if (cumulative && this.previous) {
        // Replayed counters on resume aren't new usage. A counter reset uses the last request only.
        if (cumulative.input >= this.previous.input && cumulative.output >= this.previous.output) {
          usage = { ...cumulative, input: cumulative.input - this.previous.input, output: cumulative.output - this.previous.output,
            cacheRead: Math.max(0, cumulative.cacheRead - this.previous.cacheRead), cacheWrite: Math.max(0, cumulative.cacheWrite - this.previous.cacheWrite),
            reasoning: Math.max(0, cumulative.reasoning - this.previous.reasoning) };
          usage.total = usage.input + usage.output;
        }
      } else if (cumulative && !Object.keys(obj(lastValue)).length) usage = cumulative;
      this.previous = cumulative ?? this.previous;
      const rows: UsageRecord[] = [];
      this.record(rows, `Codex:legacy:${r.timestamp}:${this.turn}:${fingerprint(cumulative ?? usage)}`, usage, r.timestamp, this.model);
      if (rows[0]) {
        rows[0].kind = 'legacy';
        const context = this.turn || this.session;
        if (context && cumulative) rows[0].equivalent = `${context}:${fingerprint(cumulative)}`;
        this.legacy.push({ record: rows[0], cumulative: cumulative ? fingerprint(cumulative) : undefined });
      }
    }
  }
  private record(target: UsageRecord[], id: string, usage: TokenTotals, stamp: unknown, model: string) {
    if (!usage.total) return;
    const timestamp = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
    if (!Number.isFinite(timestamp)) { this.undated++; return; }
    target.push({ ...usage, id, timestamp, model, provider: this.provider,
      ...(this.creatorAccountId ? { creatorAccountId: this.creatorAccountId } : {}),
      ...(this.session ? { conversationId: this.session } : {}), ...(this.project ? { project: this.project } : {}),
      ...(this.provider === 'Codex' && (this.rootTurn || this.turn) ? { accountKey: `Codex:turn:${this.rootTurn || this.turn}` } : {}) });
  }
  records(): UsageRecord[] {
    return [...this.modern, ...this.legacy.filter(row => !row.cumulative || !this.modernTotals.has(row.cumulative)).map(row => row.record)].map(row => {
      const owners = row.conversationId && this.claudeOwners.get(row.conversationId);
      return owners ? { ...row, creatorAccountId: owners.size === 1 ? [...owners][0] : 'conflicting-owners' } : row;
    });
  }
}
interface ParsedFile { signature: string; records: UsageRecord[]; malformed: number; oversized: number; undated: number }
export interface UsageReadStats { discoveryMs: number; parseMs: number; aggregateMs: number; parsedFiles: number; memoryHits: number; diskHits: number }
const cacheVersion = 4;
/** Compact allowlist: cache contains usage counters and native IDs, never message text or account credentials. */
function cachedRecords(value: unknown, provider: ConversationProvider): UsageRecord[] | undefined {
  if (!Array.isArray(value)) return;
  const records: UsageRecord[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 15 || typeof row[0] !== 'string' || !row[0].startsWith(`${provider}:`) || row[0].length > 2048 || typeof row[1] !== 'string' || row[1].length > 512 || !Number.isFinite(row[2]) || row.slice(3, 8).some(n => !Number.isSafeInteger(n) || n < 0) || (row[8] !== null && (!Number.isSafeInteger(row[8]) || row[8] < 0)) || [row[9], row[11], row[12], row[13], row[14]].some(s => s !== null && (typeof s !== 'string' || s.length > 2048)) || ![null, 'modern', 'legacy'].includes(row[10])) return;
    const [id, model, timestamp, input, output, cacheRead, cacheWrite, reasoning, cacheWrite1h, accountKey, kind, equivalent, conversationId, project, creatorAccountId] = row;
    if (!Number.isSafeInteger(input + output)) return;
    records.push({ id, model, timestamp, input, output, cacheRead, cacheWrite, reasoning, total: input + output, requests: 1, provider,
      ...(cacheWrite1h !== null ? { cacheWrite1h } : {}), ...(accountKey !== null ? { accountKey } : {}), ...(kind !== null ? { kind } : {}), ...(equivalent !== null ? { equivalent } : {}),
      ...(conversationId !== null ? { conversationId } : {}), ...(project !== null ? { project } : {}), ...(creatorAccountId !== null ? { creatorAccountId } : {}) });
  }
  return records;
}
function mayContainUsage(prefix: string, provider: ConversationProvider): boolean {
  let type: string | undefined, eventType: string | undefined;
  const done = {};
  // The prefix can end inside an image/string. The JSON visitor still identifies
  // root-level metadata already read, without confusing nested tool payloads with it.
  try {
    visit(prefix.slice(0, 8192), { onLiteralValue(value, _offset, _length, _line, _character, location) {
      const key = location().join('.');
      if (key === 'type') type = text(value);
      if (key === 'payload.type') eventType = text(value);
      // Once the root record type is known, don't scan its message/tool content.
      if (type && (provider === 'Claude' || type !== 'event_msg' || eventType)) throw done;
    } });
  } catch (error) { if (error !== done) throw error; }
  if (!type) return true;
  if (provider === 'Claude') return type === 'assistant' || type === 'bridge-session';
  if (type === 'event_msg') return !eventType || eventType === 'token_count' || eventType === 'model_rerouted';
  return ['session_meta', 'turn_context', 'token_usage_record'].includes(type);
}
async function parseFile(file: string, provider: ConversationProvider, signature: string, signal?: AbortSignal): Promise<ParsedFile> {
  const parser = new UsageParser(provider);
  let pending = '', discarding = false, largeUsageLine = false, malformed = 0, oversized = 0, lines = 0;
  // Bound huge image/tool lines without loading whole conversations into Extension Host memory.
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 256 * 1024, signal });
  for await (const chunk of stream) {
    const pieces = String(chunk).split('\n');
    for (let i = 0; i < pieces.length; i++) {
      if (!discarding) {
        pending += pieces[i];
        if (pending.length > 32 * 1024 && !largeUsageLine) {
          largeUsageLine = mayContainUsage(pending, provider);
          if (!largeUsageLine) { pending = ''; discarding = true; }
        }
        if (pending.length > 32 * 1024 * 1024) { pending = ''; discarding = true; oversized++; }
      }
      if (i < pieces.length - 1) {
        if (!discarding && pending.trim()) { try { parser.consume(JSON.parse(pending)); } catch { malformed++; } }
        pending = ''; discarding = false; largeUsageLine = false;
        if (++lines % 200 === 0) { signal?.throwIfAborted(); await setImmediate(); }
      }
    }
  }
  // A writer may not have finished the trailing JSON record yet; next refresh will reread it.
  if (!discarding && pending.trim()) { try { parser.consume(JSON.parse(pending)); } catch { /* incomplete tail */ } }
  return { signature, records: parser.records(), malformed, oversized, undated: parser.undated };
}
async function historyFiles(directory: string, signal?: AbortSignal): Promise<{ files: string[]; unreadable: number }> {
  const result: string[] = [], queue = [directory]; let unreadable = 0;
  while (queue.length) {
    signal?.throwIfAborted();
    const folder = queue.pop()!;
    try {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.isDirectory()) queue.push(path.join(folder, entry.name));
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(path.join(folder, entry.name));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable++; }
  }
  return { files: result.sort(), unreadable };
}
export class UsageHistory {
  private cache = new Map<string, ParsedFile>();
  readStats?: UsageReadStats;
  constructor(private homes = { codex: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), claude: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') }, private accounts?: Pick<UsageAccountStore, 'read'>, private cacheDirectory?: string,
    private attribution?: { store: Pick<UsageAttributionStore, 'read'>; knownAccounts: () => Promise<KnownUsageAccount[]> }) {}
  private cacheFile(file: string, provider: ConversationProvider) {
    const source = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    return path.join(this.cacheDirectory!, `${createHash('sha256').update(`${provider}:${source}`).digest('hex')}.json`);
  }
  private async diskCache(file: string, provider: ConversationProvider, signature: string): Promise<ParsedFile | undefined> {
    if (!this.cacheDirectory) return;
    try {
      const filename = this.cacheFile(file, provider);
      if ((await stat(filename)).size > 64 * 1024 * 1024) return;
      const data = JSON.parse(await readFile(filename, 'utf8'));
      if (data.version !== cacheVersion || data.provider !== provider || data.signature !== signature || [data.malformed, data.oversized, data.undated].some(n => !Number.isSafeInteger(n) || n < 0)) return;
      const records = cachedRecords(data.records, provider);
      if (records) return { signature, records, malformed: data.malformed, oversized: data.oversized, undated: data.undated };
    } catch { /* Missing, corrupt or outdated cache falls back to native read-only history. */ }
  }
  private async saveCache(file: string, provider: ConversationProvider, data: ParsedFile) {
    if (!this.cacheDirectory) return;
    const filename = this.cacheFile(file, provider), temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.cacheDirectory, { recursive: true });
      const records = data.records.map(row => [row.id, row.model, row.timestamp, row.input, row.output, row.cacheRead, row.cacheWrite, row.reasoning, row.cacheWrite1h ?? null, row.accountKey ?? null, row.kind ?? null, row.equivalent ?? null, row.conversationId ?? null, row.project ?? null, row.creatorAccountId ?? null]);
      await writeFile(temporary, JSON.stringify({ version: cacheVersion, provider, signature: data.signature, malformed: data.malformed, oversized: data.oversized, undated: data.undated, records }), { flag: 'wx' });
      await rename(temporary, filename);
    } catch { /* An optional cache must never hide otherwise readable usage. */ }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  async read(signal?: AbortSignal): Promise<UsageHistoryData> {
    const start = performance.now(), stats: UsageReadStats = { discoveryMs: 0, parseMs: 0, aggregateMs: 0, parsedFiles: 0, memoryHits: 0, diskHits: 0 };
    const accounts = await this.accounts?.read();
    const assignments = await this.attribution?.store.read(), known = await this.attribution?.knownAccounts();
    const creators = new Map<string, UsageAccount | null>();
    for (const entry of known ?? []) for (const id of entry.nativeAccountIds) {
      const key = `${entry.account.provider}:${id}`, previous = creators.get(key);
      creators.set(key, previous === null || (previous && previous.id !== entry.account.id) ? null : entry.account);
    }
    const roots: Array<[ConversationProvider, string]> = [['Codex', path.join(this.homes.codex, 'sessions')], ['Codex', path.join(this.homes.codex, 'archived_sessions')], ['Claude', path.join(this.homes.claude, 'projects')]];
    const lists = await Promise.all(roots.map(async ([provider, root]) => ({ provider, ...await historyFiles(root, signal) })));
    let unreadableFiles = lists.reduce((sum, list) => sum + list.unreadable, 0), malformedLines = 0, oversizedLines = 0, undatedRecords = 0, duplicates = 0;
    const files = lists.flatMap(list => list.files.map(file => ({ file, provider: list.provider }))), present = new Set(files.map(row => row.file));
    for (const file of this.cache.keys()) if (!present.has(file)) this.cache.delete(file);
    stats.discoveryMs = performance.now() - start;
    const parseStart = performance.now();
    const records = new Map<string, UsageRecord>(), nativeAliases = new Set<string>();
    for (let offset = 0; offset < files.length; offset += 4) {
      const parsed = await Promise.all(files.slice(offset, offset + 4).map(async ({ file, provider }) => {
        try {
          signal?.throwIfAborted(); const info = await stat(file), signature = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
          let data = this.cache.get(file);
          if (data?.signature === signature) stats.memoryHits++;
          else {
            data = await this.diskCache(file, provider, signature);
            if (data) stats.diskHits++;
            else { data = await parseFile(file, provider, signature, signal); stats.parsedFiles++; await this.saveCache(file, provider, data); }
            signal?.throwIfAborted(); this.cache.set(file, data);
          }
          return data;
        } catch { signal?.throwIfAborted(); unreadableFiles++; return undefined; }
      }));
      for (const file of parsed) {
        if (!file) continue;
        malformedLines += file.malformed; oversizedLines += file.oversized; undatedRecords += file.undated;
        for (const row of file.records) {
          if (row.kind === 'modern' && row.equivalent) nativeAliases.add(row.equivalent);
          const existing = records.get(row.id);
          const evidence = accounts?.get(row.id) ?? (row.accountKey ? accounts?.get(row.accountKey) : undefined);
          const conflict = accounts?.get(row.id) === null || (!!row.accountKey && accounts?.get(row.accountKey) === null);
          const account = conflict ? undefined : evidence ?? undefined;
          if (!existing) { records.set(row.id, { ...row, account, accountConflict: conflict }); continue; }
          if (row.creatorAccountId && existing.creatorAccountId && row.creatorAccountId !== existing.creatorAccountId) existing.creatorConflict = true;
          else existing.creatorAccountId ??= row.creatorAccountId;
          if (conflict || (existing.account && account && existing.account.id !== account.id)) { existing.account = undefined; existing.accountConflict = true; }
          else if (!existing.accountConflict && account) existing.account = account;
          duplicates++;
          // One API response can be serialized once per content block, or copied into a fork.
          for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) existing[key] = Math.max(existing[key], row[key]);
          if (row.cacheWrite1h !== undefined) existing.cacheWrite1h = Math.max(existing.cacheWrite1h ?? 0, row.cacheWrite1h);
          existing.total = existing.input + existing.output; existing.timestamp = Math.min(existing.timestamp, row.timestamp);
          if (existing.model === 'Unknown model') existing.model = row.model;
        }
      }
      await setImmediate();
    }
    stats.parseMs = performance.now() - parseStart;
    const claudeSessions = new Map<string, UsageAccount | null>();
    for (const row of records.values()) {
      if (row.provider !== 'Claude' || !row.conversationId) continue;
      const owner = row.creatorAccountId ? creators.get(`Claude:${row.creatorAccountId}`) : undefined;
      const evidence = row.account ?? owner;
      const previous = claudeSessions.get(row.conversationId);
      if (row.accountConflict || row.creatorConflict || (row.creatorAccountId && !owner) ||
        (row.account && owner && row.account.id !== owner.id) || (previous && evidence && previous.id !== evidence.id)) claudeSessions.set(row.conversationId, null);
      else if (previous !== null && evidence) claudeSessions.set(row.conversationId, evidence);
    }
    const aggregateStart = performance.now();
    const days = new Map<string, UsageDay>(), recent: RecentUsage[] = [], conversations = new Map<string, UsageConversation & { buckets: Map<string, UsageDay> }>(), now = Date.now();
    let aggregated = 0;
    for (const row of records.values()) {
      if (++aggregated % 2000 === 0) { signal?.throwIfAborted(); await setImmediate(); }
      if (row.kind === 'legacy' && row.equivalent && nativeAliases.has(row.equivalent)) { duplicates++; continue; }
      const day = localDay(row.timestamp);
      if (!row.account) {
        const assignment = matchingAssignment(assignments ?? [], row.provider, row.conversationId, day);
        if (assignment) { row.account = assignment.account ?? undefined; row.accountSource = 'manual'; }
        else if (!row.accountConflict && !row.creatorConflict) {
          const session = row.provider === 'Claude' && row.conversationId ? claudeSessions.get(row.conversationId) : undefined;
          if (session !== null) row.account = (row.creatorAccountId ? creators.get(`${row.provider}:${row.creatorAccountId}`) : session) ?? undefined;
          if (row.account) row.accountSource = 'inferred';
        }
      }
      const key = `${day}\0${row.provider}\0${row.model}\0${row.account?.id ?? ''}\0${row.accountSource ?? ''}`;
      const attribution = { ...(row.account ? { account: row.account } : {}), ...(row.accountSource ? { accountSource: row.accountSource } : {}) };
      const value = days.get(key) ?? { ...emptyTotals(), day, provider: row.provider, model: row.model, cost: emptyApiCost(), ...attribution };
      addTotals(value, row); addApiCost(value.cost!, apiCost(row.provider, row.model, row)); days.set(key, value);
      const id = row.conversationId || 'unknown', conversationKey = `${row.provider}:${id}`;
      const conversation = conversations.get(conversationKey) ?? { key: conversationKey, id, provider: row.provider, project: row.project, firstAt: row.timestamp, lastAt: row.timestamp, days: [], buckets: new Map<string, UsageDay>() };
      conversation.firstAt = Math.min(conversation.firstAt, row.timestamp); conversation.lastAt = Math.max(conversation.lastAt, row.timestamp);
      const bucket = conversation.buckets.get(key) ?? { ...emptyTotals(), day, provider: row.provider, model: row.model, cost: emptyApiCost(), ...attribution };
      addTotals(bucket, row); addApiCost(bucket.cost!, apiCost(row.provider, row.model, row)); conversation.buckets.set(key, bucket); conversations.set(conversationKey, conversation);
      // Retain only timestamps/provider/token counts for current quota windows.
      if (row.timestamp >= now - 7 * 86400000 && row.timestamp <= now) recent.push({ timestamp: row.timestamp, provider: row.provider, total: row.total, ...(row.account ? { accountId: row.account.id } : {}), ...(row.accountSource ? { accountSource: row.accountSource } : {}) });
    }
    stats.aggregateMs = performance.now() - aggregateStart; this.readStats = stats;
    return { days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)), conversations: [...conversations.values()].map(({ buckets, ...row }) => ({ ...row, days: [...buckets.values()] })).sort((a, b) => b.lastAt - a.lastAt), recent: recent.sort((a, b) => a.timestamp - b.timestamp), updatedAt: now, files: files.length, unreadableFiles,
      malformedLines, undatedRecords, oversizedLines, duplicates, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(assignments ? { assignments } : {}) };
  }
}
