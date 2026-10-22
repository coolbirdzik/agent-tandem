import type { ConversationProvider } from '../providers/conversations';
import type { ProviderAccountStatus } from '../providers/account-status';
import { addApiCost, emptyApiCost, type ApiCost } from './api-pricing';
import { UNKNOWN_ACCOUNT, usageAccount, type UsageAccount } from './usage-account';

export type UsageGrouping = 'day' | 'week' | 'month';
export interface TokenTotals {
  input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number; requests: number;
}
export interface DashboardAccountGroup {
  provider: ConversationProvider; account?: UsageAccount; label?: string; active?: boolean;
  totals: TokenTotals; cost: ApiCost; status?: ProviderAccountStatus;
}
/** Local counts remain separate per provider/identity, including Unknown; live profiles add no tokens. */
export function dashboardAccountGroups(days: UsageDay[], filters: UsageFilters, statuses: Array<{ provider: ConversationProvider; status: ProviderAccountStatus; label?: string; active?: boolean }> = []): DashboardAccountGroup[] {
  const groups = new Map<string, DashboardAccountGroup>(usageBreakdown(days, filters).accounts.map(row => [`${row.provider}\0${row.account?.id ?? UNKNOWN_ACCOUNT}`, row]));
  for (const entry of statuses) {
    const account = usageAccount(entry.provider, entry.status.account);
    if (!account || (filters.provider && filters.provider !== entry.provider) || (filters.accountId && filters.accountId !== account.id)) continue;
    const key = `${entry.provider}\0${account.id}`, existing = groups.get(key);
    groups.set(key, { ...(existing ?? { provider: entry.provider, account, totals: emptyTotals(), cost: emptyApiCost() }),
      status: !existing?.status || (entry.status.updatedAt ?? 0) >= (existing.status.updatedAt ?? 0) ? entry.status : existing.status,
      label: entry.label || existing?.label, active: entry.active || existing?.active });
  }
  return [...groups.values()].sort((a, b) => Number(!!b.active) - Number(!!a.active) || b.totals.total - a.totals.total);
}
export type UsageAccountSource = 'inferred' | 'manual';
export interface UsageDay extends TokenTotals { day: string; provider: ConversationProvider; model: string; cost?: ApiCost; account?: UsageAccount; accountSource?: UsageAccountSource }
export interface RecentUsage { timestamp: number; provider: ConversationProvider; total: number; accountId?: string; accountSource?: UsageAccountSource }
export interface UsageConversation { key: string; id: string; provider: ConversationProvider; project?: string; firstAt: number; lastAt: number; days: UsageDay[] }
export interface UsageHistoryData {
  days: UsageDay[]; updatedAt: number; files: number; unreadableFiles: number; malformedLines: number;
  undatedRecords: number; duplicates: number; oversizedLines: number; timezone: string;
  recent?: RecentUsage[];
  conversations?: UsageConversation[];
  assignments?: import('./usage-attribution-store').UsageAssignment[];
}
export interface UsageDashboardState {
  quotaTicks?: import('./quota-pace').QuotaTick[];
  managedAccounts?: Array<import('./account-profiles').AccountProfile & { status?: ProviderAccountStatus; active?: boolean }>;
  accountsBusy?: boolean; accountsError?: string; accountsNotice?: string;
  accountSwitch?: import('./account-switch').AccountSwitchOperation;
  accountSwitchBlocked?: string;
  attributionBusy?: boolean; attributionError?: string; attributionNotice?: string;
  conversationTitles?: Record<string, string>;
  quotaHistory?: import('./quota-estimate').QuotaObservation[]; quotaHistoryError?: string;
  quotaBaselines?: import('./quota-estimate').QuotaBaseline[];
  storage?: import('./storage').StorageState;
  extensionStorage?: import('./storage-usage').ExtensionStorageUsage;
  conversationCleanup?: import('./conversation-cleanup').ConversationCleanupState;
  storageFreed?: import('./storage-freed').StorageFreed;
  status: 'idle' | 'loading' | 'ready' | 'error'; data?: UsageHistoryData; error?: string;
  accounts?: Partial<Record<ConversationProvider, ProviderAccountStatus>>;
  activeProvider?: ConversationProvider;
  preferences: { showQuotaInStatusBar: boolean; grouping: UsageGrouping; statusBar?: import('./status-bar-preferences').StatusBarPreferences };
}
export interface UsageFilters { provider?: ConversationProvider; accountId?: string; model?: string; from?: string; to?: string; grouping: UsageGrouping }
export const emptyTotals = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, requests: 0 });
export function addTotals(target: TokenTotals, source: TokenTotals) {
  for (const key of Object.keys(target) as Array<keyof TokenTotals>) if (typeof target[key] === 'number') target[key] += source[key];
}
export function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
/** Calendar buckets, in the user's local timezone; weeks start on Monday. */
export function periodKey(day: string, grouping: UsageGrouping): string {
  if (grouping === 'month') return day.slice(0, 7);
  if (grouping === 'day') return day;
  const [year, month, date] = day.split('-').map(Number);
  const value = new Date(year!, month! - 1, date!, 12);
  value.setDate(value.getDate() - (value.getDay() + 6) % 7);
  return localDay(value.getTime());
}
export function usageBreakdown(days: UsageDay[], filters: UsageFilters) {
  const selected = days.filter(row => (!filters.provider || row.provider === filters.provider) && (!filters.model || row.model === filters.model) &&
    (!filters.accountId || (row.account?.id ?? UNKNOWN_ACCOUNT) === filters.accountId) &&
    (!filters.from || row.day >= filters.from) && (!filters.to || row.day <= filters.to));
  const totals = emptyTotals(), cost = emptyApiCost();
  const providers = new Map<string, { totals: TokenTotals; cost: ApiCost }>(), models = new Map<string, { totals: TokenTotals; cost: ApiCost }>();
  const accounts = new Map<string, { provider: ConversationProvider; account?: UsageAccount; totals: TokenTotals; cost: ApiCost }>();
  const periods = new Map<string, { key: string; totals: TokenTotals; cost: ApiCost; Codex: number; Claude: number; models: Map<string, { totals: TokenTotals; cost: ApiCost }> }>();
  for (const row of selected) {
    const rowCost = row.cost ?? { ...emptyApiCost(), unpricedTokens: row.total };
    addTotals(totals, row); addApiCost(cost, rowCost);
    const accountKey = `${row.provider}\0${row.account?.id ?? UNKNOWN_ACCOUNT}`;
    const account = accounts.get(accountKey) ?? { provider: row.provider, account: row.account, totals: emptyTotals(), cost: emptyApiCost() };
    addTotals(account.totals, row); addApiCost(account.cost, rowCost); accounts.set(accountKey, account);
    for (const [map, key] of [[providers, row.provider], [models, `${row.provider}\0${row.model}`]] as const) {
      const value = map.get(key) ?? { totals: emptyTotals(), cost: emptyApiCost() }; addTotals(value.totals, row); addApiCost(value.cost, rowCost); map.set(key, value);
    }
    const key = periodKey(row.day, filters.grouping), period = periods.get(key) ?? { key, totals: emptyTotals(), cost: emptyApiCost(), Codex: 0, Claude: 0, models: new Map() };
    addTotals(period.totals, row); addApiCost(period.cost, rowCost); period[row.provider] += row.total; periods.set(key, period);
    const modelKey = `${row.provider}\0${row.model}`, periodModel = period.models.get(modelKey) ?? { totals: emptyTotals(), cost: emptyApiCost() };
    addTotals(periodModel.totals, row); addApiCost(periodModel.cost, rowCost); period.models.set(modelKey, periodModel);
  }
  return { totals, cost, accounts: [...accounts.values()].sort((a, b) => b.totals.total - a.totals.total), providers: [...providers].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.totals.total - a.totals.total),
    models: modelRows(models), periods: [...periods.values()].map(period => ({ ...period, models: modelRows(period.models) })).sort((a, b) => a.key.localeCompare(b.key)) };
}
function modelRows(models: Map<string, { totals: TokenTotals; cost: ApiCost }>) {
  return [...models].map(([key, value]) => { const [provider, model] = key.split('\0'); return { key, provider: provider as ConversationProvider, model: model!, ...value }; }).sort((a, b) => b.totals.total - a.totals.total);
}
export const MODEL_COLOR_SLOTS = 8;
/** Colors follow the model, not the filtered rank: slots come from all recorded history; the rest share Other (-1). */
export function modelColorSlots(days: UsageDay[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of days) totals.set(`${row.provider}\0${row.model}`, (totals.get(`${row.provider}\0${row.model}`) ?? 0) + row.total);
  const ranked = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return new Map(ranked.map(([key], index) => [key, index < MODEL_COLOR_SLOTS - 1 || ranked.length === MODEL_COLOR_SLOTS ? index : -1]));
}
