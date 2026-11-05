import type { ConversationProvider } from '../providers/conversations';
import type { ProviderAccountStatus } from '../providers/account-status';
import { usageAccount } from './usage-account';

export interface QuotaTick { provider: ConversationProvider; accountId: string; plan: string; windowId: string; label: string; resetsAt: number; at: number; usedPercent: number }
/** Providers re-derive reset times on every poll, so one cycle's resetsAt jitters by milliseconds to seconds. */
export function sameQuotaWindow(a: QuotaTick, b: QuotaTick) {
  return a.provider === b.provider && a.accountId === b.accountId && a.plan === b.plan && a.windowId === b.windowId && Math.abs(a.resetsAt - b.resetsAt) <= 120000;
}
/** A lower reading within one cycle is held this long for later readings to confirm it. */
export const QUOTA_DIP_HOLD = 5 * 60000;
/** Readings this close after a dip that return to the earlier level show the dip was stale. Matches quota-rise sampling. */
const QUOTA_DIP_LOOKAHEAD = 15 * 60000;
/**
 * Usage only rises within one cycle, yet polls from several windows can return a reading from before the latest one,
 * such as 8%, 4%, 8%. Those stale dips are dropped. A dip that lasts past the hold is a real correction and is kept;
 * until then it is pending: saved, so a later read can decide, but left out of `settled`.
 */
export function settleQuotaTicks(ticks: readonly QuotaTick[]): { settled: QuotaTick[]; stale: Set<QuotaTick> } {
  const series = new Map<string, QuotaTick[]>(), stale = new Set<QuotaTick>(), pending = new Set<QuotaTick>();
  for (const tick of ticks) {
    const key = JSON.stringify([tick.provider, tick.accountId, tick.plan, tick.windowId]), rows = series.get(key);
    if (rows) rows.push(tick); else series.set(key, [tick]);
  }
  for (const rows of series.values()) {
    rows.sort((a, b) => a.at - b.at);
    let peak = -Infinity, peakAt = -Infinity, cycle: QuotaTick | undefined;
    for (const [index, tick] of rows.entries()) {
      if (!cycle || !sameQuotaWindow(cycle, tick)) peak = -Infinity;
      cycle = tick;
      // A lag spans a poll or two; a drop long after the last higher reading is a correction.
      if (tick.usedPercent >= peak || tick.at - peakAt > QUOTA_DIP_LOOKAHEAD) { peak = tick.usedPercent; peakAt = tick.at; continue; }
      const later = rows.slice(index + 1).filter(row => sameQuotaWindow(row, tick));
      if (later.some(row => row.at <= tick.at + QUOTA_DIP_LOOKAHEAD && row.usedPercent >= peak)) stale.add(tick);
      else if (later.some(row => row.at >= tick.at + QUOTA_DIP_HOLD)) { peak = tick.usedPercent; peakAt = tick.at; }
      else pending.add(tick);
    }
  }
  return { settled: ticks.filter(tick => !stale.has(tick) && !pending.has(tick)), stale };
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
/** This window's live reading can itself be a stale dip; until later readings confirm it, rates use the last settled reading. */
function settledCurrent(merged: Map<number, QuotaTick>, current: QuotaTick) {
  const settled = settleQuotaTicks([...merged.values()]).settled.sort((a, b) => a.at - b.at);
  return { samples: settled, latest: settled.includes(current) ? current : settled.at(-1) ?? current };
}
export function quotaPace(ticks: QuotaTick[], current: QuotaTick, now = Date.now()) {
  const merged = new Map(ticks.filter(row => sameQuotaWindow(row, current) && row.at <= current.at && row.at >= current.at - 3600000).map(row => [row.at, row])); merged.set(current.at, current);
  const live = current;
  let samples: QuotaTick[];
  ({ samples, latest: current } = settledCurrent(merged, current));
  if (!samples.length) samples = [current];
  let correction = -1;
  for (let index = 1; index < samples.length; index++) if (samples[index]!.usedPercent < samples[index - 1]!.usedPercent) correction = index;
  if (correction >= 0) samples = samples.slice(correction);
  const first = samples[0]!, elapsed = current.at - first.at;
  const percentPerHour = samples.length >= 2 && elapsed >= 60000 ? (current.usedPercent - first.usedPercent) / elapsed * 3600000 : undefined;
  const exhaustsAt = percentPerHour && percentPerHour > 0 ? current.at + Math.max(0, 100 - current.usedPercent) / percentPerHour * 3600000 : undefined;
  return { samples, percentPerHour, exhaustsAt, stale: now - live.at > 300000, beforeReset: exhaustsAt !== undefined && exhaustsAt < current.resetsAt };
}
export interface BurnDownPoint { at: number; remaining: number }
/** Remaining quota across one reset cycle against an even burn to zero at reset. */
export function quotaBurnDown(ticks: QuotaTick[], current: QuotaTick, now = Date.now(), maxPoints = 240) {
  const duration = quotaWindowDuration(current.label);
  const merged = new Map(ticks.filter(row => sameQuotaWindow(row, current) && row.at <= current.at).map(row => [row.at, row])); merged.set(current.at, current);
  const live = current, settled = settledCurrent(merged, current); current = settled.latest;
  // An idle rolling window reports resetsAt ≈ now + duration, so its derived start can land just after the current sample.
  const start = Math.min(current.at, duration ? current.resetsAt - duration : Math.min(...merged.keys()));
  let samples = settled.samples.filter(row => row.at >= start), correction = -1;
  if (!samples.length) samples = [current];
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
    stale: now - live.at > 300000,
  };
}
