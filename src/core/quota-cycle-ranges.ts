import type { ConversationProvider } from '../providers/conversations';
import type { QuotaTick } from './quota-pace';
import type { QuotaObservation } from './quota-estimate';

export type QuotaCycleWindow = '5h' | 'Weekly';
export interface QuotaCycleRange {
  provider: ConversationProvider; accountId: string; window: QuotaCycleWindow;
  /** Usage counts from `from` until `to`; `resetsAt` is the provider's reset, later than `to` after an early reset. */
  from: number; to: number; resetsAt: number; current: boolean; usedPercent?: number;
  /** Known only from saved quota history, without samples that show the reset happening. */
  estimated: boolean;
}
export const QUOTA_CYCLE_DURATION: Record<QuotaCycleWindow, number> = { '5h': 5 * 3600000, Weekly: 7 * 86400000 };
/** Providers re-derive reset times on every poll, so one cycle's reset jitters by up to seconds. */
const SAME_RESET = 120000;

/** Cycles of one account's window, newest first. A cycle runs for its window length up to its reset, and ends
 * early where the next one starts (a banked or purchased reset). Windows never used, such as an idle rolling
 * window whose reset keeps moving, are not cycles. Only resets AgentTandem observed are known. */
export function quotaCycleRanges(provider: ConversationProvider, accountId: string, window: QuotaCycleWindow, ticks: QuotaTick[], observations: QuotaObservation[], now = Date.now()): QuotaCycleRange[] {
  const label = window === '5h' ? '5h' : '7d', duration = QUOTA_CYCLE_DURATION[window];
  const resets = [
    ...ticks.filter(row => row.provider === provider && row.accountId === accountId && row.label === label && row.usedPercent > 0).map(row => ({ at: row.resetsAt, seen: row.at, usedPercent: row.usedPercent as number | undefined, sampled: true })),
    ...observations.filter(row => row.provider === provider && row.accountId === accountId && row.label === window && row.usedPercent > 0).map(row => ({ at: row.resetsAt, seen: row.to, usedPercent: undefined, sampled: false })),
  ].filter(row => Number.isFinite(row.at)).sort((a, b) => a.at - b.at);
  // The latest reading's reset time stands for its group.
  const groups: Array<{ last: number; resetsAt: number; seen: number; usedPercent?: number; sampled: boolean }> = [];
  for (const row of resets) {
    const group = groups.at(-1);
    if (group && row.at - group.last <= SAME_RESET) {
      group.last = row.at; if (row.seen >= group.seen) { group.seen = row.seen; group.resetsAt = row.at; }
      if (row.usedPercent !== undefined) group.usedPercent = Math.max(group.usedPercent ?? 0, row.usedPercent);
      group.sampled ||= row.sampled;
    } else groups.push({ last: row.at, resetsAt: row.at, seen: row.seen, usedPercent: row.usedPercent, sampled: row.sampled });
  }
  const ranges = groups.map(group => ({ resetsAt: group.resetsAt, from: group.resetsAt - duration, to: group.resetsAt, usedPercent: group.usedPercent, estimated: !group.sampled }));
  for (let index = 0; index < ranges.length - 1; index++) ranges[index]!.to = Math.min(ranges[index]!.to, ranges[index + 1]!.from);
  return ranges.filter(range => range.to > range.from && range.from <= now).reverse().map(range => ({
    provider, accountId, window, from: range.from, to: range.to, resetsAt: range.resetsAt, current: range.from <= now && now < range.to, estimated: range.estimated,
    ...(range.usedPercent === undefined ? {} : { usedPercent: range.usedPercent }),
  }));
}
