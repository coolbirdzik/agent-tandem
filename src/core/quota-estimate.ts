import type { ProviderAccountStatus, QuotaWindow } from '../providers/account-status';
import type { ConversationProvider } from '../providers/conversations';
import type { UsageHistoryData } from './usage-dashboard';
import { usageAccount } from './usage-account';

export interface QuotaEstimate {
  label: '5h' | 'Weekly'; usedPercent?: number; observedTokens?: number;
  tokensPerPercent?: number; capacityTokens?: number; remainingTokens?: number;
  from?: number; to?: number; reason?: string;
}
export interface QuotaObservation {
  provider: ConversationProvider; accountId: string; plan: string; label: QuotaEstimate['label'];
  from: number; resetsAt: number; to: number; observedTokens: number; usedPercent: number;
}
/** Refreshes replace the same cycle; cumulative snapshots must never be added together. */
export function mergeQuotaObservations(previous: QuotaObservation[], incoming: QuotaObservation[]): QuotaObservation[] {
  const rows = new Map<string, QuotaObservation>();
  for (const row of [...previous, ...incoming]) {
    const key = JSON.stringify([row.provider, row.accountId, row.plan, row.label, row.resetsAt]);
    const existing = rows.get(key);
    if (!existing || row.to > existing.to) rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.to - b.to);
}
export function quotaObservations(provider: ConversationProvider, account: ProviderAccountStatus | undefined, data: UsageHistoryData | undefined, now = Date.now()): QuotaObservation[] {
  const identity = usageAccount(provider, account?.account);
  if (!identity) return [];
  return quotaEstimates(provider, account, data, now).flatMap(estimate => estimate.tokensPerPercent === undefined ? [] : [{
    provider, accountId: identity.id, plan: account?.account?.plan ?? '', label: estimate.label,
    from: estimate.from!, resetsAt: estimate.from! + (estimate.label === '5h' ? 5 * 3600000 : 7 * 86400000),
    to: estimate.to!, observedTokens: estimate.observedTokens!, usedPercent: estimate.usedPercent!,
  }]);
}
export interface QuotaTrend {
  label: QuotaEstimate['label']; observations: QuotaObservation[]; tokensPerPercent?: number;
  latestTokensPerPercent?: number; baselineTokensPerPercent?: number; changePercent?: number;
}
/** Compare like-for-like accounts, plans and windows, across all projects/models. */
export function quotaTrends(provider: ConversationProvider, account: ProviderAccountStatus | undefined, history: QuotaObservation[]): QuotaTrend[] {
  const identity = usageAccount(provider, account?.account);
  return (['5h', 'Weekly'] as const).map(label => {
    const observations = mergeQuotaObservations([], history).filter(row => row.provider === provider && row.accountId === identity?.id && row.plan === (account?.account?.plan ?? '') && row.label === label);
    const ratio = (rows: QuotaObservation[]) => rows.length ? rows.reduce((sum, row) => sum + row.observedTokens, 0) / rows.reduce((sum, row) => sum + row.usedPercent, 0) : undefined;
    const latest = observations.at(-1), baselineTokensPerPercent = ratio(observations.slice(0, -1));
    const latestTokensPerPercent = latest ? latest.observedTokens / latest.usedPercent : undefined;
    return { label, observations, tokensPerPercent: ratio(observations), latestTokensPerPercent, baselineTokensPerPercent,
      ...(latestTokensPerPercent !== undefined && baselineTokensPerPercent ? { changePercent: (latestTokensPerPercent / baselineTokensPerPercent - 1) * 100 } : {}) };
  });
}
/** An observed local ratio, never a provider-defined token allowance. */
export function quotaEstimates(provider: ConversationProvider, account: ProviderAccountStatus | undefined, data: UsageHistoryData | undefined, now = Date.now()): QuotaEstimate[] {
  return ([['5h', 5 * 3600000], ['Weekly', 7 * 86400000]] as const).map(([label, duration]) => {
    const window: QuotaWindow | undefined = account?.quota?.windows.find(row => row.label === (label === '5h' ? '5h' : '7d'));
    const result: QuotaEstimate = { label };
    if (!window || account?.status !== 'ready' || account.quota?.status !== 'available') return { ...result, reason: 'Quota unavailable' };
    result.usedPercent = window.usedPercent;
    const identity = usageAccount(provider, account.account);
    if (!identity) return { ...result, reason: 'Account identity unavailable' };
    if (!window.resetsAt || !account.updatedAt || window.resetsAt <= now || account.updatedAt > now || account.updatedAt < now - 5 * 60000) return { ...result, reason: 'Refresh quota to estimate' };
    if (!data?.recent || Math.abs(account.updatedAt - data.updatedAt) > 2 * 60000) return { ...result, reason: 'Refresh usage and quota together' };
    if (window.usedPercent <= 0 || window.usedPercent > 100 || !Number.isFinite(window.usedPercent)) return { ...result, reason: 'Not enough quota usage yet' };
    const from = window.resetsAt - duration, to = Math.min(account.updatedAt, data.updatedAt, now);
    if (from >= to) return { ...result, reason: 'Quota window has not started' };
    const observedTokens = data.recent.filter(row => row.provider === provider && row.accountId === identity.id && row.timestamp >= from && row.timestamp <= to).reduce((sum, row) => sum + row.total, 0);
    if (!observedTokens) return { ...result, reason: 'No tokens attributed to this account in this window' };
    const tokensPerPercent = observedTokens / window.usedPercent;
    return { ...result, observedTokens, from, to, tokensPerPercent, capacityTokens: tokensPerPercent * 100, remainingTokens: tokensPerPercent * Math.max(0, 100 - window.usedPercent) };
  });
}
