import type { ConversationProvider } from '../providers/conversations';
import type { QuotaTick } from './quota-pace';

/** One running cycle per account/window. A full-quota reading, not a forecast reset, anchors it. */
export interface QuotaCycleStart {
  provider: ConversationProvider; accountId: string; plan: string; label: '5h' | 'Weekly';
  from: number; startUsedPercent: number; to: number; usedPercent: number;
}
export const quotaCycleScope = (row: Pick<QuotaCycleStart, 'provider' | 'accountId' | 'plan' | 'label'>) => JSON.stringify([row.provider, row.accountId, row.plan, row.label]);

export function observeQuotaCycleStarts(previous: QuotaCycleStart[], ticks: QuotaTick[]): QuotaCycleStart[] {
  const rows = new Map(previous.map(row => [quotaCycleScope(row), { ...row }]));
  for (const tick of [...ticks].sort((a, b) => a.at - b.at)) {
    if (tick.label !== '5h' && tick.label !== '7d') continue;
    const identity = { provider: tick.provider, accountId: tick.accountId, plan: tick.plan, label: tick.label === '5h' ? '5h' as const : 'Weekly' as const };
    const key = quotaCycleScope(identity), prior = rows.get(key);
    if (prior && tick.at <= prior.to) continue;
    // Repeated full readings advance the start to the last observed 100%.
    // Without a full reading, retain an honest partial baseline instead of inventing one.
    const restart = !prior || tick.usedPercent === 0 || tick.usedPercent < prior.startUsedPercent;
    rows.set(key, { ...identity, from: restart ? tick.at : prior.from, startUsedPercent: restart ? tick.usedPercent : prior.startUsedPercent,
      to: tick.at, usedPercent: tick.usedPercent });
  }
  return [...rows.values()];
}
