import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConversationProvider } from '../providers/conversations';
import { usageAccount, type UsageAccount } from './usage-account';

/** Sign-ins are read about once a minute; a longer silence means no window was watching. */
export const ACTIVE_SIGN_IN_GAP = 3 * 60000;
const RETENTION = 90 * 86400000, MAX_SPANS = 4000;
/** Who the CLI was signed in as between two reads. `null` marks time nothing may be attributed to: signed out, an API key, or a new sign-in the running extensions may not use yet. */
export interface ActiveSignInSpan { provider: ConversationProvider; account: UsageAccount | null; from: number; to: number }
const same = (a: UsageAccount | null, b: UsageAccount | null) => a === b || (!!a && !!b && a.id === b.id);
function clean(row: unknown): ActiveSignInSpan | undefined {
  const span = row as Partial<ActiveSignInSpan> | null;
  if (!span || (span.provider !== 'Codex' && span.provider !== 'Claude') || !Number.isFinite(span.from) || !Number.isFinite(span.to) || span.from! > span.to!) return;
  const a = span.account;
  if (a === null) return { provider: span.provider, account: null, from: span.from!, to: span.to! };
  // Rebuild the allowlist rather than trusting stored fields.
  const account = a && a.provider === span.provider ? usageAccount(a.provider, { signedIn: true, id: a.nativeAccountId, email: a.email, organization: a.organization, method: a.method }) : undefined;
  return account ? { provider: span.provider, account, from: span.from!, to: span.to! } : undefined;
}
/** Builds the lookup once per read: the one account every span around a timestamp agrees on.
 * A span reaches forward until the next span starts or the gap runs out, so the latest responses use the current sign-in. */
export function activeSignInResolver(spans: readonly ActiveSignInSpan[]) {
  const byProvider = new Map<ConversationProvider, { from: number; end: number; account: UsageAccount | null }[]>();
  for (const provider of ['Codex', 'Claude'] as const) {
    const own = spans.filter(span => span.provider === provider).sort((a, b) => a.from - b.from), starts = own.map(span => span.from);
    const intervals = own.map(span => {
      // First start after this span ends.
      let low = 0, high = starts.length;
      while (low < high) { const middle = (low + high) >> 1; if (starts[middle]! > span.to) high = middle; else low = middle + 1; }
      return { from: span.from, end: Math.min(span.to + ACTIVE_SIGN_IN_GAP, starts[low] ?? Infinity), account: span.account };
    });
    byProvider.set(provider, intervals);
  }
  // Running maximum of ends, so a lookup stops walking back once no earlier span can reach the timestamp.
  const reach = new Map([...byProvider].map(([provider, intervals]) => {
    let max = -Infinity; return [provider, intervals.map(interval => (max = Math.max(max, interval.end)))];
  }));
  return (provider: ConversationProvider, timestamp: number): UsageAccount | undefined => {
    const intervals = byProvider.get(provider) ?? [], ends = reach.get(provider) ?? [];
    let low = 0, high = intervals.length;
    while (low < high) { const middle = (low + high) >> 1; if (intervals[middle]!.from > timestamp) high = middle; else low = middle + 1; }
    let found: UsageAccount | undefined;
    for (let index = low - 1; index >= 0 && ends[index]! >= timestamp; index--) {
      const interval = intervals[index]!;
      if (interval.end < timestamp) continue;
      if (!interval.account || (found && found.id !== interval.account.id)) return undefined;
      found = interval.account;
    }
    return found;
  };
}
export function activeSignInAt(spans: readonly ActiveSignInSpan[], provider: ConversationProvider, timestamp: number) {
  return activeSignInResolver(spans)(provider, timestamp);
}
/** Shared by every VS Code window. Each write rereads the file, so a lost race only shortens a span and never stretches one account over another's reading. */
export class ActiveSignInStore {
  private readonly file: string;
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) { this.file = path.join(directory, 'active-sign-ins.json'); }
  private async load(): Promise<ActiveSignInSpan[]> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      return Array.isArray(data?.spans) ? (data.spans as unknown[]).flatMap(row => clean(row) ?? []) : [];
    } catch { return []; }
  }
  async read(): Promise<ActiveSignInSpan[]> { await this.queue; return this.load(); }
  observe(provider: ConversationProvider, account: UsageAccount | null, at = Date.now()): Promise<void> {
    const job = this.queue.then(async () => {
      const spans = await this.load();
      // Extend this account's own latest span, so windows reading different sign-ins overlap (and stay unknown) instead of adding a span per poll.
      const latest = spans.filter(span => span.provider === provider && same(span.account, account)).reduce<ActiveSignInSpan | undefined>((last, span) => !last || span.to > last.to ? span : last, undefined);
      if (latest && at >= latest.from && at <= latest.to) return;
      if (latest && at > latest.to && at - latest.to <= ACTIVE_SIGN_IN_GAP) latest.to = at;
      else spans.push({ provider, account, from: at, to: at });
      const kept = spans.filter(span => span.to >= at - RETENTION).sort((a, b) => a.from - b.from).slice(-MAX_SPANS);
      await mkdir(this.directory, { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify({ version: 1, spans: kept }), { flag: 'wx' }); await rename(temp, this.file); }
      finally { await unlink(temp).catch(() => undefined); }
    });
    this.queue = job.catch(() => undefined); return job;
  }
}
