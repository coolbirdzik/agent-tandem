import { dashboardAccountGroups, emptyTotals, localDay, modelColorSlots, periodKey, usageBreakdown, type TokenTotals, type UsageDashboardState, type UsageFilters, type UsageGrouping } from './core/usage-dashboard';
import type { ProviderAccountStatus } from './providers/account-status';
import type { ConversationProvider } from './providers/conversations';
import { PRICING_CHECKED_AT, PRICING_SOURCES, type ApiCost } from './core/api-pricing';
import { mergeQuotaObservations, observeQuotaMeters, quotaCycles, quotaEstimates, quotaMeters, quotaMeterKey, quotaObservations, quotaTrends } from './core/quota-estimate';
import { UNKNOWN_ACCOUNT, usageAccount, usageAccountLabel } from './core/usage-account';
import { apiActivityBreakdown } from './core/api-token-activity';
import { quotaBurnDown, quotaPace, quotaTicks, quotaWindowDuration } from './core/quota-pace';
import { bankedResetDetails } from './core/banked-resets';
import { quotaStatuses } from './core/quota-status';
import { statusBarPreferences, type StatusBarField, type StatusBarPreferences } from './core/status-bar-preferences';
import { ACCOUNT_PROVIDERS, accountProviderName, accountProviderDetail, isChatAccount, type AccountProvider } from './core/account-providers';
import { validAssignmentScope, type UsageAssignmentScope } from './core/usage-attribution';

