import { emptyTotals, localDay, periodKey, usageBreakdown, type TokenTotals, type UsageDashboardState, type UsageFilters, type UsageGrouping } from './core/usage-dashboard';
import type { ConversationProvider } from './providers/conversations';
import { PRICING_CHECKED_AT, PRICING_SOURCES, type ApiCost } from './core/api-pricing';
import { mergeQuotaObservations, quotaEstimates, quotaObservations, quotaTrends } from './core/quota-estimate';
import { UNKNOWN_ACCOUNT, usageAccount, usageAccountLabel } from './core/usage-account';
import { apiActivityBreakdown } from './core/api-token-activity';

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
  loadingRows(el('period-breakdown')); loadingRows(el('model-breakdown')); loadingRows(el('account-breakdown'));
}
function page(value: string) {
  currentPage = value;
  el('dashboard').hidden = value !== 'dashboard'; el('preferences').hidden = value !== 'preferences'; el('storage').hidden = value !== 'storage';
  document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.page === value)));
}
document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => { button.onclick = () => { page(button.dataset.page!); if (button.dataset.page === 'storage') send('storage'); }; });
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
el<HTMLInputElement>('show-status-quota').onchange = () => send('preferences', { showQuotaInStatusBar: el<HTMLInputElement>('show-status-quota').checked });
el<HTMLSelectElement>('default-grouping').onchange = () => {
  const grouping = el<HTMLSelectElement>('default-grouping').value;
  el<HTMLSelectElement>('filter-group').value = grouping; renderUsage(); send('preferences', { grouping });
};
for (const id of ['filter-provider', 'filter-account', 'filter-model', 'filter-range', 'filter-group', 'filter-from', 'filter-to']) el(id).onchange = () => { periodLimit = 60; renderUsage(); };
el('reset-filters').onclick = () => {
  for (const id of ['filter-provider', 'filter-account', 'filter-model', 'filter-from', 'filter-to']) el<HTMLInputElement>(id).value = '';
  el<HTMLSelectElement>('filter-range').value = 'today'; el<HTMLSelectElement>('filter-group').value = state?.preferences.grouping ?? 'day';
  periodLimit = 60; renderUsage();
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
  const account = state?.accounts?.Codex;
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
    item.append(node('span', label, 'muted'), amount, node('small', value === undefined ? 'Not reported by API' : detail, 'muted')); metrics.append(item);
  }
  root.append(metrics);
  const note = node('p', 'Source: API · account/usage/read. API dates are shown as returned; the API does not specify their timezone. Selected range sums reported buckets only; missing days are not assumed to be zero. Model/input/output/cache breakdowns and API cost are Local estimates below.', 'muted');
  root.append(note);
  if (filters.model) root.append(node('p', 'The model filter applies only to Local usage; this API does not report an account-wide model breakdown.', 'muted'));
  if (usage.detail) root.append(node('p', usage.detail, 'muted'));
  if (result.periods.length) {
    const rows = node('div', undefined, 'table-wrap');
    table(rows, ['API period', 'Tokens', 'Reported days'], result.periods.slice(-60).reverse().map(row => [row.key, row.tokens, row.days])); root.append(rows);
    if (result.periods.length > 60) root.append(node('p', `Latest 60 of ${result.periods.length} reported periods; selected range total includes all returned periods.`, 'muted'));
  } else root.append(node('p', 'No daily buckets were reported for the selected range.', 'muted'));
  root.append(node('p', 'Claude personal-account token activity API is not connected. Claude token breakdowns below come from Local history; subscription quota comes from the native usage API.', 'muted'));
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
    const status = state?.accounts?.[provider], account = status?.account, item = node('article');
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
    if (!windows.children.length) windows.append(node('span', status?.quota?.detail || status?.error || 'Quota unavailable', 'muted'));
    if (status?.status === 'loading') windows.append(node('span', 'Updating…', 'muted'));
    item.append(windows); root.append(item);
  }
}
function renderQuotaEstimates() {
  const root = el('quota-estimates'); root.replaceChildren();
  if (state?.quotaHistoryError) root.append(node('p', state.quotaHistoryError, 'quota-history-error'));
  for (const provider of ['Codex', 'Claude'] as const) {
    const item = node('article', undefined, 'quota-estimate-provider'), heading = node('h3');
    heading.append(providerIcon(provider), node('span', provider === 'Claude' ? 'Claude Code' : provider)); item.append(heading);
    const identity = usageAccount(provider, state?.accounts?.[provider]?.account);
    if (identity) item.append(node('p', usageAccountLabel(identity), 'muted quota-estimate-account'));
    if (!state || (state.status === 'loading' && !state.data && !state.quotaHistory?.length)) { const loading = node('div'); loadingRows(loading, 2); item.append(loading); root.append(item); continue; }
    const account = state.accounts?.[provider], estimates = quotaEstimates(provider, account, state.data);
    const history = mergeQuotaObservations(state.quotaHistory ?? [], quotaObservations(provider, account, state.data));
    for (const trend of quotaTrends(provider, account, history)) {
      const estimate = estimates.find(row => row.label === trend.label)!;
      const row = node('div', undefined, 'quota-estimate-row'), label = node('div', undefined, 'quota-estimate-label');
      label.append(node('strong', estimate.label), node('span', estimate.usedPercent === undefined ? '—' : `${estimate.usedPercent}% used`, 'muted')); row.append(label);
      if (trend.tokensPerPercent === undefined) row.append(node('p', estimate.reason, 'muted'));
      else {
        const amount = node('strong', `≈ ${compact(trend.tokensPerPercent)} tokens / 1%`, 'quota-estimate-value'); amount.title = `${number(Math.round(trend.tokensPerPercent))} tokens per percentage point`;
        row.append(amount, node('p', `All observed cycles · ${trend.observations.length} ${trend.observations.length === 1 ? 'cycle' : 'cycles'} · All projects & models`, 'muted'));
        row.append(node('p', `Latest cycle ≈ ${compact(trend.latestTokensPerPercent!)} tokens / 1%`, 'quota-trend-latest'));
        if (trend.changePercent === undefined) row.append(node('p', 'Collecting baseline · Compare after another quota cycle', 'muted'));
        else {
          const change = Math.round(trend.changePercent * 10) / 10;
          const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
          const comparison = node('p', `${change > 0 ? '+' : ''}${change}% vs earlier cycles · ${change > 0 ? 'More' : change < 0 ? 'Fewer' : 'Same'} tokens per 1%`, 'quota-trend-change');
          comparison.dataset.direction = direction;
          comparison.title = `Earlier cycles: ${number(Math.round(trend.baselineTokensPerPercent!))} tokens / 1%`;
          row.append(comparison);
        }
        if (estimate.tokensPerPercent !== undefined) {
          const detail = node('p', `Current cycle · ≈ ${compact(estimate.capacityTokens!)} at 100% · ≈ ${compact(estimate.remainingTokens!)} left`, 'muted');
          detail.title = `${number(estimate.observedTokens!)} local tokens from ${new Date(estimate.from!).toLocaleString()} to ${new Date(estimate.to!).toLocaleString()}`;
          row.append(detail);
        } else row.append(node('p', `Current cycle · ${estimate.reason}`, 'muted'));
        const latest = trend.observations.at(-1)!;
        row.append(node('p', `Last observed ${new Date(latest.to).toLocaleString()}`, 'muted'));
        const details = node('details', undefined, 'quota-trend-history');
        details.append(node('summary', `Cycle history · ${trend.observations.length} observations`));
        const tableRoot = node('div', undefined, 'table-wrap');
        table(tableRoot, ['Last observed', 'Tokens / 1%', 'Tokens', 'Used %'], trend.observations.slice(-30).reverse().map(sample => [
          new Date(sample.to).toLocaleString(), Math.round(sample.observedTokens / sample.usedPercent), sample.observedTokens, sample.usedPercent,
        ]));
        details.append(tableRoot);
        if (trend.observations.length > 30) details.append(node('p', 'Latest 30 cycles shown; the average includes all recorded cycles.', 'muted'));
        row.append(details);
      }
      item.append(row);
    }
    root.append(item);
  }
}
function renderCost(cost: ApiCost) {
  const total = el('api-cost-total'); total.textContent = costLabel(cost); total.title = `${cost.usd.toFixed(6)} USD for priced token usage`;
  el('api-cost-caption').textContent = `Estimate · Local tokens × API prices · ${compact(cost.pricedTokens)} tokens priced${cost.unpricedTokens ? ` · ${compact(cost.unpricedTokens)} unpriced tokens excluded` : ''} · standard API rates`;
  const parts = el('api-cost-parts'); parts.replaceChildren();
  for (const [label, value] of [['Uncached input', cost.inputUsd], ['Cache read', cost.cacheReadUsd], ['Cache write', cost.cacheWriteUsd], ['Output', cost.outputUsd]] as const) {
    const item = node('div'); item.append(node('span', label, 'muted'), node('strong', money(value))); parts.append(item);
  }
}
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
      const label = provider === 'Claude' ? 'Claude Code' : provider, column = node('div', undefined, 'chart-column');
      column.title = `${row.key}\n${label}: ${number(row[provider])}`; column.setAttribute('role', 'img'); column.setAttribute('aria-label', column.title);
      const bar = node('div', undefined, `chart-stack chart-${provider.toLowerCase()}`); bar.style.height = `${row[provider] / max * 100}%`;
      const value = node('span', compact(row[provider]), 'chart-value'); value.style.bottom = `${row[provider] / max * 100}%`;
      column.append(value, bar, node('span', label, 'chart-date')); chart.append(column);
    }
  } else periods.forEach((row, index) => {
    const column = node('div', undefined, 'chart-column'); column.title = `${row.key}\nCodex: ${number(row.Codex)}\nClaude Code: ${number(row.Claude)}\nTotal: ${number(row.totals.total)}`;
    column.setAttribute('role', 'img'); column.setAttribute('aria-label', column.title);
    const stack = node('div', undefined, 'chart-stack'); stack.style.height = `${row.totals.total / max * 100}%`;
    for (const provider of ['Codex', 'Claude'] as const) { const bar = node('div', undefined, `chart-${provider.toLowerCase()}`); bar.style.height = `${row.totals.total ? row[provider] / row.totals.total * 100 : 0}%`; stack.append(bar); }
    column.append(stack);
    if (index === 0 || index === periods.length - 1 || index % Math.max(1, Math.ceil(periods.length / 5)) === 0) column.append(node('span', filters.grouping === 'month' ? row.key : row.key.slice(5), 'chart-date'));
    chart.append(column);
  });
  el('chart-caption').textContent = 'Local · ' + (single ? 'Tokens by provider · your local day' : result.periods.length > 30 ? `Latest 30 of ${result.periods.length} ${filters.grouping}s · full breakdown below` : `${result.periods.length} ${filters.grouping}${result.periods.length === 1 ? '' : 's'}`);
  const providersRoot = el('provider-breakdown'); providersRoot.replaceChildren();
  for (const provider of ['Codex', 'Claude'] as const) {
    const usage = result.providers.find(row => row.key === provider)?.totals ?? emptyTotals(), percent = t.total ? usage.total / t.total * 100 : 0;
    const row = node('div', undefined, 'provider-row'); row.dataset.provider = provider;
    const label = node('div', undefined, 'provider-row-heading'); label.append(providerIcon(provider), node('span', provider === 'Claude' ? 'Claude Code' : provider), node('strong', `${compact(usage.total)} · ${Math.round(percent)}%`));
    const meter = node('div', undefined, 'provider-meter'), fill = node('span'); fill.style.width = `${percent}%`; meter.append(fill);
    const cost = result.providers.find(row => row.key === provider)?.cost;
    row.append(label, meter, node('span', `${number(usage.requests)} requests · ${cost ? costLabel(cost) : money(0)} API equivalent`, 'muted')); providersRoot.append(row);
  }
  const headers = ['Model', 'Provider', 'Input', 'Output', 'Cache read', 'Cache write', 'Total', 'Requests', 'API USD'];
  table(el('account-breakdown'), ['Account', 'Provider', 'Input', 'Output', 'Cache read', 'Cache write', 'Total', 'Requests', 'API USD'], result.accounts.map(row => [usageAccountLabel(row.account), row.provider, row.totals.input, row.totals.output, row.totals.cacheRead, row.totals.cacheWrite, row.totals.total, row.totals.requests, costLabel(row.cost)]), 2);
  table(el('model-breakdown'), headers, result.models.map(row => [row.model, row.provider, row.totals.input, row.totals.output, row.totals.cacheRead, row.totals.cacheWrite, row.totals.total, row.totals.requests, costLabel(row.cost)]), 2);
  const periodsDescending = result.periods.slice().reverse();
  el('period-title').textContent = `${{ day: 'Daily', week: 'Weekly', month: 'Monthly' }[filters.grouping]} breakdown`;
  el('period-caption').textContent = filters.grouping === 'week' ? 'Weeks start Monday' : filters.grouping === 'day' ? 'Calendar days in your local timezone' : 'Calendar months in your local timezone';
  table(el('period-breakdown'), ['Period', 'Codex', 'Claude', 'Input', 'Output', 'Cache read', 'Cache write', 'Total', 'Requests', 'API USD'], periodsDescending.slice(0, periodLimit).map(row => [row.key, row.Codex, row.Claude, row.totals.input, row.totals.output, row.totals.cacheRead, row.totals.cacheWrite, row.totals.total, row.totals.requests, costLabel(row.cost)]));
  if (periodsDescending.length > periodLimit) {
    const more = node('button', `Show ${Math.min(60, periodsDescending.length - periodLimit)} more`, 'quiet'); more.onclick = () => { periodLimit += 60; renderUsage(); }; el('period-breakdown').append(more);
  }
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
  el<HTMLSelectElement>('default-grouping').value = value.preferences.grouping;
  el<HTMLButtonElement>('refresh').disabled = value.status === 'loading';
  el('dashboard').setAttribute('aria-busy', String(value.status === 'loading'));
  el('dashboard').dataset.loading = String(value.status === 'loading');
  el('dashboard-status').textContent = value.status === 'loading' ? 'Reading local CLI history…' : value.data ? `Updated ${new Date(value.data.updatedAt).toLocaleString()} · ${value.data.timezone}` : 'Usage history has not been loaded.';
  renderAccounts(); renderQuotaEstimates();
  const signature = JSON.stringify([value.status, value.data && { ...value.data, recent: undefined }, value.error,
    value.accounts?.Codex?.account, value.accounts?.Claude?.account]);
  // Account/quota updates need estimates, but leave history tables and filters intact.
  if (signature !== usageRenderSignature) { usageRenderSignature = signature; renderUsage(); }
  else renderApiActivity({ ...dateRange(), provider: el<HTMLSelectElement>('filter-provider').value as ConversationProvider || undefined,
    accountId: el<HTMLSelectElement>('filter-account').value || undefined, model: el<HTMLSelectElement>('filter-model').value || undefined,
    grouping: el<HTMLSelectElement>('filter-group').value as UsageGrouping });
  const root = el('usage-coverage'); root.replaceChildren(node('div', 'Includes recorded Codex and Claude Code usage across all local projects, archived sessions and subagents. Other devices and deleted history are not included.'));
  root.append(node('div', 'Input includes cache read/write. Output includes reasoning when reported. These token totals do not represent your subscription quota or a billing statement.'));
  root.append(node('div', 'Account attribution starts with native responses observed by AgentTandem. Older history, external CLI runs and unidentified API keys stay under Unknown account; they are never assigned to the current login or used in quota estimates. Identity uses the native email and organization when reported.'));
  const pricing = node('div', `API equivalent uses published standard global token rates checked ${PRICING_CHECKED_AT}, not historical invoices. Prompt-length premiums are estimated per response; older session-wide billing cannot be reconstructed. Fast modes, tool fees, taxes and regional premiums are excluded. Unspecified Claude cache writes use the 5-minute rate. Sources: `);
  for (const provider of ['Codex', 'Claude'] as const) { const link = node('a', provider === 'Codex' ? 'OpenAI API pricing' : 'Claude API pricing'); link.href = PRICING_SOURCES[provider]; pricing.append(link, document.createTextNode(' ')); }
  root.append(pricing);
  if (value.data) {
    const d = value.data, skipped = d.unreadableFiles + d.malformedLines + d.oversizedLines + d.undatedRecords;
    root.append(node('div', `${number(d.files)} history files · ${number(d.duplicates)} repeated response records counted once${skipped ? ` · Incomplete coverage: ${d.unreadableFiles} unreadable files, ${d.malformedLines} malformed lines, ${d.oversizedLines} oversized lines, ${d.undatedRecords} undated usage records` : ''}`));
  }
  page(currentPage);
}
window.addEventListener('message', event => {
  if (event.data?.type === 'state') render(event.data.state);
  if (event.data?.type === 'dashboard') page('dashboard');
  if (event.data?.type === 'page' && event.data.page === 'storage') page('storage');
});
el('dashboard').setAttribute('aria-busy', 'true'); el('dashboard').dataset.loading = 'true';
el('dashboard-status').textContent = 'Reading local CLI history…'; el<HTMLButtonElement>('refresh').disabled = true;
renderAccounts(); renderUsage(); renderQuotaEstimates();
send('ready');
