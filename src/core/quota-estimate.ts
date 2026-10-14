import type { ProviderAccountStatus, QuotaWindow } from '../providers/account-status';
import type { ConversationProvider } from '../providers/conversations';
import type { UsageHistoryData } from './usage-dashboard';
import { usageAccount } from './usage-account';

export interface QuotaEstimate {
  label: '5h' | 'Weekly'; usedPercent?: number; observedTokens?: number;
  tokensPerPercent?: number; capacityTokens?: number; remainingTokens?: number;
  from?: number; to?: number; reason?: string;
}
export type QuotaSource = 'API' | 'Local' | 'Device';
export interface QuotaObservation {
  provider: ConversationProvider; accountId: string; plan: string; label: QuotaEstimate['label'];
  from: number; resetsAt: number; to: number; observedTokens: number; usedPercent: number;
  source?: QuotaSource;
}
export interface QuotaMeter {
  provider: ConversationProvider; accountId: string; plan: string; label: QuotaEstimate['label'];
  from: number; resetsAt: number; to: number; totalTokens: number; usedPercent: number;
}
export interface QuotaBaseline { start: QuotaMeter; latest: QuotaMeter }
export const quotaMeterKey = (row: QuotaMeter | QuotaObservation) => JSON.stringify([row.provider, row.accountId, row.plan, row.label, row.resetsAt]);
/** Account-wide API counters are paired with the same account's quota, never with daily buckets. */
export function quotaMeters(provider: ConversationProvider, account: ProviderAccountStatus | undefined, now = Date.now()): QuotaMeter[] {
  const identity = usageAccount(provider, account?.account), usage = account?.usage;
  const totalTokens = usage?.summary?.lifetimeTokens;
  if (!identity || account?.status !== 'ready' || account.quota?.status !== 'available' || usage?.status !== 'available' || usage.accountId !== identity.id ||
    !Number.isSafeInteger(totalTokens) || totalTokens! < 0 || !usage.updatedAt || !account.updatedAt || account.updatedAt > now || usage.updatedAt > now ||
    now - account.updatedAt > 5 * 60000 || Math.abs(account.updatedAt - usage.updatedAt) > 2 * 60000) return [];
  const to = Math.min(account.updatedAt, usage.updatedAt);
  return ([['5h', 5 * 3600000], ['Weekly', 7 * 86400000]] as const).flatMap(([label, duration]) => {
    const window = account.quota!.windows.find(row => row.label === (label === '5h' ? '5h' : '7d'));
    if (!window?.resetsAt || window.resetsAt <= now || window.resetsAt - duration >= to || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) return [];
    return [{ provider, accountId: identity.id, plan: account.account?.plan ?? '', label, from: window.resetsAt - duration, resetsAt: window.resetsAt, to, totalTokens: totalTokens!, usedPercent: window.usedPercent }];
  });
}
export function observeQuotaMeters(previous: QuotaBaseline[], meters: QuotaMeter[]): { baselines: QuotaBaseline[]; observations: QuotaObservation[] } {
  const baselines = new Map(previous.map(row => [quotaMeterKey(row.start), row]));
  for (const meter of meters) {
    const key = quotaMeterKey(meter), baseline = baselines.get(key);
    if (baseline && meter.to <= baseline.latest.to) continue;
    if (!baseline || meter.totalTokens < baseline.latest.totalTokens || meter.usedPercent < baseline.latest.usedPercent) {
      baselines.set(key, { start: meter, latest: meter }); continue;
    }
    baselines.set(key, { start: baseline.start, latest: meter });
  }
  // Valid persisted pairs remain usable between polls, including after a reload.
  const observations: QuotaObservation[] = [...baselines.values()].flatMap(({ start, latest }) => {
    const observedTokens = latest.totalTokens - start.totalTokens, usedPercent = latest.usedPercent - start.usedPercent;
    return observedTokens > 0 && usedPercent > 0 ? [{ provider: latest.provider, accountId: latest.accountId, plan: latest.plan, label: latest.label,
      from: start.to, resetsAt: latest.resetsAt, to: latest.to, observedTokens, usedPercent, source: 'API' as const }] : [];
  });
  // Completed observations are retained separately; obsolete baseline meters are unnecessary.
  const latest = new Map<string, QuotaBaseline>();
  for (const row of baselines.values()) {
    const key = JSON.stringify([row.start.provider, row.start.accountId, row.start.plan, row.start.label]);
    if (!latest.has(key) || row.latest.to > latest.get(key)!.latest.to) latest.set(key, row);
  }
  return { baselines: [...latest.values()], observations };
}
/** Refreshes replace the same cycle; cumulative snapshots must never be added together. */
export function mergeQuotaObservations(previous: QuotaObservation[], incoming: QuotaObservation[]): QuotaObservation[] {
  const rows = new Map<string, QuotaObservation>();
  for (const row of [...previous, ...incoming]) {
    const key = JSON.stringify([quotaMeterKey(row), row.source ?? 'Local']);
    const existing = rows.get(key);
    if (!existing || row.to > existing.to) rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.to - b.to);
}
export function quotaObservations(provider: ConversationProvider, account: ProviderAccountStatus | undefined, data: UsageHistoryData | undefined, now = Date.now()): QuotaObservation[] {
  const identity = usageAccount(provider, account?.account);
  if (!identity) return [];
  const local = quotaEstimates(provider, account, data, now), device = quotaEstimates(provider, account, data, now, 'Device');
  const estimates: Array<QuotaEstimate & { source?: QuotaSource }> = [...local,
    ...device.filter(estimate => estimate.observedTokens !== local.find(row => row.label === estimate.label)?.observedTokens)
      .map(estimate => ({ ...estimate, source: 'Device' as const }))];
  return estimates.flatMap(estimate => estimate.tokensPerPercent === undefined ? [] : [{
    provider, accountId: identity.id, plan: account?.account?.plan ?? '', label: estimate.label,
    from: estimate.from!, resetsAt: estimate.from! + (estimate.label === '5h' ? 5 * 3600000 : 7 * 86400000),
    to: estimate.to!, observedTokens: estimate.observedTokens!, usedPercent: estimate.usedPercent!,
    ...(estimate.source ? { source: estimate.source } : {}),
  }]);
}
export interface QuotaTrend {
  label: QuotaEstimate['label']; observations: QuotaObservation[]; tokensPerPercent?: number;
  source?: QuotaSource;
  latestTokensPerPercent?: number; baselineTokensPerPercent?: number; changePercent?: number;
}
/** Compare like-for-like accounts, plans and windows, across all projects/models. */
export function quotaTrends(provider: ConversationProvider, account: ProviderAccountStatus | undefined, history: QuotaObservation[]): QuotaTrend[] {
  const identity = usageAccount(provider, account?.account);
  return (['5h', 'Weekly'] as const).map(label => {
    const matched = mergeQuotaObservations([], history).filter(row => row.provider === provider && row.accountId === identity?.id && row.plan === (account?.account?.plan ?? '') && row.label === label);
    const latestReset = Math.max(...matched.map(row => row.resetsAt));
    const current = matched.filter(row => row.resetsAt === latestReset);
    const source = current.some(row => row.source === 'API') ? 'API' : current.some(row => (row.source ?? 'Local') === 'Local') ? 'Local' : 'Device';
    const observations = matched.filter(row => (row.source ?? 'Local') === source);
    const ratio = (rows: QuotaObservation[]) => rows.length ? rows.reduce((sum, row) => sum + row.observedTokens, 0) / rows.reduce((sum, row) => sum + row.usedPercent, 0) : undefined;
    const latest = observations.at(-1), baselineTokensPerPercent = ratio(observations.slice(0, -1));
    const latestTokensPerPercent = latest ? latest.observedTokens / latest.usedPercent : undefined;
    return { label, source, observations, tokensPerPercent: ratio(observations), latestTokensPerPercent, baselineTokensPerPercent,
      ...(latestTokensPerPercent !== undefined && baselineTokensPerPercent ? { changePercent: (latestTokensPerPercent / baselineTokensPerPercent - 1) * 100 } : {}) };
  });
}
export interface QuotaCycle extends QuotaObservation {
  capacityTokens: number; tokensPerPercent: number; changePercent?: number; active: boolean; partial: boolean;
}
/** Reset dates identify cycles; observed tokens remain distinct from extrapolated capacity. */
export function quotaCycles(observations: QuotaObservation[], now = Date.now()): QuotaCycle[] {
  const previous = new Map<string, number>();
  return mergeQuotaObservations([], observations).sort((a, b) => a.resetsAt - b.resetsAt).map(row => {
    const tokensPerPercent = row.observedTokens / row.usedPercent, capacityTokens = tokensPerPercent * 100;
    const key = JSON.stringify([row.provider, row.accountId, row.plan, row.label, row.source ?? 'Local']);
    const prior = previous.get(key); previous.set(key, capacityTokens);
    const cycleStart = row.resetsAt - (row.label === '5h' ? 5 * 3600000 : 7 * 86400000);
    return { ...row, tokensPerPercent, capacityTokens, active: row.resetsAt > now,
      partial: row.from > cycleStart || row.usedPercent < 100,
      ...(prior ? { changePercent: (capacityTokens / prior - 1) * 100 } : {}) };
  });
}
/** An observed local ratio, never a provider-defined token allowance. */
export function quotaEstimates(provider: ConversationProvider, account: ProviderAccountStatus | undefined, data: UsageHistoryData | undefined, now = Date.now(), scope: 'Account' | 'Device' = 'Account'): QuotaEstimate[] {
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
    // Device estimates include unknown native sessions without assigning them an account.
    // Records explicitly attributed to a different account are always excluded.
    const observedTokens = data.recent.filter(row => row.provider === provider && ((!row.accountSource && row.accountId === identity.id) || (scope === 'Device' && (!row.accountId || !!row.accountSource))) && row.timestamp >= from && row.timestamp <= to).reduce((sum, row) => sum + row.total, 0);
    if (!observedTokens) return { ...result, reason: 'No tokens attributed to this account in this window' };
    const tokensPerPercent = observedTokens / window.usedPercent;
    return { ...result, observedTokens, from, to, tokensPerPercent, capacityTokens: tokensPerPercent * 100, remainingTokens: tokensPerPercent * Math.max(0, 100 - window.usedPercent) };
  });
}