declare function acquireVsCodeApi(): { postMessage(value: unknown): void };
const api = acquireVsCodeApi(), send = (type: string, value?: unknown) => api.postMessage({ type, value });
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value;
};
const numberFormat = new Intl.NumberFormat();
const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const moneyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const number = (value: number) => numberFormat.format(value);
const compact = (value: number) => compactFormat.format(value);
const money = (value: number) => moneyFormat.format(value);
const costLabel = (cost: ApiCost) => !cost.pricedTokens && cost.unpricedTokens ? 'Unpriced' : `${money(cost.usd)}${cost.unpricedTokens ? ' + unpriced' : ''}`;
let state: UsageDashboardState | undefined, initialized = false, currentPage = 'dashboard';
let periodLimit = 60, modelSignature = '', accountSignature = '';
const collapsedPeriods = new Set<string>(); let periodsCollapsed = false, modelSlots = new Map<string, number>();
let conversationLimit = 20, selectedUsageConversation: string | undefined;
let accountPlatform: AccountProvider | '' = '';
let observedSwitchId: string | undefined;
function showSwitchDialog() {
  const dialog = el<HTMLDialogElement>('account-switch-dialog');
  if (!dialog.open) { if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); }
}
function hideSwitchDialog() {
  const dialog = el<HTMLDialogElement>('account-switch-dialog');
  if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
  el('account-switch-view').focus();
}
function skeleton(kind = 'line') {
  const item = node('span', undefined, `skeleton skeleton-${kind}`); item.setAttribute('aria-hidden', 'true'); return item;
}
function loadingRows(root: HTMLElement, rows = 4) {
  const list = node('div', undefined, 'skeleton-rows'); list.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < rows; i++) { const row = node('div', undefined, 'skeleton-row'); row.append(skeleton('line'), skeleton('line'), skeleton('line'), skeleton('line')); list.append(row); }
  root.replaceChildren(list);
}
function loadingAccount(root: HTMLElement) {
  root.append(skeleton('line'), skeleton('caption'), skeleton('meter'), skeleton('caption'), skeleton('meter'));
}
function renderLoading() {
  const totals = el('totals'); totals.replaceChildren();
  for (const label of ['Total tokens', 'Input tokens', 'Output tokens', 'Cache read']) {
    const item = node('div', undefined, 'usage-total'); item.append(node('span', label), skeleton('value'), skeleton('caption')); totals.append(item);
  }
  el('api-cost-total').removeAttribute('title'); el('api-cost-total').replaceChildren(skeleton('value'));
  el('api-cost-caption').replaceChildren(skeleton('caption'));
  const parts = el('api-cost-parts'); parts.replaceChildren();
  for (const label of ['Uncached input', 'Cache read', 'Cache write', 'Output']) { const item = node('div'); item.append(node('span', label, 'muted'), skeleton('line')); parts.append(item); }
  const chart = el('usage-chart'); chart.replaceChildren(); chart.dataset.single = 'false';
  const bars = node('div', undefined, 'skeleton-chart'); bars.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 9; i++) bars.append(skeleton('bar')); chart.append(bars);
  el('chart-max').textContent = ''; el('chart-mid').textContent = '';
  el('chart-caption').replaceChildren(skeleton('caption')); loadingRows(el('provider-breakdown'), 2);
  el('chart-legend').replaceChildren(); loadingRows(el('period-breakdown')); loadingRows(el('account-breakdown')); loadingRows(el('conversation-breakdown'));
  el('conversation-detail').hidden = true;
}
function assignmentScope(): UsageAssignmentScope {
  return { provider: el<HTMLSelectElement>('attribution-provider').value as ConversationProvider,
    conversationId: el<HTMLSelectElement>('attribution-conversation').value || undefined,
    from: el<HTMLInputElement>('attribution-from').value || undefined, to: el<HTMLInputElement>('attribution-to').value || undefined };
}
function renderAttributionPreview() {
  const scope = assignmentScope(), valid = validAssignmentScope(scope);
  const days = scope.conversationId ? state?.data?.conversations?.find(row => row.provider === scope.provider && row.id === scope.conversationId)?.days ?? [] : state?.data?.days ?? [];
  const totals = usageBreakdown(days.filter(row => !row.account || !!row.accountSource), { grouping: 'day', provider: scope.provider, from: scope.from, to: scope.to }).totals;
  el('attribution-preview').textContent = valid ? `${number(totals.total)} tokens · ${number(totals.requests)} requests eligible. Only history without native per-turn evidence is reassigned. New history within this scope follows this choice until removed; the latest matching assignment wins.`
    : 'Choose a conversation, or enter both dates for all conversations. Dates are inclusive; leave them blank to cover an entire conversation.';
  el<HTMLButtonElement>('attribution-save').disabled = !state?.data || !!state.attributionBusy || !valid || !el<HTMLSelectElement>('attribution-account').value || !totals.total;
}
function openAttribution(provider: ConversationProvider, conversationId?: string) {
  el<HTMLSelectElement>('attribution-provider').value = provider; renderAttribution();
  el<HTMLSelectElement>('attribution-conversation').value = conversationId ?? '';
  const range = conversationId ? {} : dateRange();
  if (!conversationId) {
    const days = (state?.data?.days ?? []).filter(row => row.provider === provider && (!row.account || !!row.accountSource) &&
      (!range.from || row.day >= range.from) && (!range.to || row.day <= range.to)).map(row => row.day).sort();
    range.from ??= days[0]; range.to ??= days.at(-1);
  }
  el<HTMLInputElement>('attribution-from').value = range.from ?? '';
  el<HTMLInputElement>('attribution-to').value = range.to ?? '';
  renderAttributionPreview(); el<HTMLDetailsElement>('usage-attribution').open = true;
  el('usage-attribution').scrollIntoView?.({ block: 'nearest' }); el('attribution-account').focus();
}
function renderAttribution() {
  const provider = el<HTMLSelectElement>('attribution-provider').value as ConversationProvider;
  const accountSelect = el<HTMLSelectElement>('attribution-account'), previousAccount = accountSelect.value;
  const accounts = new Map<string, string>();
  for (const row of state?.data?.days ?? []) if (row.provider === provider && row.account) accounts.set(row.account.id, usageAccountLabel(row.account));
  const current = usageAccount(provider, state?.accounts?.[provider]?.account);
  if (current) accounts.set(current.id, `${usageAccountLabel(current)} · Active CLI`);
  for (const profile of state?.managedAccounts ?? []) if (profile.provider === provider) {
    const account = usageAccount(provider, profile.status?.account || profile.identity);
    if (account) accounts.set(account.id, `${profile.label} · ${usageAccountLabel(account)}`);
  }
  accountSelect.replaceChildren(new Option('Choose account', ''), new Option('Keep unknown · disable inference', UNKNOWN_ACCOUNT));
  for (const [id, label] of accounts) accountSelect.add(new Option(label, id));
  accountSelect.value = previousAccount === UNKNOWN_ACCOUNT || accounts.has(previousAccount) ? previousAccount : '';
  const conversationSelect = el<HTMLSelectElement>('attribution-conversation'), previousConversation = conversationSelect.value;
  conversationSelect.replaceChildren(new Option('Date range · all conversations', ''));
  for (const row of state?.data?.conversations ?? []) if (row.provider === provider && row.id !== 'unknown') conversationSelect.add(new Option(`${state?.conversationTitles?.[row.key] || row.id} · ${row.project || provider}`, row.id));
  if ([...conversationSelect.options].some(option => option.value === previousConversation)) conversationSelect.value = previousConversation;
  el('attribution-form').setAttribute('aria-busy', String(!!state?.attributionBusy));
  el('attribution-form').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach(input => { input.disabled = !!state?.attributionBusy; });
  el('attribution-status').textContent = state?.attributionBusy ? 'Saving history assignment…' : state?.attributionNotice ?? '';
  el('attribution-error').hidden = !state?.attributionError; el('attribution-error').textContent = state?.attributionError ?? '';
  const list = el('attribution-assignments'); list.replaceChildren();
  for (const row of state?.data?.assignments ?? []) {
    const item = node('div', undefined, 'attribution-assignment'), label = node('span');
    label.textContent = `${row.provider} · ${row.conversationId ? state?.conversationTitles?.[`${row.provider}:${row.conversationId}`] || row.conversationId : 'All conversations'} · ${row.from || 'Start'} – ${row.to || 'No end date'} → ${row.account ? usageAccountLabel(row.account) : 'Keep unknown'} · User confirmed`;
    const remove = node('button', 'Remove assignment', 'quiet'); remove.disabled = !!state?.attributionBusy;
    remove.onclick = () => send('usageAttribution', { action: 'remove', id: row.id }); item.append(label, remove); list.append(item);
  }
  renderAttributionPreview();
}
function attributionCaption(days: NonNullable<UsageDashboardState['data']>['days'], filters: UsageFilters) {
  return ([['inferred', 'Inferred from session evidence'], ['manual', 'User confirmed']] as const).flatMap(([source, label]) => {
    const total = usageBreakdown(days.filter(row => row.accountSource === source), filters).totals.total;
    return total ? [`${label}: ${compact(total)} tokens`] : [];
  }).join(' · ');
}
function page(value: string) {
  currentPage = value;
  el('dashboard').hidden = value !== 'dashboard'; el('preferences').hidden = value !== 'preferences'; el('storage').hidden = value !== 'storage';
  el('managed-accounts').hidden = value !== 'accounts';
  document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.page === value)));
}
document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => { button.onclick = () => { page(button.dataset.page!); if (button.dataset.page === 'storage') send('storage'); if (button.dataset.page === 'accounts') send('accountAction', { action: 'refresh' }); }; });
el('accounts-refresh').onclick = () => send('accountAction', { action: 'refresh' });
el('account-switch-view').onclick = showSwitchDialog;
el('account-switch-close').onclick = hideSwitchDialog;
el('account-switch-dialog').addEventListener('cancel', event => { event.preventDefault(); hideSwitchDialog(); });
function accountConnection(open: boolean) {
  el('account-connection').hidden = !open; el('account-connect').setAttribute('aria-expanded', String(open));
  if (open) { if (accountPlatform) el<HTMLSelectElement>('account-provider').value = accountPlatform; renderAccountConnection(); el('account-provider').focus(); }
}
el('account-connect').onclick = () => accountConnection(el('account-connection').hidden);
el('account-connect-close').onclick = () => { accountConnection(false); el('account-connect').focus(); };
el('account-provider').onchange = renderAccountConnection;
el('account-search').oninput = renderManagedAccounts;
for (const [id, action] of [['account-add', 'add'], ['account-save', 'importCurrent'], ['account-import', 'importFile']]) el(id!).onclick = () => send('accountAction', { action, provider: el<HTMLSelectElement>('account-provider').value });
el('conversation-close').onclick = () => { selectedUsageConversation = undefined; el('conversation-detail').hidden = true; };
el('conversation-search').oninput = () => { conversationLimit = 20; renderConversations(usageFilters()); };
el('attribution-provider').onchange = renderAttribution;
for (const id of ['attribution-conversation', 'attribution-account', 'attribution-from', 'attribution-to']) el(id).onchange = renderAttributionPreview;
el('attribution-form').onsubmit = event => {
  event.preventDefault();
  const scope = assignmentScope(), accountId = el<HTMLSelectElement>('attribution-account').value;
  if (!state?.attributionBusy && validAssignmentScope(scope) && accountId) send('usageAttribution', { action: 'assign', scope, accountId: accountId === UNKNOWN_ACCOUNT ? null : accountId });
};
el('dashboard-view').onchange = () => {
  for (const id of ['filter-account', 'filter-provider', 'filter-model']) el<HTMLSelectElement>(id).value = '';
  renderUsage(); renderAccounts(); renderQuotaEstimates(); renderQuotaPace();
};
el('storage-refresh').onclick = () => send('storage'); el('storage-reveal').onclick = () => send('revealStorage');
el('storage-preview').onclick = () => send('previewCleanup'); el('storage-cancel').onclick = () => send('storage');
el('storage-clean').onclick = () => { if (state?.storage?.plan) send('cleanup', { token: state.storage.plan.token }); };
const selectedHistory = new Set<string>();
let historySignature = '';
let historyPreviewToken: string | undefined;
el('storage-project').onchange = el('storage-kind').onchange = () => renderStorageHistories(state?.storage);
el('storage-select-visible').onclick = () => { for (const group of visibleHistory(state?.storage)) selectedHistory.add(group.id); renderStorageHistories(state?.storage); };
el('storage-clear-selection').onclick = () => { selectedHistory.clear(); renderStorageHistories(state?.storage); };
el('storage-history-preview').onclick = () => send('previewHistoryDeletion', { ids: [...selectedHistory] });
el('storage-history-cancel').onclick = () => send('storage');
el('storage-history-delete').onclick = () => { if (state?.storage?.historyPlan) send('deleteHistory', { token: state.storage.historyPlan.token }); };
el('open-chat').onclick = () => send('chat'); el('manage-clis').onclick = () => send('clis');
el('open-vscode-settings').onclick = () => send('vscodeSettings'); el('refresh').onclick = () => send('refresh');
el<HTMLInputElement>('show-status-quota').onchange = () => { renderStatusBarPreview(); send('preferences', { showQuotaInStatusBar: el<HTMLInputElement>('show-status-quota').checked }); };
for (const [id, key] of [['status-bar-providers', 'providers'], ['status-bar-windows', 'quotaWindows'], ['status-bar-alignment', 'alignment'], ['status-bar-style', 'style']]) {
  el<HTMLSelectElement>(id!).onchange = () => { renderStatusBarPreview(); send('preferences', { statusBar: { [key!]: el<HTMLSelectElement>(id!).value } }); };
}
document.querySelectorAll<HTMLInputElement>('[data-status-field]').forEach(input => {
  input.onchange = () => { renderStatusBarPreview(); send('preferences', { statusBar: { fields: selectedStatusBarFields() } }); };
});
function selectedStatusBarFields(): StatusBarField[] {
  const selected = [...document.querySelectorAll<HTMLInputElement>('[data-status-field]:checked')].map(input => input.dataset.statusField as StatusBarField);
  // Preserve custom field ordering configured in VS Code settings.
  const previous = state?.preferences.statusBar?.fields ?? [];
  return [...previous.filter(field => selected.includes(field)), ...selected.filter(field => !previous.includes(field))];
}
function renderStatusBarPreview() {
  const enabled = el<HTMLInputElement>('show-status-quota').checked, root = el('status-bar-preview'); root.replaceChildren();
  const iconsOnly = el<HTMLSelectElement>('status-bar-style').value === 'icons';
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.status-bar-controls select, [data-status-field]').forEach(input => { input.disabled = !enabled || (iconsOnly && (input.dataset.statusField !== undefined || input.id === 'status-bar-windows')); });
  if (!enabled) { root.append(node('span', 'Status bar hidden', 'muted')); return; }
  const preferences = statusBarPreferences({ providers: el<HTMLSelectElement>('status-bar-providers').value as StatusBarPreferences['providers'], fields: selectedStatusBarFields(), quotaWindows: el<HTMLSelectElement>('status-bar-windows').value as StatusBarPreferences['quotaWindows'], style: el<HTMLSelectElement>('status-bar-style').value as StatusBarPreferences['style'] });
  for (const value of quotaStatuses({ accounts: state?.accounts, composeProvider: state?.activeProvider }, preferences)) {
    const item = node('span', undefined, 'status-bar-preview-item'), icon = node('span', undefined, `codicon codicon-${value.icon}`);
    icon.setAttribute('aria-hidden', 'true'); item.append(icon, document.createTextNode(value.label)); item.title = value.tooltip;
    item.setAttribute('role', 'img'); item.setAttribute('aria-label', value.tooltip); root.append(item);
  }
}
el<HTMLSelectElement>('default-grouping').onchange = () => {
  const grouping = el<HTMLSelectElement>('default-grouping').value;
  el<HTMLSelectElement>('filter-group').value = grouping; renderUsage(); send('preferences', { grouping });
};
for (const id of ['filter-provider', 'filter-account', 'filter-model', 'filter-range', 'filter-group', 'filter-from', 'filter-to']) el(id).onchange = () => { periodLimit = 60; renderUsage(); renderAccounts(); renderQuotaEstimates(); renderQuotaPace(); };
el('reset-filters').onclick = () => {
  for (const id of ['filter-provider', 'filter-account', 'filter-model', 'filter-from', 'filter-to']) el<HTMLInputElement>(id).value = '';
  el<HTMLSelectElement>('filter-range').value = 'today'; el<HTMLSelectElement>('filter-group').value = state?.preferences.grouping ?? 'day';
  el<HTMLSelectElement>('dashboard-view').value = 'accounts';
  periodLimit = 60; renderUsage(); renderAccounts(); renderQuotaEstimates(); renderQuotaPace();
};
function dateRange(): { from?: string; to?: string } {
  const range = el<HTMLSelectElement>('filter-range').value, today = localDay(Date.now());
  el('custom-dates').hidden = range !== 'custom';
  if (range === 'today') return { from: today, to: today };
  if (range === 'week') return { from: periodKey(today, 'week'), to: today };
  if (range === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  if (range === 'year') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  if (range === 'custom') return { from: el<HTMLInputElement>('filter-from').value || undefined, to: el<HTMLInputElement>('filter-to').value || undefined };
  return {};
}
function metric(label: string, value: number, detail: string) {
  const item = node('div', undefined, 'usage-total'), strong = node('strong', compact(value)); strong.title = number(value);
  item.append(node('span', label), strong, node('small', detail)); return item;
}
function renderApiActivity(filters: UsageFilters) {
  const root = el('api-activity'); root.replaceChildren();
  const account = dashboardAccountStatus('Codex');
  if (!state || (filters.provider !== 'Claude' && ((!account && state.status === 'loading') || (account?.status === 'loading' && !account.usage)))) {
    loadingRows(root, 2); return;
  }
  const result = apiActivityBreakdown(account, filters);
  if (result.reason) { root.append(node('p', result.reason, 'muted')); return; }
  const identity = usageAccount('Codex', account?.account), usage = result.usage!, summary = usage.summary;
  root.append(node('p', `Codex · ${usageAccountLabel(identity)} · ${account?.status === 'loading' ? 'Updating · previous snapshot · ' : ''}Updated ${new Date(usage.updatedAt!).toLocaleString()}`, 'muted api-activity-identity'));
  const metrics = node('div', undefined, 'api-activity-metrics');
  for (const [label, value, detail] of [
    ['Selected range tokens', result.total, 'Reported daily buckets only'],
    ['Lifetime tokens', summary?.lifetimeTokens, 'Server account lifetime · independent of date filters'],
    ['Peak daily tokens', summary?.peakDailyTokens, 'Server lifetime peak'],
    ['Longest turn', summary?.longestRunningTurnSec, 'Seconds · server lifetime maximum'],
    ['Current streak', summary?.currentStreakDays, 'Days · current server activity'],
    ['Longest streak', summary?.longestStreakDays, 'Days · server lifetime maximum'],
  ] as const) {
    const item = node('div', undefined, 'api-activity-metric'), amount = node('strong', value === undefined ? '—' : compact(value));
    amount.title = value === undefined ? 'Not reported by API' : number(value);
    item.title = detail;
    item.append(node('span', label, 'muted'), amount);
    if (value === undefined) item.append(node('small', 'Not reported by API', 'muted'));
    metrics.append(item);
  }
  root.append(metrics);
  const details = node('details', undefined, 'usage-details'); details.append(node('summary', 'API details'));
  details.append(node('p', 'Source: API · account/usage/read. Dates use the API timezone, which is unspecified. Missing days are not counted. Model breakdowns and API cost use local history.', 'muted'));
  root.append(details);
  if (filters.model) root.append(node('p', 'Model filter: Local only', 'muted'));
  if (usage.detail) root.append(node('p', usage.detail, 'muted'));
  if (result.periods.length) {
    const rows = node('div', undefined, 'table-wrap');
    table(rows, ['API period', 'Tokens', 'Reported days'], result.periods.slice(-60).reverse().map(row => [row.key, row.tokens, row.days])); details.append(rows);
    if (result.periods.length > 60) details.append(node('p', 'Latest 60 periods shown.', 'muted'));
  } else root.append(node('p', 'No daily buckets were reported for the selected range.', 'muted'));
  details.append(node('p', 'Claude: local token history, native API quota.', 'muted'));
}
function providerIcon(provider: ConversationProvider) {
  const image = node('img', undefined, 'provider-icon'); image.alt = ''; image.dataset.provider = provider;
  image.src = document.body.dataset[`${provider.toLowerCase()}Icon`] ?? ''; return image;
}
function table(root: HTMLElement, headers: string[], rows: Array<Array<string | number>>, firstNumeric = 1) {
  root.replaceChildren();
  if (!rows.length) { root.append(node('p', 'No recorded usage matches these filters.', 'empty')); return; }
  const table = node('table'), head = node('thead'), heading = node('tr'), body = node('tbody');
  headers.forEach((text, index) => { const cell = node('th', text, index >= firstNumeric ? 'numeric' : ''); cell.scope = 'col'; heading.append(cell); });
  head.append(heading);
  for (const row of rows) {
    const line = node('tr');
    row.forEach((value, index) => {
      const cell = node('td', typeof value === 'number' ? compact(value) : value, index >= firstNumeric ? 'numeric' : index === 0 ? headers[0] === 'Model' ? 'model-name' : 'period-name' : '');
      if (typeof value === 'number') cell.title = number(value);
      if (headers[index] === 'API USD') cell.classList.add('numeric');
      if (headers[index] === 'Total') cell.classList.add('total-cell');
      line.append(cell);
    });
    body.append(line);
  }
  table.append(head, body); root.append(table);
}
function renderAccounts() {
  const root = el('accounts'); root.replaceChildren();
  for (const provider of ['Codex', 'Claude'] as const) {
    if (!accountInScope(provider)) continue;
    const status = dashboardAccountStatus(provider), account = status?.account, item = node('article');
    const heading = node('div', undefined, 'dashboard-account-heading'); heading.append(providerIcon(provider), node('span', provider === 'Claude' ? 'Claude Code' : provider));
    if (account?.plan) heading.append(node('span', account.plan.replace(/_/g, ' '), 'muted'));
    item.append(heading, node('div', account?.email || account?.method || (status?.status === 'error' ? 'Account unavailable' : 'Account not loaded'), 'dashboard-account-identity'));
    if ((!state || status?.status === 'loading' || (state.status === 'loading' && !status)) && !account && !status?.quota) {
      item.querySelector('.dashboard-account-identity')!.replaceChildren(skeleton('caption'));
      const loading = node('div', undefined, 'account-windows'); loadingAccount(loading); item.append(loading); root.append(item); continue;
    }
    const windows = node('div', undefined, 'account-windows');
    for (const window of status?.quota?.windows ?? []) {
      const row = node('div', undefined, 'account-window'); row.dataset.low = String(window.usedPercent >= 90);
      const remaining = Math.max(0, 100 - window.usedPercent), label = node('div', undefined, 'account-window-label'); label.append(node('span', window.label), node('span', `${Math.round(remaining * 10) / 10}% left`));
      const meter = node('progress'); meter.max = 100; meter.value = remaining; meter.setAttribute('aria-label', `${provider} ${window.label} quota remaining`);
      row.append(label, meter); if (window.resetsAt) row.append(node('span', `Resets ${new Date(window.resetsAt).toLocaleString()}`, 'muted'));
      windows.append(row);
    }
    for (const line of bankedResetDetails(status?.quota?.bankedResets)) windows.append(node('p', line, 'muted banked-reset-detail'));
    if (!windows.children.length) windows.append(node('span', status?.quota?.detail || status?.error || 'Quota unavailable', 'muted'));
    if (status?.status === 'loading') windows.append(node('span', 'Updating…', 'muted'));
    item.append(windows); root.append(item);
  }
}
function dashboardStatuses() {
  return [...(['Codex', 'Claude'] as const).flatMap(provider => state?.accounts?.[provider] ? [{ provider, status: state.accounts[provider]!, active: true }] : []),
    ...(state?.managedAccounts ?? []).filter(profile => isChatAccount(profile.provider)).map(profile => ({ provider: profile.provider as ConversationProvider, label: profile.label, active: profile.active, status: profile.status ?? { status: 'loading' as const, account: profile.identity } }))];
}
function dashboardGroups(filters: UsageFilters = { grouping: 'day' }) {
  return dashboardAccountGroups(state?.data?.days ?? [], filters, dashboardStatuses());
}
function accountInScope(provider: ConversationProvider) {
  const id = el<HTMLSelectElement>('filter-account').value;
  return !id || dashboardGroups().some(row => row.provider === provider && (row.account?.id ?? UNKNOWN_ACCOUNT) === id);
}
function dashboardAccountStatus(provider: ConversationProvider): ProviderAccountStatus | undefined {
  const id = el<HTMLSelectElement>('filter-account').value;
  if (!id) return state?.accounts?.[provider];
  const group = dashboardGroups().find(row => row.provider === provider && row.account?.id === id);
  if (!group) return undefined;
  if (group.status) return group.status;
  const account = group.account!, plan = [...(state?.quotaHistory ?? [])].reverse().find(row => row.provider === provider && row.accountId === id)?.plan;
  return { status: 'ready', account: { signedIn: true, method: account.method, email: account.email, id: account.nativeAccountId, organization: account.organization, plan } };
}
function scopedQuotaObservations(provider: ConversationProvider, account = dashboardAccountStatus(provider)) {
  const active = usageAccount(provider, state?.accounts?.[provider]?.account)?.id;
  return quotaObservations(provider, account, state?.data).filter(row => row.source !== 'Device' || row.accountId === active);
}
function renderAccountGroups(filters: UsageFilters) {
  const grouped = el<HTMLSelectElement>('dashboard-view').value === 'accounts', selected = !!filters.accountId;
  el('account-overview').hidden = !grouped; el('dashboard-detail').hidden = grouped && !selected;
  const root = el('account-groups'); root.replaceChildren();
  for (const group of dashboardGroups(filters)) {
    const id = group.account?.id ?? UNKNOWN_ACCOUNT, item = node('article', undefined, 'account-group'); item.dataset.provider = group.provider;
    item.dataset.active = String(!!group.active);
    const heading = node('div', undefined, 'managed-account-heading'); heading.append(providerIcon(group.provider), node('h3', group.label || group.account?.email || 'Unknown account'));
    if (group.active) heading.append(node('span', 'Active CLI', 'account-group-state'));
    const identity = node('p', `${group.provider} · ${group.account ? usageAccountLabel(group.account) : 'Unattributed history'}`, 'muted');
    const totals = node('div', undefined, 'account-group-totals'), amount = node('strong', compact(group.totals.total)); amount.title = number(group.totals.total);
    const meta = node('div', undefined, 'account-group-meta');
    meta.append(node('span', 'Local tokens', 'muted'), node('span', `${number(group.totals.requests)} requests · ${costLabel(group.cost)}`, 'muted'));
    totals.append(amount, meta);
    item.append(heading, identity, totals);
    const source = attributionCaption(state?.data?.days ?? [], { ...filters, provider: group.provider, accountId: id });
    if (source) item.append(node('p', source, 'muted'));
    if (!group.account || source) {
      if (!group.account && group.provider === 'Claude') item.append(node('p', 'Claude transcripts without account identity remain unknown. Assign history to the account used for these conversations.', 'muted'));
      const assign = node('button', 'Assign history', 'quiet'); assign.onclick = () => openAttribution(group.provider); item.append(assign);
    }
    const windows = node('div', undefined, 'account-group-windows');
    for (const window of group.status?.quota?.windows ?? []) {
      const row = node('div', undefined, 'account-group-window'), line = node('div');
      line.append(node('span', window.label), node('strong', `${Math.round((100 - window.usedPercent) * 10) / 10}% left`));
      const tick = quotaTicks(group.provider, group.status).find(t => t.windowId === window.id), rate = tick && quotaPace(state?.quotaTicks ?? [], tick).percentPerHour;
      if (rate !== undefined) line.append(node('span', `${number(Math.round(rate * 10) / 10)}% / hour`, 'muted'));
      row.dataset.low = String(window.usedPercent >= 90);
      const meter = node('progress'); meter.max = 100; meter.value = Math.max(0, Math.min(100, 100 - window.usedPercent));
      meter.setAttribute('aria-label', `${group.provider} ${group.label || group.account?.email || 'account'} ${window.label} quota remaining`);
      row.append(line, meter);
      if (window.resetsAt) row.append(node('small', `Resets ${new Date(window.resetsAt).toLocaleString()}`, 'muted'));
      windows.append(row);
    }
    for (const line of bankedResetDetails(group.status?.quota?.bankedResets)) windows.append(node('p', line, 'muted banked-reset-detail'));
    if (!windows.children.length) windows.append(node('small', group.account ? group.status?.quota?.detail || 'No quota snapshot' : 'Quota cannot be assigned to unknown history', 'muted'));
    item.append(windows);
    const open = node('button', selected ? 'Viewing usage' : 'View usage', 'quiet'); open.disabled = selected;
    open.onclick = () => {
      el<HTMLSelectElement>('filter-provider').value = group.provider; el<HTMLSelectElement>('filter-model').value = '';
      renderUsage(); el<HTMLSelectElement>('filter-account').value = id;
      renderUsage(); renderAccounts(); renderQuotaEstimates(); renderQuotaPace(); el('dashboard-detail').scrollIntoView?.({ block: 'start' });
    };
    open.classList.add('account-group-open'); item.append(open); root.append(item);
  }
  if (!filters.provider && !filters.accountId && !filters.model) for (const profile of state?.managedAccounts ?? []) if (!isChatAccount(profile.provider)) {
    const item = node('article', undefined, 'account-group'), heading = node('div', undefined, 'managed-account-heading');
    item.dataset.kind = 'ide';
    heading.append(accountAppIcon(profile.provider), node('h3', profile.label)); if (profile.active) heading.append(node('span', 'Active IDE', 'account-group-state'));
    item.append(heading, node('p', `${profile.provider} · ${profile.status?.account?.email || profile.identity?.email || 'Saved native sign-in'}`, 'muted'), node('p', 'Usage and quota are available in the app.', 'muted'));
    const open = node('button', 'Manage account', 'quiet'); open.classList.add('account-group-open'); open.onclick = () => { accountPlatform = profile.provider; page('accounts'); renderManagedAccounts(); }; item.append(open); root.append(item);
  }
  if (!root.children.length) root.append(node('p', state?.status === 'loading' ? 'Loading accounts…' : 'No account usage in this selection.', 'empty'));
}
function accountAppIcon(provider: AccountProvider) {
  if (isChatAccount(provider)) return providerIcon(provider);
  const mark = node('span', provider === 'Cursor' ? '↗' : 'A', 'account-app-mark'); mark.dataset.provider = provider; mark.setAttribute('aria-hidden', 'true'); return mark;
}
function renderAccountConnection() {
  const provider = el<HTMLSelectElement>('account-provider').value as AccountProvider;
  el('account-add').textContent = isChatAccount(provider) ? 'Sign in' : `Open ${provider}`;
  el('account-connection-detail').textContent = isChatAccount(provider) ? 'Sign in in a separate CLI profile, or save the account you already use.' : `Sign in in ${provider}, then save its current sign-in here. Quota stays in the app.`;
  el('account-import').title = isChatAccount(provider) ? 'Import native CLI account JSON' : 'Import an AgentTandem desktop sign-in JSON';
}
function renderManagedAccounts() {
  const root = el('managed-account-list'); root.replaceChildren();
  const busy = !!state?.accountsBusy;
  for (const id of ['accounts-refresh', 'account-add', 'account-save', 'account-import', 'account-provider', 'account-connect']) el<HTMLButtonElement>(id).disabled = busy;
  el('managed-accounts').setAttribute('aria-busy', String(busy)); renderAccountConnection();
  el('accounts-notice').textContent = busy ? 'Updating accounts…' : state?.accountsError ? '' : state?.accountSwitchBlocked || state?.accountsNotice || '';
  el('accounts-error').hidden = !state?.accountsError; el('accounts-error').textContent = state?.accountsError || '';
  const all = state?.managedAccounts ?? [], platforms = el('account-platforms'); platforms.replaceChildren();
  for (const provider of ['', ...ACCOUNT_PROVIDERS] as const) {
    const button = node('button', undefined, 'account-platform'); button.setAttribute('aria-pressed', String(accountPlatform === provider));
    if (provider) button.append(accountAppIcon(provider)); else { const icon = node('span', undefined, 'codicon codicon-apps'); icon.setAttribute('aria-hidden', 'true'); button.append(icon); }
    button.append(node('span', provider ? accountProviderName(provider) : 'All apps'), node('small', String(all.filter(row => !provider || row.provider === provider).length)));
    button.onclick = () => { accountPlatform = provider; renderManagedAccounts(); if (!el('account-connection').hidden && provider) { el<HTMLSelectElement>('account-provider').value = provider; renderAccountConnection(); } };
    platforms.append(button);
  }
  const search = el<HTMLInputElement>('account-search').value.trim().toLowerCase();
  const profiles = all.filter(row => (!accountPlatform || row.provider === accountPlatform) && (!search || [row.label, row.provider, row.identity?.email, row.status?.account?.email, row.identity?.plan].join(' ').toLowerCase().includes(search))).sort((a, b) => Number(!!b.active) - Number(!!a.active) || a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
  el('account-count').textContent = `${profiles.length}${profiles.length !== all.length ? ` / ${all.length}` : ''}`;
  if (!profiles.length) {
    const empty = node('div', undefined, 'account-empty'); empty.append(node('span', undefined, 'codicon codicon-account'), node('h3', all.length ? 'No matching accounts' : 'Keep your accounts together'), node('p', all.length ? 'Try another app or search.' : 'Add a sign-in or save the account already open in your CLI or editor.', 'muted'));
    const add = node('button', all.length ? 'Clear filters' : 'Add your first account', 'quiet'); add.disabled = busy; add.onclick = () => { if (all.length) { accountPlatform = ''; el<HTMLInputElement>('account-search').value = ''; renderManagedAccounts(); } else accountConnection(true); }; empty.append(add); root.append(empty); return;
  }
  for (const profile of profiles) {
    const item = node('article', undefined, 'managed-account'); item.dataset.active = String(!!profile.active); item.dataset.provider = profile.provider;
    const identity = profile.status?.account || profile.identity;
    const heading = node('div', undefined, 'managed-account-heading'), icon = node('div', undefined, 'account-app-icon'); icon.append(accountAppIcon(profile.provider));
    const copy = node('div', undefined, 'managed-account-copy'); copy.append(node('h3', profile.label), node('span', identity?.email || (identity?.signedIn ? 'Saved native sign-in' : 'Complete sign-in'), 'muted')); heading.append(icon, copy);
    const status = node('span', profile.active ? isChatAccount(profile.provider) ? 'Active CLI' : 'Active IDE' : profile.status?.status === 'error' ? 'Needs attention' : identity?.signedIn ? 'Saved' : 'Not signed in', 'account-state'); status.dataset.state = profile.active ? 'active' : profile.status?.status === 'error' ? 'error' : 'saved'; heading.append(status);
    const meta = node('div', undefined, 'managed-account-meta'); meta.append(node('span', accountProviderName(profile.provider)));
    if (identity?.plan) meta.append(node('span', identity.plan.replace(/_/g, ' '), 'account-plan')); else meta.append(node('span', isChatAccount(profile.provider) ? 'CLI account' : 'Desktop account', 'muted'));
    item.append(heading, meta);
    const windows = node('div', undefined, 'managed-account-quota');
    for (const window of profile.status?.quota?.windows ?? []) {
      const row = node('div'), label = node('span', `${window.label} · ${Math.round((100 - window.usedPercent) * 10) / 10}% left`), meter = node('progress'); meter.max = 100; meter.value = Math.max(0, 100 - window.usedPercent); meter.setAttribute('aria-label', `${profile.label} ${window.label} quota remaining`);
      if (window.resetsAt) label.title = `Resets ${new Date(window.resetsAt).toLocaleString()}`;
      row.append(label, meter);
      const tick = isChatAccount(profile.provider) ? quotaTicks(profile.provider, profile.status).find(t => t.windowId === window.id) : undefined;
      if (tick) { const pace = quotaPace(state?.quotaTicks ?? [], tick); if (pace.percentPerHour !== undefined) row.append(node('small', `${number(Math.round(pace.percentPerHour * 10) / 10)}% / hour`, 'muted')); }
      windows.append(row);
    }
    for (const line of bankedResetDetails(profile.status?.quota?.bankedResets)) windows.append(node('p', line, 'muted banked-reset-detail'));
    if (!windows.children.length) windows.append(node('p', profile.status?.error || (isChatAccount(profile.provider) ? profile.status?.quota?.detail || 'Refresh to check sign-in and quota' : 'Sign-in saved locally · quota in app'), 'muted'));
    item.append(windows);
    const actions = node('div', undefined, 'actions');
    for (const [action, label] of [['switch', profile.active ? 'Active' : 'Switch account'], [isChatAccount(profile.provider) ? 'login' : 'open', isChatAccount(profile.provider) ? 'Sign in' : 'Open app'], ['rename', 'Rename'], ['remove', 'Remove']]) {
      const switching = action === 'switch' && state?.accountSwitch?.status === 'running' && state.accountSwitch.profileId === profile.id;
      const button = node('button', switching ? 'Switching…' : label, action === 'switch' ? '' : 'quiet'); button.disabled = busy || (action === 'switch' && (!!profile.active || !!state?.accountSwitchBlocked));
      if (switching) { const spinner = node('span', undefined, 'codicon codicon-loading account-switch-spinner'); spinner.setAttribute('aria-hidden', 'true'); button.prepend(spinner); }
      button.onclick = () => send('accountAction', { action, id: profile.id });
      if (action === 'switch') button.title = state?.accountSwitchBlocked || (isChatAccount(profile.provider) ? 'Updates the default native CLI sign-in' : 'Close all app windows, switch, then reopen');
      if (action === 'remove') button.classList.add('account-remove');
      actions.append(button);
    }
    item.append(actions); const footer = node('small', profile.status?.updatedAt ? `${profile.status.quotaCached ? 'Cached quota' : 'Checked'} ${new Date(profile.status.updatedAt).toLocaleString()}` : accountProviderDetail(profile.provider), 'account-checked muted'); item.append(footer); root.append(item);
  }
}
function renderAccountSwitch() {
  const operation = state?.accountSwitch; el('account-switch-view').hidden = !operation;
  if (!operation) return;
  const running = operation.status === 'running';
  el('account-switch-view').textContent = running ? 'View switch progress' : 'View switch log';
  const title = operation.status === 'success' ? 'Account switched' : running ? 'Switching account' : operation.outcome === 'switched' ? 'Switched · refresh failed' : 'Switch failed';
  el('account-switch-title').textContent = title;
  el('account-switch-target').textContent = [operation.provider && accountProviderName(operation.provider), operation.label].filter(Boolean).join(' · ');
  el('account-switch-icon').className = `codicon codicon-${running ? 'loading account-switch-spinner' : operation.status === 'success' ? 'check' : 'error'}`;
  el('account-switch-dialog').dataset.status = operation.status;
  el('account-switch-result').textContent = running ? operation.logs.at(-1)?.message || 'Preparing account switch.' : operation.status === 'success' ? operation.notice || 'The default native sign-in has changed.' : operation.outcome === 'restored' ? 'Your previous sign-in was restored.' : operation.outcome === 'notChanged' ? 'The native sign-in was not changed.' : operation.outcome === 'switched' ? 'The sign-in changed. Refresh accounts to update the dashboard.' : operation.outcome === 'recoveryRequired' ? 'Restore failed. Sign in again in the native app.' : 'Check the native sign-in before retrying.';
  el('account-switch-error').hidden = !operation.error; el('account-switch-error').textContent = operation.error || '';
  const log = el('account-switch-log'), wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 28;
  log.replaceChildren();
  for (const entry of operation.logs) {
    const row = node('li'), at = node('time', new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })); at.dateTime = new Date(entry.at).toISOString(); row.dataset.level = entry.level;
    const glyph = node('span', undefined, `codicon codicon-${entry.level === 'success' ? 'check' : entry.level === 'error' ? 'error' : 'circle-small-filled'}`); glyph.setAttribute('aria-hidden', 'true'); row.append(at, glyph, node('span', entry.message)); log.append(row);
  }
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
  el('account-switch-duration').textContent = operation.finishedAt ? `Finished in ${Math.max(0.1, (operation.finishedAt - operation.startedAt) / 1000).toFixed(1)}s` : 'You can hide this window while the switch continues.';
  el('account-switch-close').textContent = running ? 'Hide' : 'Close';
  if (operation.id !== observedSwitchId) { observedSwitchId = operation.id; if (running) showSwitchDialog(); }
}
const svgNode = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>) => {
  const value = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, item] of Object.entries(attributes)) value.setAttribute(key, String(item)); return value;
};
const percent = (value: number) => `${number(Math.round(value * 10) / 10)}%`;
const burnTime = (at: number, long: boolean) => new Date(at).toLocaleString(undefined, long ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
function renderQuotaPace() {
  const root = el('quota-pace'); root.replaceChildren();
  for (const provider of ['Codex', 'Claude'] as const) if (accountInScope(provider)) for (const tick of quotaTicks(provider, dashboardAccountStatus(provider))) {
    const burn = quotaBurnDown(state?.quotaTicks ?? [], tick), pace = quotaPace(state?.quotaTicks ?? [], tick), measured = quotaWindowDuration(tick.label) !== undefined;
    // The cycle average needs a known window start; the last observed hour is the fallback.
    const rate = burn.percentPerHour ?? pace.percentPerHour, exhaustsAt = rate && rate > 0 ? tick.at + burn.remaining / rate * 3600000 : undefined;
    // Extrapolating the first tenth of a cycle overreacts to a single burst, so it informs without warning.
    const early = measured && tick.at - burn.start < (burn.end - burn.start) / 10;
    const beforeReset = !early && exhaustsAt !== undefined && exhaustsAt < burn.end, atReset = rate === undefined ? undefined : Math.max(0, burn.remaining - Math.max(0, rate) * (burn.end - tick.at) / 3600000);
    const long = burn.end - burn.start > 36 * 3600000, span = Math.max(1, burn.end - burn.start), name = provider === 'Claude' ? 'Claude Code' : provider;
    const x = (at: number) => Math.min(1000, Math.max(0, (at - burn.start) / span * 1000)), y = (remaining: number) => 100 - remaining;
    const item = node('article', undefined, 'quota-pace-card'); item.dataset.provider = provider; item.dataset.low = String(beforeReset);
    const heading = node('div', undefined, 'quota-pace-heading'); heading.append(providerIcon(provider), node('span', `${name} · ${tick.label}`)); item.append(heading);
    item.append(node('strong', `${percent(burn.remaining)} left`));
    const verdict = node('p', undefined, 'burn-verdict'), icon = node('span', undefined, 'codicon'); icon.setAttribute('aria-hidden', 'true');
    verdict.dataset.state = rate === undefined || early ? 'pending' : beforeReset ? 'over' : 'ok';
    icon.classList.add(rate === undefined ? 'codicon-history' : early ? 'codicon-info' : beforeReset ? 'codicon-warning' : 'codicon-pass');
    verdict.append(icon, node('span', rate === undefined ? 'Collecting quota samples' : early ? `Early in cycle${exhaustsAt && exhaustsAt < burn.end ? ` · this pace runs out ≈ ${burnTime(exhaustsAt, long)}` : ''}` : beforeReset ? `Runs out ≈ ${burnTime(exhaustsAt!, long)} · before reset` : rate <= 0 ? 'No quota increase observed' : `On track · ≈ ${percent(atReset!)} left at reset`));
    item.append(verdict);
    const facts = [burn.idealRemaining === undefined ? '' : `Even pace ${percent(burn.idealRemaining)} left`, burn.percentPerHour === undefined ? '' : `Cycle ${percent(burn.percentPerHour)} / hour`,
      pace.percentPerHour === undefined ? '' : `Last hour ${percent(pace.percentPerHour)} / hour`].filter(Boolean);
    const detail = node('p', facts.join(' · ') || '—', 'muted burn-facts'); detail.title = 'Measured change in API quota. Includes usage outside this conversation and on other devices.'; item.append(detail);
    const plot = node('div', undefined, 'burn-plot'); plot.setAttribute('role', 'img');
    plot.setAttribute('aria-label', `${name} ${tick.label} burn-down: ${percent(burn.remaining)} left${burn.idealRemaining === undefined ? '' : `, even pace ${percent(burn.idealRemaining)}`}. ${verdict.textContent}`);
    const svg = svgNode('svg', { viewBox: '0 0 1000 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    for (const level of [100, 50]) svg.append(svgNode('line', { x1: 0, x2: 1000, y1: y(level), y2: y(level), class: 'burn-grid' }));
    svg.append(svgNode('line', { x1: 0, x2: 1000, y1: 100, y2: 100, class: 'burn-baseline' }));
    if (measured) svg.append(svgNode('line', { x1: 0, y1: 0, x2: 1000, y2: 100, class: 'burn-ideal' }));
    const first = burn.points[0]!, last = burn.points[burn.points.length - 1]!;
    if (burn.anchored) svg.append(svgNode('line', { x1: 0, y1: 0, x2: x(first.at), y2: y(first.remaining), class: 'burn-assumed' }));
    svg.append(svgNode('polyline', { points: burn.points.map(point => `${x(point.at)},${y(point.remaining)}`).join(' '), class: 'burn-actual' }));
    if (rate && rate > 0) {
      const until = Math.min(exhaustsAt!, burn.end);
      svg.append(svgNode('line', { x1: x(last.at), y1: y(last.remaining), x2: x(until), y2: y(Math.max(0, last.remaining - rate * (until - last.at) / 3600000)), class: 'burn-projection' }));
    }
    const dot = node('span', undefined, 'burn-dot'); dot.style.left = `${x(last.at) / 10}%`; dot.style.top = `${y(last.remaining)}%`;
    const scale = node('span', '100%', 'burn-scale'), cross = node('span', undefined, 'burn-crosshair'), tip = node('span', undefined, 'burn-tooltip'); cross.hidden = tip.hidden = true;
    plot.append(svg, scale, dot, cross, tip);
    plot.onpointermove = event => {
      const box = plot.getBoundingClientRect(), at = burn.start + (event.clientX - box.left) / Math.max(1, box.width) * span;
      const nearest = burn.points.reduce((best, point) => Math.abs(point.at - at) < Math.abs(best.at - at) ? point : best), left = x(nearest.at) / 10;
      tip.replaceChildren(node('strong', burnTime(nearest.at, long)), node('span', `${percent(nearest.remaining)} left`), ...(measured ? [node('span', `Even pace ${percent(100 - (nearest.at - burn.start) / span * 100)}`, 'muted')] : []));
      cross.style.left = tip.style.left = `${left}%`; tip.dataset.side = left > 55 ? 'left' : 'right'; cross.hidden = tip.hidden = false;
    };
    plot.onpointerleave = () => { cross.hidden = tip.hidden = true; };
    const axis = node('div', undefined, 'burn-axis-labels'); axis.append(node('span', measured ? burnTime(burn.start, long) : `Since ${burnTime(burn.start, long)}`), node('span', `Reset ${burnTime(burn.end, long)}`));
    item.append(plot, axis);
    if (burn.stale) item.append(node('small', 'Quota sample is older than 5 minutes', 'muted'));
    root.append(item);
  }
  if (!root.children.length) root.append(node('p', 'Refresh account quota to start measuring.', 'empty'));
}
function usageFilters(): UsageFilters {
  return { ...dateRange(), provider: el<HTMLSelectElement>('filter-provider').value as ConversationProvider || undefined, accountId: el<HTMLSelectElement>('filter-account').value || undefined, model: el<HTMLSelectElement>('filter-model').value || undefined, grouping: el<HTMLSelectElement>('filter-group').value as UsageGrouping };
}
function renderConversations(filters: UsageFilters) {
  const root = el('conversation-breakdown'), query = el<HTMLInputElement>('conversation-search').value.trim().toLowerCase();
  const rows = (state?.data?.conversations ?? []).map(conversation => ({ conversation, result: usageBreakdown(conversation.days, filters), title: state?.conversationTitles?.[conversation.key] || `${conversation.provider} · ${conversation.id === 'unknown' ? 'Unknown conversation' : conversation.id.slice(0, 8)}` }))
    .filter(row => row.result.totals.total > 0 && (!query || `${row.title} ${row.conversation.id} ${row.conversation.project || ''}`.toLowerCase().includes(query)))
    .sort((a, b) => b.result.totals.total - a.result.totals.total);
  table(root, ['Conversation', 'Provider', 'Tokens', 'Requests', 'API USD', 'Last activity'], rows.slice(0, conversationLimit).map(row => [row.title, row.conversation.provider, row.result.totals.total, row.result.totals.requests, costLabel(row.result.cost), new Date(row.conversation.lastAt).toLocaleDateString()]), 2);
  root.querySelectorAll('tbody tr').forEach((line, index) => {
    const row = rows[index]!, cell = line.querySelector('td')!, button = node('button', row.title, 'conversation-link');
    button.title = row.conversation.project || row.conversation.id;
    button.onclick = () => { selectedUsageConversation = row.conversation.key; renderConversations(filters); el('conversation-detail').scrollIntoView?.({ block: 'nearest' }); };
    button.setAttribute('aria-expanded', String(selectedUsageConversation === row.conversation.key)); cell.replaceChildren(button);
  });
  if (rows.length > conversationLimit) { const more = node('button', `Show ${Math.min(20, rows.length - conversationLimit)} more conversations`, 'quiet'); more.onclick = () => { conversationLimit += 20; renderConversations(filters); }; root.append(more); }
  const selected = rows.find(row => row.conversation.key === selectedUsageConversation); el('conversation-detail').hidden = !selected;
  if (!selected) return;
  const { conversation, result } = selected, t = result.totals;
  el('conversation-title').textContent = selected.title;
  el('conversation-meta').textContent = `${conversation.project || conversation.id} · ${new Date(conversation.firstAt).toLocaleString()} → ${new Date(conversation.lastAt).toLocaleString()}`;
  const source = attributionCaption(conversation.days, filters);
  if (source) el('conversation-meta').append(node('span', ` · ${source}`));
  const assign = node('button', 'Assign this conversation', 'quiet'); assign.disabled = conversation.id === 'unknown' || !!state?.attributionBusy;
  assign.onclick = () => openAttribution(conversation.provider, conversation.id); el('conversation-meta').append(assign);
  el('conversation-totals').replaceChildren(metric('Tokens', t.total, `${number(t.requests)} requests`), metric('Input', t.input, `${compact(t.cacheRead)} cache read`), metric('Output', t.output, `${compact(t.reasoning)} reasoning`), metric('API cost', result.cost.usd, 'Estimate'));
  const costValue = el('conversation-totals').lastElementChild?.querySelector('strong'); if (costValue) { costValue.textContent = costLabel(result.cost); costValue.title = `${result.cost.usd.toFixed(6)} USD`; }
  const quotaRoot = el('conversation-quota'); quotaRoot.replaceChildren();
  const elapsed = conversation.lastAt - conversation.firstAt;
  const lifetime = usageBreakdown(conversation.days, { grouping: 'day' }).totals.total;
  if (elapsed >= 60000) { const pace = node('span', `≈ ${compact(lifetime / elapsed * 60000)} tokens / min`, 'muted'); pace.title = 'Lifetime average across the full recorded conversation span, including idle time.'; quotaRoot.append(pace); }
  const accountStatus = dashboardAccountStatus(conversation.provider);
  for (const trend of quotaTrends(conversation.provider, accountStatus, mergeQuotaObservations(state?.quotaHistory ?? [], scopedQuotaObservations(conversation.provider, accountStatus)))) {
    const identity = usageAccount(conversation.provider, accountStatus?.account);
    const matched = result.accounts.length === 1 && result.accounts[0]?.account?.id === identity?.id && !!identity;
    const otherKnownAccount = result.accounts.some(row => row.account && row.account.id !== identity?.id);
    const uncertain = conversation.days.some(row => !!row.accountSource && usageBreakdown([row], filters).totals.total > 0);
    if (trend.tokensPerPercent && ((matched && !uncertain) || (trend.source === 'Device' && !otherKnownAccount))) {
      const estimate = node('span', `≈ ${number(Math.round(t.total / trend.tokensPerPercent * 10) / 10)}% ${trend.label} equivalent`, 'muted');
      estimate.title = `${trend.source} estimate from tokens per 1%. This is not measured per-conversation quota consumption.`; quotaRoot.append(estimate);
    }
  }
  table(el('conversation-models'), ['Model', 'Input', 'Output', 'Cache read', 'Tokens', 'API USD'], result.models.map(row => [row.model, row.totals.input, row.totals.output, row.totals.cacheRead, row.totals.total, costLabel(row.cost)]));
  table(el('conversation-days'), ['Period', 'Tokens', 'Requests', 'API USD'], result.periods.map(row => [row.key, row.totals.total, row.totals.requests, costLabel(row.cost)]));
}
function renderQuotaEstimates() {
  const root = el('quota-estimates'); root.replaceChildren();
  if (state?.quotaHistoryError) root.append(node('p', state.quotaHistoryError, 'quota-history-error'));
  for (const provider of ['Codex', 'Claude'] as const) {
    if (!accountInScope(provider)) continue;
    const item = node('article', undefined, 'quota-estimate-provider'), heading = node('h3');
    heading.append(providerIcon(provider), node('span', provider === 'Claude' ? 'Claude Code' : provider)); item.append(heading);
    const identity = usageAccount(provider, dashboardAccountStatus(provider)?.account);
    if (identity) item.append(node('p', usageAccountLabel(identity), 'muted quota-estimate-account'));
    if (!state || (state.status === 'loading' && !state.data && !state.quotaHistory?.length && !state.quotaBaselines?.length && !quotaMeters(provider, state.accounts?.[provider]).length)) { const loading = node('div'); loadingRows(loading, 2); item.append(loading); root.append(item); continue; }
    const account = dashboardAccountStatus(provider), estimates = quotaEstimates(provider, account, state.data);
    const meters = quotaMeters(provider, account);
    const observed = observeQuotaMeters(state.quotaBaselines ?? [], meters);
    // Render a valid paired sample immediately, even while the host persists it.
    const history = mergeQuotaObservations(state.quotaHistory ?? [], [...scopedQuotaObservations(provider, account), ...observed.observations]);
    for (const trend of quotaTrends(provider, account, history)) {
      const estimate = estimates.find(row => row.label === trend.label)!;
      const meter = meters.find(row => row.label === trend.label);
      const baseline = meter && state.quotaBaselines?.find(row => quotaMeterKey(row.start) === quotaMeterKey(meter));
      const tokenDelta = baseline ? meter!.totalTokens - baseline.start.totalTokens : 0;
      const quotaDelta = baseline ? meter!.usedPercent - baseline.start.usedPercent : 0;
      const waiting = baseline ? tokenDelta > 0 && quotaDelta <= 0 ? 'Waiting for quota to increase' : quotaDelta > 0 && tokenDelta <= 0 ? 'Waiting for API tokens to update' : 'Waiting for new usage'
        : meter ? 'API baseline saved · Waiting for new usage' : estimate.reason === 'No tokens attributed to this account in this window' ? 'No tokens recorded this cycle' : estimate.reason;
      const row = node('div', undefined, 'quota-estimate-row'), label = node('div', undefined, 'quota-estimate-label');
      label.append(node('strong', estimate.label), node('span', estimate.usedPercent === undefined ? '—' : `${estimate.usedPercent}% used`, 'muted')); row.append(label);
      if (trend.tokensPerPercent === undefined) {
        const pending = node('p', waiting, 'muted');
        if (baseline) pending.title = `API baseline saved · ${number(tokenDelta)} new tokens · ${number(quotaDelta)} quota percentage points`;
        row.append(pending);
      }
      else {
        const amount = node('strong', `≈ ${compact(trend.tokensPerPercent)} tokens / 1%`, 'quota-estimate-value'); amount.title = `${number(Math.round(trend.tokensPerPercent))} tokens per percentage point`;
        const source = node('p', `${trend.source === 'Device' ? 'Device estimate' : trend.source} · ${trend.observations.length} ${trend.observations.length === 1 ? 'cycle' : 'cycles'}`, 'muted quota-estimate-source');
        source.title = trend.source === 'API' ? 'API counters · token increase ÷ quota percentage-point increase' : trend.source === 'Device'
          ? 'Local history includes unknown, inferred and user-confirmed sessions. Other accounts with native turn evidence are excluded; usage on other devices is not recorded.' : 'Local · account-matched native turn history';
        row.append(amount, source);
        if (trend.source === 'Device') row.append(node('small', 'Includes history without native turn identity', 'muted'));
        if (trend.changePercent !== undefined) {
          const change = Math.round(trend.changePercent * 10) / 10;
          const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
          const comparison = node('p', `${change > 0 ? '+' : ''}${change}% vs earlier cycles`, 'quota-trend-change');
          comparison.dataset.direction = direction;
          comparison.title = `Earlier cycles: ${number(Math.round(trend.baselineTokensPerPercent!))} tokens / 1%`;
          row.append(comparison);
        }
        const latestApi = trend.source === 'API' && meter ? trend.observations.find(sample => sample.resetsAt === meter.resetsAt && (!baseline || sample.from >= baseline.start.to)) : undefined;
        if (trend.source === 'API') {
          if (latestApi) {
            const rate = latestApi.observedTokens / latestApi.usedPercent;
            row.append(node('p', `≈ ${compact(rate * (100 - meter!.usedPercent))} tokens left`, 'muted'));
          } else row.append(node('p', waiting, 'muted'));
        } else {
          const current = trend.observations.find(sample => sample.resetsAt > Date.now());
          const detail = node('p', current ? `≈ ${compact(current.observedTokens / current.usedPercent * (100 - current.usedPercent))} tokens left` : 'Waiting for current cycle usage', 'muted');
          if (current) detail.title = `${number(current.observedTokens)} tokens from ${new Date(current.from).toLocaleString()} to ${new Date(current.to).toLocaleString()}`;
          row.append(detail);
        }
        const details = node('div', undefined, 'quota-trend-history');
        details.append(node('h4', 'Tokens per reset cycle'));
        const tableRoot = node('div', undefined, 'table-wrap');
        const cycles = quotaCycles(trend.observations).slice(-30).reverse();
        table(tableRoot, ['Reset', 'Recorded', '≈ At 100%', 'vs prev.'], cycles.map(sample => [
          `${new Date(sample.resetsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', ...(sample.label === '5h' ? { hour: '2-digit', minute: '2-digit' } : {}) })}${sample.active ? ' · current' : ''}`,
          sample.observedTokens, Math.round(sample.capacityTokens), sample.changePercent === undefined ? '—' : `${sample.changePercent > 0 ? '+' : ''}${Math.round(sample.changePercent * 10) / 10}%`,
        ]));
        tableRoot.querySelectorAll('tbody tr').forEach((line, index) => {
          const cycle = cycles[index]!;
          line.querySelector('td')!.title = `Reset ${new Date(cycle.resetsAt).toLocaleString()} · ${cycle.partial ? 'Partial observation' : 'Full cycle'} · ${number(cycle.usedPercent)}% quota observed\n${new Date(cycle.from).toLocaleString()} – ${new Date(cycle.to).toLocaleString()}`;
          if (index >= 3) (line as HTMLElement).hidden = true;
        });
        details.append(tableRoot);
        if (cycles.length > 3) {
          const more = node('button', `Show ${cycles.length - 3} more cycles`, 'quiet'); more.setAttribute('aria-expanded', 'false');
          more.onclick = () => {
            const expanded = more.getAttribute('aria-expanded') !== 'true'; more.setAttribute('aria-expanded', String(expanded));
            tableRoot.querySelectorAll<HTMLElement>('tbody tr').forEach((line, index) => { if (index >= 3) line.hidden = !expanded; });
            more.textContent = expanded ? 'Show fewer cycles' : `Show ${cycles.length - 3} more cycles`;
          }; details.append(more);
        }
        if (trend.observations.length > 30) details.title = 'Latest 30 cycles shown; average includes all recorded cycles.';
        row.append(details);
      }
      item.append(row);
    }
    root.append(item);
  }
}
function renderCost(cost: ApiCost) {
  const total = el('api-cost-total'); total.textContent = costLabel(cost); total.title = `${cost.usd.toFixed(6)} USD for priced token usage`;
  el('api-cost-caption').textContent = `Local tokens × API prices${cost.unpricedTokens ? ` · ${compact(cost.unpricedTokens)} unpriced` : ''}`;
  el('api-cost-caption').title = `${number(cost.pricedTokens)} tokens priced · standard API rates`;
  const parts = el('api-cost-parts'); parts.replaceChildren();
  for (const [label, value] of [['Uncached input', cost.inputUsd], ['Cache read', cost.cacheReadUsd], ['Cache write', cost.cacheWriteUsd], ['Output', cost.outputUsd]] as const) {
    const item = node('div'); item.append(node('span', label, 'muted'), node('strong', money(value))); parts.append(item);
  }
}
type UsageResult = ReturnType<typeof usageBreakdown>;
type ModelRow = UsageResult['models'][number];
/** Colors follow the model across filters; models beyond the palette share Other. */
const modelSlot = (key: string) => modelSlots.get(key) ?? -1;
const modelColor = (key: string) => modelSlot(key) >= 0 ? `var(--model-${modelSlot(key) + 1})` : 'var(--model-other)';
const slotOrder = (key: string) => modelSlot(key) < 0 ? Number.MAX_SAFE_INTEGER : modelSlot(key);
const bySlot = (a: ModelRow, b: ModelRow) => slotOrder(a.key) - slotOrder(b.key) || b.totals.total - a.totals.total;
const providerName = (provider: ConversationProvider) => provider === 'Claude' ? 'Claude Code' : provider;
const modelLines = (models: ModelRow[]) => models.map(row => `${row.model} (${providerName(row.provider)}): ${number(row.totals.total)}`).join('\n');
function modelStack(models: ModelRow[]) {
  const stack = node('div', undefined, 'chart-stack'), total = models.reduce((sum, row) => sum + row.totals.total, 0), segments = new Map<string, number>();
  for (const row of models.slice().sort(bySlot)) segments.set(modelColor(row.key), (segments.get(modelColor(row.key)) ?? 0) + row.totals.total);
  // Flex columns stack top-down; the first stable slot sits on the baseline.
  for (const [color, value] of [...segments].reverse()) { const segment = node('div', undefined, 'chart-segment'); segment.style.background = color; segment.style.height = `${total ? value / total * 100 : 0}%`; stack.append(segment); }
  return stack;
}
function swatch(key: string) { const value = node('i', undefined, 'model-swatch'); value.style.background = modelColor(key); value.setAttribute('aria-hidden', 'true'); return value; }
function renderModelLegend(models: ModelRow[], total: number) {
  const root = el('chart-legend'); root.replaceChildren();
  const share = (value: number) => total ? `${Math.round(value / total * 100)}%` : '0%';
  for (const row of models.filter(row => modelSlot(row.key) >= 0).sort(bySlot)) {
    const item = node('span'); item.title = `${row.model} · ${providerName(row.provider)} · ${number(row.totals.total)} tokens`;
    item.append(swatch(row.key), node('span', row.model), node('small', share(row.totals.total))); root.append(item);
  }
  const other = models.filter(row => modelSlot(row.key) < 0);
  if (other.length) {
    const item = node('span'); item.title = modelLines(other);
    item.append(swatch(''), node('span', `${other.length} other ${other.length === 1 ? 'model' : 'models'}`), node('small', share(other.reduce((sum, row) => sum + row.totals.total, 0)))); root.append(item);
  }
}
const periodExpanded = (key: string) => periodsCollapsed ? collapsedPeriods.has(key) : !collapsedPeriods.has(key);
function renderPeriods(periods: UsageResult['periods']) {
  const root = el('period-breakdown'); root.replaceChildren();
  const toggleAll = el('period-toggle-all'); toggleAll.textContent = periodsCollapsed ? 'Expand all' : 'Collapse all'; toggleAll.hidden = !periods.length;
  if (!periods.length) { root.append(node('p', 'No recorded usage matches these filters.', 'empty')); return; }
  const table = node('table', undefined, 'period-table'), head = node('thead'), heading = node('tr'), body = node('tbody');
  ['Period / model', 'Model mix', 'Input', 'Output', 'Cache read', 'Cache write', 'Total', 'Requests', 'API USD'].forEach((text, index) => { const cell = node('th', text, index >= 2 ? 'numeric' : ''); cell.scope = 'col'; heading.append(cell); });
  head.append(heading);
  const numbers = (line: HTMLElement, totals: TokenTotals, cost: ApiCost) => {
    for (const [value, total] of [[totals.input], [totals.output], [totals.cacheRead], [totals.cacheWrite], [totals.total, true], [totals.requests]] as Array<[number, boolean?]>) {
      const cell = node('td', compact(value), `numeric${total ? ' total-cell' : ''}`); cell.title = number(value); line.append(cell);
    }
    line.append(node('td', costLabel(cost), 'numeric'));
  };
  for (const period of periods) {
    const expanded = periodExpanded(period.key), line = node('tr', undefined, 'period-row'), name = node('td', undefined, 'period-name');
    const toggle = node('button', undefined, 'period-toggle'); toggle.setAttribute('aria-expanded', String(expanded));
    const chevron = node('span', undefined, `codicon codicon-chevron-${expanded ? 'down' : 'right'}`); chevron.setAttribute('aria-hidden', 'true');
    toggle.append(chevron, node('span', period.key), node('small', `${period.models.length} ${period.models.length === 1 ? 'model' : 'models'}`, 'muted'));
    toggle.onclick = () => { if (collapsedPeriods.has(period.key)) collapsedPeriods.delete(period.key); else collapsedPeriods.add(period.key); renderUsage(); };
    name.append(toggle); line.append(name);
    const mix = node('td', undefined, 'model-mix-cell'), bar = node('div', undefined, 'model-mix'); bar.title = modelLines(period.models);
    for (const row of period.models.slice().sort(bySlot)) { const segment = node('span'); segment.style.background = modelColor(row.key); segment.style.flexGrow = String(row.totals.total); bar.append(segment); }
    mix.append(bar); line.append(mix); numbers(line, period.totals, period.cost); body.append(line);
    if (expanded) for (const row of period.models) {
      const detail = node('tr', undefined, 'model-row'), model = node('td', undefined, 'model-name'), share = period.totals.total ? row.totals.total / period.totals.total * 100 : 0;
      const label = node('div', undefined, 'model-label'); label.append(swatch(row.key), providerIcon(row.provider), node('span', row.model)); model.append(label); model.title = `${row.model} · ${providerName(row.provider)}`;
      const shareCell = node('td', undefined, 'model-share-cell'), wrap = node('div', undefined, 'model-share-wrap'), meter = node('div', undefined, 'model-share'), fill = node('span');
      fill.style.width = `${share}%`; fill.style.background = modelColor(row.key); meter.append(fill); wrap.append(meter, node('small', `${Math.round(share)}%`, 'muted')); shareCell.append(wrap);
      detail.append(model, shareCell); numbers(detail, row.totals, row.cost); body.append(detail);
    }
  }
  table.append(head, body); root.append(table);
}
el('period-toggle-all').onclick = () => { periodsCollapsed = !periodsCollapsed; collapsedPeriods.clear(); renderUsage(); };
function renderUsage() {
  if (!state || (state.status === 'loading' && !state.data)) {
    const range = dateRange(); renderApiActivity({ ...range, grouping: el<HTMLSelectElement>('filter-group').value as UsageGrouping }); renderLoading(); return;
  }
  const provider = el<HTMLSelectElement>('filter-provider').value as ConversationProvider | '', modelSelect = el<HTMLSelectElement>('filter-model');
  const accountSelect = el<HTMLSelectElement>('filter-account'), previousAccount = accountSelect.value;
  const accounts = new Map<string, string>();
  for (const row of state.data?.days ?? []) if (!provider || row.provider === provider) {
    accounts.set(row.account?.id ?? UNKNOWN_ACCOUNT, row.account ? `${usageAccountLabel(row.account)} · ${row.provider}` : 'Unknown account');
  }
  for (const agent of ['Codex', 'Claude'] as const) if (!provider || agent === provider) {
    const account = usageAccount(agent, state.accounts?.[agent]?.account);
    if (account) accounts.set(account.id, `${usageAccountLabel(account)} · ${agent}`);
  }
  for (const profile of state.managedAccounts ?? []) if (isChatAccount(profile.provider) && (!provider || profile.provider === provider)) {
    const account = usageAccount(profile.provider, profile.status?.account || profile.identity);
    if (account) accounts.set(account.id, `${profile.label} · ${usageAccountLabel(account)} · ${profile.provider}`);
  }
  const accountOptions = [...accounts].sort((a, b) => a[1].localeCompare(b[1])), nextAccountSignature = JSON.stringify(accountOptions);
  if (accountSignature !== nextAccountSignature) {
    accountSignature = nextAccountSignature;
    const allAccounts = node('option', 'All accounts'); allAccounts.value = '';
    accountSelect.replaceChildren(allAccounts, ...accountOptions.map(([id, label]) => { const option = node('option', label); option.value = id; return option; }));
    accountSelect.value = accounts.has(previousAccount) ? previousAccount : '';
  }
  const accountId = accountSelect.value;
  const models = [...new Set(state.data?.days.filter(row => (!provider || row.provider === provider) && (!accountId || (row.account?.id ?? UNKNOWN_ACCOUNT) === accountId)).map(row => row.model) ?? [])].sort();
  const signature = JSON.stringify(models);
  if (modelSignature !== signature) {
    modelSignature = signature; const previous = modelSelect.value;
    const all = node('option', 'All models'); all.value = '';
    modelSelect.replaceChildren(all, ...models.map(model => { const option = node('option', model); option.value = model; return option; }));
    modelSelect.value = models.includes(previous) ? previous : '';
  }
  const range = dateRange(), filters: UsageFilters = { ...range, provider: provider || undefined, accountId: accountId || undefined, model: modelSelect.value || undefined, grouping: el<HTMLSelectElement>('filter-group').value as UsageGrouping };
  renderApiActivity(filters);
  const rangeSelect = el<HTMLSelectElement>('filter-range');
  el('selection-caption').textContent = rangeSelect.value === 'today' ? new Date(Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : rangeSelect.selectedOptions[0]?.textContent ?? '';
  const invalidRange = !!range.from && !!range.to && range.from > range.to;
  el('dashboard-error').hidden = !state.error && !invalidRange;
  el('dashboard-error').textContent = invalidRange ? 'Choose an end date on or after the start date.' : state.error ?? '';
  const result = usageBreakdown(state.data?.days ?? [], filters), t = result.totals;
  renderCost(result.cost);
  el('totals').replaceChildren(metric('Total tokens', t.total, `${number(t.requests)} recorded requests`),
    metric('Input tokens', t.input, `${compact(Math.max(0, t.input - t.cacheRead - t.cacheWrite))} uncached · ${compact(t.cacheWrite)} cache write`),
    metric('Output tokens', t.output, `${compact(t.reasoning)} reasoning tokens included`),
    metric('Cache read', t.cacheRead, `${t.input ? Math.round(t.cacheRead / t.input * 100) : 0}% of input served from cache`));
  modelSlots = modelColorSlots(state.data?.days ?? []);
  const chart = el('usage-chart'); chart.replaceChildren();
  const periods = result.periods.slice(-30), single = rangeSelect.value === 'today'; chart.dataset.single = String(single);
  const max = Math.max(1, ...periods.map(row => single ? Math.max(row.Codex, row.Claude) : row.totals.total));
  el('chart-max').textContent = compact(max); el('chart-mid').textContent = compact(max / 2);
  el('activity-title').textContent = single ? "Today's usage" : 'Token activity';
  if (!periods.length) chart.append(node('p', state.status === 'loading' ? 'Reading local usage history…' : 'No recorded usage for this selection.', 'empty'));
  if (single && periods.length) {
    const row = periods[0]!;
    for (const provider of ['Codex', 'Claude'] as const) {
      if (filters.provider && filters.provider !== provider) continue;
      const label = provider === 'Claude' ? 'Claude Code' : provider, column = node('div', undefined, 'chart-column'), models = row.models.filter(model => model.provider === provider);
      column.title = `${row.key} · ${label}: ${number(row[provider])}\n${modelLines(models)}`; column.setAttribute('role', 'img'); column.setAttribute('aria-label', column.title);
      const bar = modelStack(models); bar.style.height = `${row[provider] / max * 100}%`;
      const value = node('span', compact(row[provider]), 'chart-value'); value.style.bottom = `${row[provider] / max * 100}%`;
      column.append(value, bar, node('span', label, 'chart-date')); chart.append(column);
    }
  } else periods.forEach((row, index) => {
    const column = node('div', undefined, 'chart-column'); column.title = `${row.key} · ${number(row.totals.total)} tokens\n${modelLines(row.models)}`;
    column.setAttribute('role', 'img'); column.setAttribute('aria-label', column.title);
    const stack = modelStack(row.models); stack.style.height = `${row.totals.total / max * 100}%`;
    column.append(stack);
    if (index === 0 || index === periods.length - 1 || index % Math.max(1, Math.ceil(periods.length / 5)) === 0) column.append(node('span', filters.grouping === 'month' ? row.key : row.key.slice(5), 'chart-date'));
    chart.append(column);
  });
  el('chart-caption').textContent = 'Local · ' + (single ? 'Tokens by provider and model · your local day' : result.periods.length > 30 ? `Latest 30 of ${result.periods.length} ${filters.grouping}s · stacked by model · full breakdown below` : `${result.periods.length} ${filters.grouping}${result.periods.length === 1 ? '' : 's'} · stacked by model`);
  renderModelLegend(result.models, t.total);
  const providersRoot = el('provider-breakdown'); providersRoot.replaceChildren();
  for (const provider of ['Codex', 'Claude'] as const) {
    const usage = result.providers.find(row => row.key === provider)?.totals ?? emptyTotals(), percent = t.total ? usage.total / t.total * 100 : 0;
    const row = node('div', undefined, 'provider-row'); row.dataset.provider = provider;
    const label = node('div', undefined, 'provider-row-heading'); label.append(providerIcon(provider), node('span', provider === 'Claude' ? 'Claude Code' : provider), node('strong', `${compact(usage.total)} · ${Math.round(percent)}%`));
    const meter = node('div', undefined, 'provider-meter'), fill = node('span'); fill.style.width = `${percent}%`; meter.append(fill);
    const cost = result.providers.find(row => row.key === provider)?.cost;
    row.append(label, meter, node('span', `${number(usage.requests)} requests · ${cost ? costLabel(cost) : money(0)} API equivalent`, 'muted')); providersRoot.append(row);
  }
  table(el('account-breakdown'), ['Account', 'Provider', 'Input', 'Output', 'Cache read', 'Cache write', 'Total', 'Requests', 'API USD', 'Attribution'], result.accounts.map(row => [usageAccountLabel(row.account), row.provider, row.totals.input, row.totals.output, row.totals.cacheRead, row.totals.cacheWrite, row.totals.total, row.totals.requests, costLabel(row.cost), attributionCaption(state?.data?.days ?? [], { ...filters, provider: row.provider, accountId: row.account?.id ?? UNKNOWN_ACCOUNT }) || (row.account ? 'Native turn evidence' : 'Unknown')]), 2);
  const periodsDescending = result.periods.slice().reverse();
  el('period-title').textContent = `${{ day: 'Daily', week: 'Weekly', month: 'Monthly' }[filters.grouping]} breakdown by model`;
  el('period-caption').textContent = `${filters.grouping === 'week' ? 'Weeks start Monday' : `Calendar ${filters.grouping === 'day' ? 'days' : 'months'} in your local timezone`} · select a period to show or hide its models`;
  renderPeriods(periodsDescending.slice(0, periodLimit));
  if (periodsDescending.length > periodLimit) {
    const more = node('button', `Show ${Math.min(60, periodsDescending.length - periodLimit)} more`, 'quiet'); more.onclick = () => { periodLimit += 60; renderUsage(); }; el('period-breakdown').append(more);
  }
  renderConversations(filters); renderAccountGroups(filters);
}
const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
function visibleHistory(storage: UsageDashboardState['storage']) {
  const project = el<HTMLSelectElement>('storage-project').value, kind = el<HTMLSelectElement>('storage-kind').value;
  return (storage?.histories ?? []).filter(group => (!project || group.projectId === project) && (!kind || group.kind === kind));
}
function renderStorageHistories(storage: UsageDashboardState['storage']) {
  const projectFilter = el<HTMLSelectElement>('storage-project'), kindFilter = el<HTMLSelectElement>('storage-kind');
  const signature = JSON.stringify([storage, [...selectedHistory], projectFilter.value, kindFilter.value]);
  if (signature === historySignature) return;
  historySignature = signature;
  const busy = !storage || ['idle', 'loading', 'cleaning'].includes(storage.status), blocked = busy || !!storage?.cleanupBlocked || !!storage?.error;
  const locked = blocked || !!storage?.historyPlan;
  const groups = storage?.histories ?? [], project = projectFilter.value;
  if (storage?.histories) for (const id of selectedHistory) if (!groups.some(group => group.id === id)) selectedHistory.delete(id);
  projectFilter.replaceChildren(new Option('All projects', ''));
  for (const [id, name] of new Map(groups.map(group => [group.projectId, group.project]))) projectFilter.add(new Option(name, id));
  if ([...projectFilter.options].some(option => option.value === project)) projectFilter.value = project;
  const visible = visibleHistory(storage), selected = groups.filter(group => selectedHistory.has(group.id));
  projectFilter.disabled = kindFilter.disabled = locked;
  el<HTMLButtonElement>('storage-select-visible').disabled = locked || !visible.length;
  el<HTMLButtonElement>('storage-clear-selection').disabled = locked || !selected.length;
  el<HTMLButtonElement>('storage-history-preview').disabled = locked || !selected.length;
  el('storage-selection').textContent = selected.length ? `${selected.length} selected · ${selected.reduce((sum, group) => sum + group.count, 0)} restore points` : 'No history selected';
  const list = el('storage-histories'); list.replaceChildren();
  if (busy && !storage?.histories) loadingRows(list, 3);
  else if (!visible.length) list.append(node('p', groups.length ? 'No restore history matches these filters.' : blocked ? 'Restore history could not be read. Refresh to try again.' : 'No saved restore history yet. New messages in AgentTandem create checkpoints.', 'storage-empty'));
  for (const group of visible) {
    const row = node('label', undefined, 'storage-history-row'), checkbox = node('input');
    checkbox.type = 'checkbox'; checkbox.checked = selectedHistory.has(group.id); checkbox.disabled = locked;
    checkbox.setAttribute('aria-label', `Select ${group.label} in ${group.project}`); checkbox.dataset.historyId = group.id;
    checkbox.onchange = () => {
      if (checkbox.checked) selectedHistory.add(group.id); else selectedHistory.delete(group.id);
      renderStorageHistories(state?.storage);
      document.querySelector<HTMLInputElement>(`input[data-history-id="${group.id}"]`)?.focus();
    };
    const copy = node('span', undefined, 'storage-history-copy');
    copy.append(node('strong', group.label), node('small', group.project), node('small', `${group.kind === 'undo' ? 'Restore backup' : `${group.count} message checkpoint${group.count === 1 ? '' : 's'}`} · Last saved ${new Date(group.updatedAt).toLocaleString()}`));
    const bytes = node('span', fileSize(group.bytes), 'storage-history-size'); bytes.title = 'Referenced snapshot size; shared data may stay after deletion.';
    row.append(checkbox, copy, bytes); list.append(row);
  }
  const preview = storage?.historyPlan; el('storage-history-plan').hidden = !preview;
  el<HTMLButtonElement>('storage-history-delete').disabled = blocked || !preview;
  el<HTMLButtonElement>('storage-history-cancel').disabled = busy;
  if (preview) {
    const count = preview.histories.reduce((sum, group) => sum + group.count, 0);
    el('storage-history-plan-summary').textContent = `${count} restore points · ${fileSize(preview.bytes)} reclaimable · ${preview.files.length} snapshot files`;
    el('storage-history-impact').textContent = 'The selected checkpoints and restore backups will be permanently unavailable. Your code and chat messages stay as they are. Shared data still needed by Review or other checkpoints is kept.';
    const owners = el('storage-history-plan-groups'); owners.replaceChildren();
    for (const group of preview.histories) owners.append(node('li', `${group.project} · ${group.label} · ${group.count} restore points`));
    const files = el('storage-history-plan-files'); files.replaceChildren();
    for (const file of preview.files) files.append(node('li', `${file.relative} · ${fileSize(file.bytes)}`));
    if (!preview.files.length) files.append(node('li', 'These snapshots are shared with retained history or Review. Only the selected restore points will be removed.'));
  }
  if (preview && preview.token !== historyPreviewToken) {
    el('storage-history-plan').scrollIntoView?.({ block: 'nearest' });
    const heading = el('storage-history-plan-heading'); heading.tabIndex = -1; heading.focus({ preventScroll: true });
  }
  historyPreviewToken = preview?.token;
  const result = el('storage-history-result'); result.replaceChildren();
  if (storage?.historyResult) {
    const r = storage.historyResult;
    result.append(node('p', `Deleted ${r.checkpointsRemoved} restore points · ${fileSize(r.bytes)} freed${r.skipped ? ` · ${r.skipped} changed or newly protected files kept` : ''}.`));
    if (r.failures.length) { const failures = node('ul'); for (const failure of r.failures) failures.append(node('li', failure)); result.append(node('p', 'Some data could not be deleted:'), failures); }
  }
}
function renderStorage(storage: UsageDashboardState['storage']) {
  renderStorageHistories(storage);
  const busy = !storage || ['idle', 'loading', 'cleaning'].includes(storage.status);
  el('storage').setAttribute('aria-busy', String(busy));
  el('storage-path').textContent = storage?.root ?? 'Available when connected to the extension';
  el('storage-status').textContent = storage?.status === 'cleaning' ? 'Removing selected storage data…' : busy ? 'Reading AgentTandem storage…' : 'Stored locally on this machine. Select restore history below to review deletion.';
  const error = storage?.error ?? storage?.cleanupBlocked;
  el('storage-error').hidden = !error; el('storage-error').textContent = error ?? '';
  el<HTMLButtonElement>('storage-refresh').disabled = !!storage && ['loading', 'cleaning'].includes(storage.status);
  el<HTMLButtonElement>('storage-preview').disabled = busy || !!error || !storage?.cleanable?.files;
  el<HTMLButtonElement>('storage-clean').disabled = busy || !storage?.plan?.files.length;
  el<HTMLButtonElement>('storage-cancel').disabled = busy;
  const totals = el('storage-totals'); totals.replaceChildren();
  for (const [label, bytes, detail] of [['Total stored', storage?.total, 'AgentTandem extension data only'], ['Safe to clean', storage?.cleanable?.bytes, `${storage?.cleanable?.files ?? 0} unused files · older than 24h`]] as const) {
    const item = node('div', undefined, 'usage-total'); item.append(node('span', label), node('strong', bytes === undefined ? '—' : fileSize(bytes)), node('small', detail)); totals.append(item);
  }
  if (storage?.categories) table(el('storage-categories'), ['Data', 'Size', 'Files'], storage.categories.map(row => [row.label, fileSize(row.bytes), row.files]));
  else loadingRows(el('storage-categories'), 3);
  el('storage-plan').hidden = !storage?.plan;
  if (storage?.plan) {
    el('storage-plan-summary').textContent = `${storage.plan.files.length} files · ${fileSize(storage.plan.bytes)}. References are checked again before cleanup; newly used files are kept.`;
    const files = el('storage-plan-files'); files.replaceChildren();
    for (const file of storage.plan.files) files.append(node('li', `${file.relative} · ${fileSize(file.bytes)}`));
  }
  const result = el('storage-result'); result.replaceChildren();
  if (storage?.result) {
    const r = storage.result; result.append(node('p', `Cleaned ${r.removed} files · ${fileSize(r.bytes)} freed${r.skipped ? ` · ${r.skipped} changed or newly protected files kept` : ''}.`));
    if (r.failures.length) { const list = node('ul'); for (const failure of r.failures) list.append(node('li', failure)); result.append(node('p', `${r.failures.length} files could not be removed:`), list); }
  }
}
let usageRenderSignature = '';
function render(value: UsageDashboardState) {
  renderStorage(value.storage);
  state = value;
  if (!initialized) { initialized = true; el<HTMLSelectElement>('filter-group').value = value.preferences.grouping; }
  el<HTMLInputElement>('show-status-quota').checked = value.preferences.showQuotaInStatusBar;
  const statusBar = statusBarPreferences(value.preferences.statusBar);
  el<HTMLSelectElement>('status-bar-providers').value = statusBar.providers;
  el<HTMLSelectElement>('status-bar-windows').value = statusBar.quotaWindows;
  el<HTMLSelectElement>('status-bar-alignment').value = statusBar.alignment;
  el<HTMLSelectElement>('status-bar-style').value = statusBar.style;
  document.querySelectorAll<HTMLInputElement>('[data-status-field]').forEach(input => { input.checked = statusBar.fields.includes(input.dataset.statusField as StatusBarField); });
  renderStatusBarPreview();
  el<HTMLSelectElement>('default-grouping').value = value.preferences.grouping;
  el<HTMLButtonElement>('refresh').disabled = value.status === 'loading';
  el('dashboard').setAttribute('aria-busy', String(value.status === 'loading'));
  el('dashboard').dataset.loading = String(value.status === 'loading');
  el('dashboard-status').textContent = value.status === 'loading' ? 'Reading local CLI history…' : value.data ? `Updated ${new Date(value.data.updatedAt).toLocaleString()} · ${value.data.timezone}` : 'Usage history has not been loaded.';
  renderManagedAccounts(); renderAccountSwitch(); renderAttribution();
  const signature = JSON.stringify([value.status, value.data && { ...value.data, recent: undefined }, value.error,
    value.accounts?.Codex?.account, value.accounts?.Claude?.account, value.conversationTitles]);
  // Account/quota updates need estimates, but leave history tables and filters intact.
  if (signature !== usageRenderSignature) { usageRenderSignature = signature; renderUsage(); }
  else renderApiActivity({ ...dateRange(), provider: el<HTMLSelectElement>('filter-provider').value as ConversationProvider || undefined,
    accountId: el<HTMLSelectElement>('filter-account').value || undefined, model: el<HTMLSelectElement>('filter-model').value || undefined,
    grouping: el<HTMLSelectElement>('filter-group').value as UsageGrouping });
  renderAccounts(); renderQuotaEstimates(); renderQuotaPace(); renderAccountGroups(usageFilters());
  const root = el('usage-coverage'), coverage = node('details', undefined, 'usage-details');
  coverage.append(node('summary', 'Data & pricing details')); root.replaceChildren(coverage);
  coverage.append(node('div', 'Local usage includes saved history across projects, archived sessions and subagents. Other devices and deleted history are excluded. Input includes cache; output includes reported reasoning.'));
  coverage.append(node('div', 'Native turn evidence takes priority. Codex creator IDs, Claude bridge owners and consistent Claude response identities can infer an account for other history in the same session; inferred sessions may include account switches. When a provider has only one known account on this device, history without evidence is inferred for it. User-confirmed assignments can replace inference and can be removed. Unmatched history stays under Unknown account. Local quota estimates use native evidence only; Device estimates also include inferred, user-confirmed and unknown history.'));
  const pricing = node('div', `API equivalent uses published standard global token rates checked ${PRICING_CHECKED_AT}, not historical invoices. Prompt-length premiums are estimated per response; older session-wide billing cannot be reconstructed. Fast modes, tool fees, taxes and regional premiums are excluded. Unspecified Claude cache writes use the 5-minute rate. Sources: `);
  for (const provider of ['Codex', 'Claude'] as const) { const link = node('a', provider === 'Codex' ? 'OpenAI API pricing' : 'Claude API pricing'); link.href = PRICING_SOURCES[provider]; pricing.append(link, document.createTextNode(' ')); }
  coverage.append(pricing);
  if (value.data) {
    const d = value.data, skipped = d.unreadableFiles + d.malformedLines + d.oversizedLines + d.undatedRecords;
    coverage.append(node('div', `${number(d.files)} history files · ${number(d.duplicates)} repeated response records counted once${skipped ? ` · Incomplete coverage: ${d.unreadableFiles} unreadable files, ${d.malformedLines} malformed lines, ${d.oversizedLines} oversized lines, ${d.undatedRecords} undated usage records` : ''}`));
  }
  page(currentPage);
}
window.addEventListener('message', event => {
  if (event.data?.type === 'state') render(event.data.state);
  if (event.data?.type === 'dashboard') page('dashboard');
  if (event.data?.type === 'page' && ['storage', 'accounts'].includes(event.data.page)) page(event.data.page);
});
el('dashboard').setAttribute('aria-busy', 'true'); el('dashboard').dataset.loading = 'true';
el('dashboard-status').textContent = 'Reading local CLI history…'; el<HTMLButtonElement>('refresh').disabled = true;
renderAccounts(); renderUsage(); renderQuotaEstimates();
send('ready');
