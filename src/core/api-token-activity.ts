import type { ProviderAccountStatus } from '../providers/account-status';
import { periodKey, type UsageFilters } from './usage-dashboard';
import { usageAccount } from './usage-account';

export interface ProviderTokenActivity {
  source: 'API'; status: 'available' | 'unavailable' | 'error'; accountId?: string; updatedAt?: number; detail?: string;
  summary?: { lifetimeTokens?: number; peakDailyTokens?: number; longestRunningTurnSec?: number; currentStreakDays?: number; longestStreakDays?: number };
  daily?: Array<{ day: string; tokens: number }>;
}
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function day(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
/** Whitelist server counts only; missing/null/unsafe values remain unreported. */
export function codexTokenActivity(raw: unknown, accountId?: string, updatedAt = Date.now()): ProviderTokenActivity {
  const value = object(raw), data = object(value.summary), summary: NonNullable<ProviderTokenActivity['summary']> = {};
  for (const key of ['lifetimeTokens', 'peakDailyTokens', 'longestRunningTurnSec', 'currentStreakDays', 'longestStreakDays'] as const) {
    const number = count(data[key]); if (number !== undefined) summary[key] = number;
  }
  const buckets = new Map<string, number>(); let incomplete = false;
  if (Array.isArray(value.dailyUsageBuckets)) for (const raw of value.dailyUsageBuckets) {
    const row = object(raw), tokens = count(row.tokens);
    if (!day(row.startDate) || tokens === undefined) { incomplete = true; continue; }
    const previous = buckets.get(row.startDate);
    if (previous !== undefined && previous !== tokens) { incomplete = true; continue; }
    buckets.set(row.startDate, tokens);
  }
  return { source: 'API', status: Object.keys(summary).length || Array.isArray(value.dailyUsageBuckets) ? 'available' : 'unavailable',
    accountId, updatedAt, summary, ...(Array.isArray(value.dailyUsageBuckets) && !incomplete ? { daily: [...buckets].map(([day, tokens]) => ({ day, tokens })).sort((a, b) => a.day.localeCompare(b.day)) } : {}),
    ...(incomplete ? { detail: 'The API returned incomplete daily buckets; daily totals are unavailable.' } : !Object.keys(summary).length && !Array.isArray(value.dailyUsageBuckets) ? { detail: 'The API did not report token activity for this account.' } : {}) };
}
/** Server activity stays separate from local input/output/model/cost totals. */
export function apiActivityBreakdown(status: ProviderAccountStatus | undefined, filters: UsageFilters) {
  const usage = status?.usage, identity = usageAccount('Codex', status?.account);
  const reason = filters.provider === 'Claude' ? 'No personal-account token activity API is connected for Claude. See Local usage below.'
    : !usage || usage.status !== 'available' ? usage?.detail ?? 'API token activity unavailable.'
    : !identity || !usage?.accountId || identity.id !== usage.accountId ? 'No API token activity matched to the current Codex account.'
    : filters.accountId && filters.accountId !== usage.accountId ? 'API activity is available only for the signed-in Codex account.'
    : undefined;
  if (reason) return { reason, periods: [] as Array<{ key: string; tokens: number; days: number }>, total: undefined };
  const selected = usage!.daily?.filter(row => (!filters.from || row.day >= filters.from) && (!filters.to || row.day <= filters.to));
  const periods = new Map<string, { key: string; tokens: number; days: number }>();
  for (const row of selected ?? []) {
    const key = periodKey(row.day, filters.grouping), value = periods.get(key) ?? { key, tokens: 0, days: 0 };
    value.tokens += row.tokens; value.days++; periods.set(key, value);
  }
  const total = selected?.length ? selected.reduce((sum, row) => sum + row.tokens, 0) : undefined;
  return { usage, periods: [...periods.values()].sort((a, b) => a.key.localeCompare(b.key)), total: total !== undefined && Number.isSafeInteger(total) ? total : undefined,
    reason: undefined };
}
