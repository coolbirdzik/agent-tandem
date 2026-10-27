import type { ProviderAccountStatus, QuotaWindow } from '../providers/account-status';
import type { ConversationProvider } from '../providers/conversations';
import type { UsageHistoryData } from './usage-dashboard';
import { usageAccount } from './usage-account';
import { quotaCycleScope, type QuotaCycleStart } from './quota-cycle-start';

export interface QuotaEstimate {
  label: '5h' | 'Weekly'; usedPercent?: number; observedTokens?: number;
  tokensPerPercent?: number; capacityTokens?: number; remainingTokens?: number;
  from?: number; to?: number; reason?: string;
  cycleStartedAt?: number; cycleStartKnown?: boolean; startUsedPercent?: number;
}
export type QuotaSource = 'API' | 'Local' | 'Device';
export interface QuotaObservation {
  provider: ConversationProvider; accountId: string; plan: string; label: QuotaEstimate['label'];
  from: number; resetsAt: number; to: number; observedTokens: number; usedPercent: number;
  source?: QuotaSource;
  /** Quota already used when recording began. Missing on older API observations. */
  startUsedPercent?: number;
  cycleStartedAt?: number; cycleStartKnown?: boolean;
}
export interface QuotaMeter {
  provider: ConversationProvider; accountId: string; plan: string; label: QuotaEstimate['label'];
  from: number; resetsAt: number; to: number; totalTokens: number; usedPercent: number;
  cycleStartedAt?: number; cycleStartKnown?: boolean;
}
export interface QuotaBaseline { start: QuotaMeter; latest: QuotaMeter }
export const quotaMeterKey = (row: QuotaMeter | QuotaObservation) => JSON.stringify([row.provider, row.accountId, row.plan, row.label, row.resetsAt]);
const quotaScopeKey = (row: QuotaMeter | QuotaObservation) => JSON.stringify([row.provider, row.accountId, row.plan, row.label]);
/** Captured cycles follow the last full reading; reset matching is only for legacy samples. */
export function sameQuotaCycle(a: QuotaMeter | QuotaObservation, b: QuotaMeter | QuotaObservation): boolean {
  return quotaScopeKey(a) === quotaScopeKey(b) && (a.cycleStartedAt !== undefined || b.cycleStartedAt !== undefined
    ? a.cycleStartedAt === b.cycleStartedAt : Math.abs(a.resetsAt - b.resetsAt) <= 120000);
}
/** Account-wide API counters are paired with the same account's quota, never with daily buckets. */
export function quotaMeters(provider: ConversationProvider, account: ProviderAccountStatus | undefined, now = Date.now(), cycleStarts?: QuotaCycleStart[]): QuotaMeter[] {
  const identity = usageAccount(provider, account?.account), usage = account?.usage;
  const totalTokens = usage?.summary?.lifetimeTokens;
  if (!identity || account?.status !== 'ready' || account.quotaCached || account.quota?.status !== 'available' || usage?.status !== 'available' || usage.accountId !== identity.id ||
    !Number.isSafeInteger(totalTokens) || totalTokens! < 0 || !usage.updatedAt || !account.updatedAt || account.updatedAt > now || usage.updatedAt > now ||
    now - account.updatedAt > 5 * 60000 || Math.abs(account.updatedAt - usage.updatedAt) > 2 * 60000) return [];
  const to = Math.min(account.updatedAt, usage.updatedAt);
  return ([['5h', 5 * 3600000], ['Weekly', 7 * 86400000]] as const).flatMap(([label, duration]) => {
    const window = account.quota!.windows.find(row => row.label === (label === '5h' ? '5h' : '7d'));
    if (!window?.resetsAt || window.resetsAt <= now || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) return [];
    const scope = { provider, accountId: identity.id, plan: account.account?.plan ?? '', label };
    const start = cycleStarts?.find(row => quotaCycleScope(row) === quotaCycleScope(scope) && row.from <= to);
    return [{ ...scope, from: Math.min(window.resetsAt - duration, to - 1), resetsAt: window.resetsAt, to, totalTokens: totalTokens!, usedPercent: window.usedPercent,
      ...(start ? { cycleStartedAt: start.from, cycleStartKnown: start.startUsedPercent === 0 } : {}) }];
  });
}
export function observeQuotaMeters(previous: QuotaBaseline[], meters: QuotaMeter[]): { baselines: QuotaBaseline[]; observations: QuotaObservation[] } {
  const baselines = [...previous];
  for (const meter of meters) {
    const index = baselines.findIndex(row => sameQuotaCycle(row.start, meter)), baseline = baselines[index];
    if (baseline && meter.to <= baseline.latest.to) continue;
    if (!baseline || meter.totalTokens < baseline.latest.totalTokens || meter.usedPercent < (meter.cycleStartedAt === undefined ? baseline.latest.usedPercent : baseline.start.usedPercent)) {
      const next = { start: meter, latest: meter };
      if (index < 0) baselines.push(next); else baselines[index] = next;
      continue;
    }
    baselines[index] = { start: baseline.start, latest: meter };
  }
  // Valid persisted pairs remain usable between polls, including after a reload.
  const observations: QuotaObservation[] = baselines.flatMap(({ start, latest }) => {
    const observedTokens = latest.totalTokens - start.totalTokens, usedPercent = latest.usedPercent - start.usedPercent;
    return observedTokens > 0 && usedPercent > 0 ? [{ provider: latest.provider, accountId: latest.accountId, plan: latest.plan, label: latest.label,
      from: start.to, resetsAt: latest.resetsAt, to: latest.to, observedTokens, usedPercent, startUsedPercent: start.usedPercent, source: 'API' as const,
      ...(latest.cycleStartedAt === undefined ? {} : { cycleStartedAt: latest.cycleStartedAt, cycleStartKnown: latest.cycleStartKnown }) }] : [];
  });
  // Completed observations are retained separately; obsolete baseline meters are unnecessary.
  const latest = new Map<string, QuotaBaseline>();
  for (const row of baselines) {
    const key = JSON.stringify([row.start.provider, row.start.accountId, row.start.plan, row.start.label]);
    if (!latest.has(key) || row.latest.to > latest.get(key)!.latest.to) latest.set(key, row);
  }
  return { baselines: [...latest.values()], observations };
}
/** Refreshes replace the same cycle; cumulative snapshots must never be added together. */
export function mergeQuotaObservations(previous: QuotaObservation[], incoming: QuotaObservation[]): QuotaObservation[] {
  const groups = new Map<string, QuotaObservation[]>();
  for (const row of [...previous, ...incoming].sort((a, b) => a.to - b.to)) {
    const key = JSON.stringify([quotaScopeKey(row), row.source ?? 'Local']);
    const rows = groups.get(key) ?? [];
    const index = rows.findIndex(existing => sameQuotaCycle(existing, row)), existing = rows[index];
    if (!existing || row.to > existing.to || (row.to === existing.to && row.from === existing.from &&
      row.observedTokens === existing.observedTokens && row.usedPercent === existing.usedPercent &&
      existing.startUsedPercent === undefined && row.startUsedPercent !== undefined)) {
      if (index < 0) rows.push(row); else rows[index] = row;
    }
    groups.set(key, rows);
  }
  return [...groups.values()].flat().sort((a, b) => a.to - b.to);
}
export function quotaObservations(provider: ConversationProvider, account: ProviderAccountStatus | undefined, data: UsageHistoryData | undefined, now = Date.now(), cycleStarts?: QuotaCycleStart[]): QuotaObservation[] {
  const identity = usageAccount(provider, account?.account);
  if (!identity) return [];
  const local = quotaEstimates(provider, account, data, now, 'Account', cycleStarts), device = quotaEstimates(provider, account, data, now, 'Device', cycleStarts);
  const estimates: Array<QuotaEstimate & { source?: QuotaSource }> = [...local,
    ...device.filter(estimate => estimate.observedTokens !== local.find(row => row.label === estimate.label)?.observedTokens)
      .map(estimate => ({ ...estimate, source: 'Device' as const }))];
  return estimates.flatMap(estimate => estimate.tokensPerPercent === undefined ? [] : [{
    provider, accountId: identity.id, plan: account?.account?.plan ?? '', label: estimate.label,
    from: estimate.from!, resetsAt: account!.quota!.windows.find(row => row.label === (estimate.label === '5h' ? '5h' : '7d'))!.resetsAt!,
    to: estimate.to!, observedTokens: estimate.observedTokens!, usedPercent: estimate.usedPercent! - (estimate.startUsedPercent ?? 0),
    ...(estimate.cycleStartedAt === undefined ? {} : { cycleStartedAt: estimate.cycleStartedAt, cycleStartKnown: estimate.cycleStartKnown, startUsedPercent: estimate.startUsedPercent }),
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
    const latestObservation = matched.at(-1);
    const current = matched.filter(row => latestObservation && sameQuotaCycle(row, latestObservation));
    const source = current.some(row => row.source === 'API') ? 'API' : current.some(row => (row.source ?? 'Local') === 'Local') ? 'Local' : 'Device';
    const sourceRows = matched.filter(row => (row.source ?? 'Local') === source);
    // Forecast-based legacy samples must not double-count cycles captured from a real baseline.
    const observations = sourceRows.some(row => row.cycleStartedAt !== undefined) ? sourceRows.filter(row => row.cycleStartedAt !== undefined) : sourceRows;
    const ratio = (rows: QuotaObservation[]) => rows.length ? rows.reduce((sum, row) => sum + row.observedTokens, 0) / rows.reduce((sum, row) => sum + row.usedPercent, 0) : undefined;
    const latest = observations.at(-1), baselineTokensPerPercent = ratio(observations.slice(0, -1));
    const latestTokensPerPercent = latest ? latest.observedTokens / latest.usedPercent : undefined;
    return { label, source, observations, tokensPerPercent: ratio(observations), latestTokensPerPercent, baselineTokensPerPercent,
      ...(latestTokensPerPercent !== undefined && baselineTokensPerPercent ? { changePercent: (latestTokensPerPercent / baselineTokensPerPercent - 1) * 100 } : {}) };
  });
}
export interface QuotaCycle extends QuotaObservation {
  capacityTokens: number; tokensPerPercent: number; changePercent?: number; active: boolean; partial: boolean;
  remainingFrom?: number; remainingTo?: number;
}
/** Cycle identities follow observed starts. Forecast reset dates are display metadata. */
export function quotaCycles(observations: QuotaObservation[], now = Date.now(), currentReset?: number, currentCycleStartedAt?: number): QuotaCycle[] {
  const previous = new Map<string, number>();
  const rows = mergeQuotaObservations([], observations), latest = new Map<string, QuotaObservation>();
  const scope = (row: QuotaObservation) => JSON.stringify([quotaScopeKey(row), row.source ?? 'Local']);
  for (const row of rows) if (row.to <= now) latest.set(scope(row), row);
  return rows.map(row => {
    const tokensPerPercent = row.observedTokens / row.usedPercent, capacityTokens = tokensPerPercent * 100;
    const key = JSON.stringify([row.provider, row.accountId, row.plan, row.label, row.source ?? 'Local']);
    const prior = previous.get(key); previous.set(key, capacityTokens);
    const cycleStart = row.resetsAt - (row.label === '5h' ? 5 * 3600000 : 7 * 86400000);
    // Forecast-derived legacy intervals never prove a 100% reading.
    const startUsedPercent = row.startUsedPercent;
    return { ...row, tokensPerPercent, capacityTokens, active: row.from <= now && latest.get(scope(row)) === row && (currentCycleStartedAt !== undefined
      ? row.cycleStartedAt === currentCycleStartedAt : row.cycleStartedAt !== undefined ||
      (row.resetsAt > now && (currentReset === undefined || Math.abs(row.resetsAt - currentReset) <= 120000))),
      partial: row.cycleStartedAt !== undefined ? !row.cycleStartKnown || row.startUsedPercent !== 0 || row.usedPercent < 100 : row.from > cycleStart || row.usedPercent < 100,
      ...(startUsedPercent === undefined ? {} : { remainingFrom: 100 - startUsedPercent, remainingTo: Math.max(0, 100 - startUsedPercent - row.usedPercent) }),
      ...(prior ? { changePercent: (capacityTokens / prior - 1) * 100 } : {}) };
  });
}
/** An observed local ratio, never a provider-defined token allowance. */
export function quotaEstimates(provider: ConversationProvider, account: ProviderAccountStatus | undefined, data: UsageHistoryData | undefined, now = Date.now(), scope: 'Account' | 'Device' = 'Account', cycleStarts?: QuotaCycleStart[]): QuotaEstimate[] {
  return ([['5h', 5 * 3600000], ['Weekly', 7 * 86400000]] as const).map(([label, duration]) => {
    const window: QuotaWindow | undefined = account?.quota?.windows.find(row => row.label === (label === '5h' ? '5h' : '7d'));
    const result: QuotaEstimate = { label };
    if (!window || account?.status !== 'ready' || account.quota?.status !== 'available') return { ...result, reason: 'Quota unavailable' };
    if (account.quotaCached) return { ...result, reason: 'Refresh quota to estimate' };
    result.usedPercent = window.usedPercent;
    const identity = usageAccount(provider, account.account);
    if (!identity) return { ...result, reason: 'Account identity unavailable' };
    if (!window.resetsAt || !account.updatedAt || window.resetsAt <= now || account.updatedAt > now || account.updatedAt < now - 5 * 60000) return { ...result, reason: 'Refresh quota to estimate' };
    if (!data?.recent || Math.abs(account.updatedAt - data.updatedAt) > 2 * 60000) return { ...result, reason: 'Refresh usage and quota together' };
    if (window.usedPercent <= 0 || window.usedPercent > 100 || !Number.isFinite(window.usedPercent)) return { ...result, reason: 'Not enough quota usage yet' };
    const to = Math.min(account.updatedAt, data.updatedAt, now);
    const cycle = cycleStarts?.find(row => quotaCycleScope(row) === quotaCycleScope({ provider, accountId: identity.id, plan: account.account?.plan ?? '', label }) && row.from <= to);
    if (cycleStarts && !cycle) return { ...result, reason: 'Waiting for quota cycle sample' };
    const from = cycle?.from ?? window.resetsAt - duration, usedPercent = window.usedPercent - (cycle?.startUsedPercent ?? 0);
    if (cycle) Object.assign(result, { cycleStartedAt: cycle.from, cycleStartKnown: cycle.startUsedPercent === 0, startUsedPercent: cycle.startUsedPercent });
    if (usedPercent <= 0) return { ...result, reason: cycle?.startUsedPercent ? 'Cycle start not observed · collecting new usage' : 'Not enough quota usage yet' };
    if (from >= to) return { ...result, reason: 'Quota window has not started' };
    // Device estimates include unknown native sessions without assigning them an account.
    // Records explicitly attributed to a different account are always excluded.
    const observedTokens = data.recent.filter(row => row.provider === provider && ((!row.accountSource && row.accountId === identity.id) || (scope === 'Device' && (!row.accountId || !!row.accountSource))) && (cycle ? row.timestamp > from : row.timestamp >= from) && row.timestamp <= to).reduce((sum, row) => sum + row.total, 0);
    if (!observedTokens) return { ...result, reason: 'No tokens attributed to this account in this window' };
    const tokensPerPercent = observedTokens / usedPercent;
    return { ...result, observedTokens, from, to, tokensPerPercent, capacityTokens: tokensPerPercent * 100, remainingTokens: tokensPerPercent * Math.max(0, 100 - window.usedPercent) };
  });
}
