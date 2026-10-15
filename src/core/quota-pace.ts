import type { ConversationProvider } from '../providers/conversations';
import type { ProviderAccountStatus } from '../providers/account-status';
import { usageAccount } from './usage-account';

export interface QuotaTick { provider: ConversationProvider; accountId: string; plan: string; windowId: string; label: string; resetsAt: number; at: number; usedPercent: number }
/** Providers re-derive reset times on every poll, so one cycle's resetsAt jitters by milliseconds to seconds. */
export function sameQuotaWindow(a: QuotaTick, b: QuotaTick) {
  return a.provider === b.provider && a.accountId === b.accountId && a.plan === b.plan && a.windowId === b.windowId && Math.abs(a.resetsAt - b.resetsAt) <= 120000;
}
/** Window length from labels such as "5h", "7d" or "Opus · 7d". */
export function quotaWindowDuration(label: string): number | undefined {
  const match = /(\d+)\s*([mhd])\b/.exec(label);
  return match ? Number(match[1]) * { m: 60000, h: 3600000, d: 86400000 }[match[2] as 'm' | 'h' | 'd'] : undefined;
}
export function quotaTicks(provider: ConversationProvider, status?: ProviderAccountStatus, now = Date.now()): QuotaTick[] {
  const identity = usageAccount(provider, status?.account);
  if (!identity || status?.status !== 'ready' || status.quotaCached || status.quota?.status !== 'available' || !status.updatedAt || status.updatedAt > now || now - status.updatedAt > 300000) return [];
  return status.quota.windows.filter(row => row.resetsAt && row.resetsAt > status.updatedAt! && Number.isFinite(row.usedPercent) && row.usedPercent >= 0 && row.usedPercent <= 100).map(row => ({ provider, accountId: identity.id, plan: status.account?.plan || '', windowId: row.id, label: row.label, resetsAt: row.resetsAt!, at: status.updatedAt!, usedPercent: row.usedPercent }));
}
export function quotaPace(ticks: QuotaTick[], current: QuotaTick, now = Date.now()) {
  let samples = ticks.filter(row => sameQuotaWindow(row, current) && row.at <= current.at && row.at >= current.at - 3600000).sort((a, b) => a.at - b.at);
  const merged = new Map(samples.map(row => [row.at, row])); merged.set(current.at, current); samples = [...merged.values()].sort((a, b) => a.at - b.at);
  let correction = -1;
  for (let index = 1; index < samples.length; index++) if (samples[index]!.usedPercent < samples[index - 1]!.usedPercent) correction = index;
  if (correction >= 0) samples = samples.slice(correction);
  const first = samples[0]!, elapsed = current.at - first.at;
  const percentPerHour = samples.length >= 2 && elapsed >= 60000 ? (current.usedPercent - first.usedPercent) / elapsed * 3600000 : undefined;
  const exhaustsAt = percentPerHour && percentPerHour > 0 ? current.at + Math.max(0, 100 - current.usedPercent) / percentPerHour * 3600000 : undefined;
  return { samples, percentPerHour, exhaustsAt, stale: now - current.at > 300000, beforeReset: exhaustsAt !== undefined && exhaustsAt < current.resetsAt };
}
export interface BurnDownPoint { at: number; remaining: number }
/** Remaining quota across one reset cycle against an even burn to zero at reset. */
export function quotaBurnDown(ticks: QuotaTick[], current: QuotaTick, now = Date.now(), maxPoints = 240) {
  const duration = quotaWindowDuration(current.label);
  const merged = new Map(ticks.filter(row => sameQuotaWindow(row, current) && row.at <= current.at).map(row => [row.at, row])); merged.set(current.at, current);
  // An idle rolling window reports resetsAt ≈ now + duration, so its derived start can land just after the current sample.
  const start = Math.min(current.at, duration ? current.resetsAt - duration : Math.min(...merged.keys()));
  let samples = [...merged.values()].filter(row => row.at >= start).sort((a, b) => a.at - b.at), correction = -1;
  for (let index = 1; index < samples.length; index++) if (samples[index]!.usedPercent < samples[index - 1]!.usedPercent) correction = index;
  if (correction >= 0) samples = samples.slice(correction);
  // Every cycle starts at 0% used; after a correction only observed samples are trusted.
  const anchored = !!duration && correction < 0 && samples[0]!.at > start;
  const base = anchored ? { at: start, usedPercent: 0 } : samples[0]!, elapsed = current.at - base.at;
  const percentPerHour = elapsed >= 60000 ? (current.usedPercent - base.usedPercent) / elapsed * 3600000 : undefined;
  const exhaustsAt = percentPerHour && percentPerHour > 0 ? current.at + (100 - current.usedPercent) / percentPerHour * 3600000 : undefined;
  const width = (current.resetsAt - start) / maxPoints, buckets = new Map<number, QuotaTick>();
  for (const row of samples) buckets.set(Math.floor((row.at - start) / width), row);
  const points: BurnDownPoint[] = [...buckets.values(), current].filter((row, index, rows) => rows.indexOf(row) === index).map(row => ({ at: row.at, remaining: 100 - row.usedPercent }));
  return {
    start, end: current.resetsAt, points, anchored, percentPerHour, exhaustsAt, beforeReset: exhaustsAt !== undefined && exhaustsAt < current.resetsAt,
    remaining: 100 - current.usedPercent, idealRemaining: duration ? Math.min(100, Math.max(0, (current.resetsAt - current.at) / duration * 100)) : undefined,
    projectedAtReset: percentPerHour === undefined ? undefined : Math.max(0, 100 - current.usedPercent - Math.max(0, percentPerHour) * (current.resetsAt - current.at) / 3600000),
    stale: now - current.at > 300000,
  };
}
