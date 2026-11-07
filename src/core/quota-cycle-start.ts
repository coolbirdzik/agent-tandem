import type { ConversationProvider } from '../providers/conversations';
import type { QuotaTick } from './quota-pace';

/** One running cycle per account/window. A full-quota reading, not a forecast reset, anchors it. */
export interface QuotaCycleStart {
  provider: ConversationProvider; accountId: string; plan: string; label: '5h' | 'Weekly';
  from: number; startUsedPercent: number; to: number; usedPercent: number;
  /** The latest reading's reset time. Missing on cycle starts saved by older versions. */
  resetsAt?: number;
}
export const quotaCycleScope = (row: Pick<QuotaCycleStart, 'provider' | 'accountId' | 'plan' | 'label'>) => JSON.stringify([row.provider, row.accountId, row.plan, row.label]);

const windowDuration = { '5h': 5 * 3600000, Weekly: 7 * 86400000 } as const;
/** Reset times jitter by seconds between polls. */
const resetJitter = 120000;
export function observeQuotaCycleStarts(previous: QuotaCycleStart[], ticks: QuotaTick[]): QuotaCycleStart[] {
  const rows = new Map(previous.map(row => [quotaCycleScope(row), { ...row }]));
  for (const tick of [...ticks].sort((a, b) => a.at - b.at)) {
    if (tick.label !== '5h' && tick.label !== '7d') continue;
    const identity = { provider: tick.provider, accountId: tick.accountId, plan: tick.plan, label: tick.label === '5h' ? '5h' as const : 'Weekly' as const };
    const key = quotaCycleScope(identity), prior = rows.get(key);
    if (prior && tick.at <= prior.to) continue;
    // Repeated full readings advance the start to the last observed 100%.
    // Without a full reading, retain an honest partial baseline instead of inventing one.
    // A reset can also pass without a 0% reading, for example while the account was not read or when the next request
    // came before the next reading. A reading past the last known reset, or in a window that began after the last
    // reading, then starts a partial cycle. After a 0% reading the window that starts is this cycle's own, and a
    // forecast reset moving later puts the window's start in the future, so neither restarts.
    const windowStart = Number.isFinite(tick.resetsAt) ? tick.resetsAt - windowDuration[identity.label] : NaN;
    const unseenReset = !!prior && prior.usedPercent > 0 && ((prior.resetsAt !== undefined && tick.at > prior.resetsAt + resetJitter) ||
      (windowStart > prior.to + resetJitter && windowStart <= tick.at));
    const restart = !prior || unseenReset || tick.usedPercent === 0 || tick.usedPercent < prior.startUsedPercent;
    // A late reading from before a reset must not pull the known reset back.
    const resetsAt = Number.isFinite(tick.resetsAt) ? (restart || prior?.resetsAt === undefined ? tick.resetsAt : Math.max(prior.resetsAt, tick.resetsAt)) : prior?.resetsAt;
    rows.set(key, { ...identity, from: restart ? tick.at : prior.from, startUsedPercent: restart ? tick.usedPercent : prior.startUsedPercent,
      to: tick.at, usedPercent: tick.usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) });
  }
  return [...rows.values()];
}
