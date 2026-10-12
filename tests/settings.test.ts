// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { settingsHtml } from '../src/host/settings-html';
import { emptyTotals, type UsageDashboardState, type UsageDay } from '../src/core/usage-dashboard';
import { apiCost } from '../src/core/api-pricing';
import { usageAccount, UNKNOWN_ACCOUNT } from '../src/core/usage-account';
import { codexTokenActivity } from '../src/core/api-token-activity';
import type { QuotaObservation } from '../src/core/quota-estimate';
const postMessage = vi.fn(), listeners: EventListener[] = [];
const resources = { script: '/settings.js', style: '/settings.css', icons: '/codicon.css', claude: '/claude.svg', codex: '/codex.svg', cspSource: 'https://test.invalid', nonce: 'nonce' };
const row = (day: string, provider: 'Codex' | 'Claude', model: string, total: number): UsageDay => ({ ...emptyTotals(), day, provider, model, input: total - 20, output: 20, cacheRead: 100, total, requests: 1 });
const value: UsageDashboardState = { status: 'ready', preferences: { showQuotaInStatusBar: true, grouping: 'day' }, data: {
  days: [row('2026-09-30', 'Codex', 'codex-model', 200), row('2026-10-01', 'Claude', 'claude-model', 400), row('2026-10-09', 'Codex', 'codex-model', 600)],
  updatedAt: 1791570000000, files: 4, unreadableFiles: 0, malformedLines: 0, oversizedLines: 0, undatedRecords: 0, duplicates: 2, timezone: 'Asia/Saigon' },
  accounts: { Claude: { status: 'ready', account: { signedIn: true, email: 'claude@example.test', method: 'Claude account', plan: 'pro' }, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 25 }] } } } };
const render = (state = value) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state } }));
function choose(id: string, value: string) { const element = document.getElementById(id) as HTMLSelectElement; element.value = value; element.dispatchEvent(new Event('change')); }
beforeEach(async () => {
  vi.resetModules(); postMessage.mockClear();
  document.write(settingsHtml(resources).replace(/<link[^>]+>/g, '').replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''));
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage }));
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => { if (type === 'message') listeners.push(listener as EventListener); add(type, listener, options); });
  await import('../src/settings.js');
});
afterEach(() => { for (const listener of listeners.splice(0)) window.removeEventListener('message', listener); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
describe('Settings usage dashboard', () => {
  it('filters restore history, selects visible conversations, previews impact and sends only the delete token', () => {
    const group = (id: string, projectId: string, kind: 'checkpoints' | 'undo' = 'checkpoints') => ({ id, projectId, project: `L:/Code/${projectId}`, label: kind === 'undo' ? 'Last restore backup' : `Codex:${id}`, kind, count: 2, bytes: 1024, createdAt: 1000, updatedAt: 2000 });
    const histories = [group('first', 'one'), group('second', 'two'), group('backup', 'one', 'undo')];
    const storage = { status: 'ready' as const, root: 'root', histories, total: 3000 };
    render({ ...value, storage }); choose('storage-project', 'one'); choose('storage-kind', 'checkpoints');
    expect(document.querySelectorAll('.storage-history-row')).toHaveLength(1);
    document.querySelector<HTMLButtonElement>('#storage-select-visible')!.click();
    expect(document.querySelector('#storage-selection')!.textContent).toContain('1 selected');
    document.querySelector<HTMLButtonElement>('#storage-history-preview')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewHistoryDeletion', value: { ids: ['first'] } });
    const checkbox = document.querySelector<HTMLInputElement>('.storage-history-row input')!;
    render({ ...value, storage, accounts: { Claude: { status: 'loading' } } });
    expect(document.querySelector('.storage-history-row input')).toBe(checkbox);
    const historyPlan = { token: 'approved-history', createdAt: Date.now(), histories: [histories[0]!], records: [], files: [], bytes: 0 };
    render({ ...value, storage: { ...storage, historyPlan } });
    expect(document.querySelector<HTMLElement>('#storage-history-plan')!.hidden).toBe(false);
    expect(document.querySelector('#storage-history-impact')!.textContent).toContain('permanently unavailable');
    expect(document.querySelector('#storage-history-plan-files')!.textContent).toContain('shared');
    expect(document.querySelector<HTMLInputElement>('.storage-history-row input')!.disabled).toBe(true);
    document.querySelector<HTMLButtonElement>('#storage-history-delete')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'deleteHistory', value: { token: 'approved-history' } });
    render({ ...value, storage: { ...storage, histories: histories.slice(1), historyResult: { checkpointsRemoved: 2, removed: 1, bytes: 100, skipped: 1, failures: ['locked: EBUSY'] } } });
    expect(document.querySelector('#storage-selection')!.textContent).toContain('No history selected');
    expect(document.querySelector('#storage-history-result')!.textContent).toContain('Deleted 2 restore points');
    expect(document.querySelector('#storage-history-result')!.textContent).toContain('locked: EBUSY');
  });
  it('renders untrusted history labels as text and disables history deletion on unreadable metadata', () => {
    const histories = [{ id: 'one', projectId: 'one', project: 'project', label: '<img src=x onerror=alert(1)>', kind: 'checkpoints' as const, count: 1, bytes: 1, createdAt: 1, updatedAt: 2 }];
    render({ ...value, storage: { status: 'ready', root: 'root', histories } });
    expect(document.querySelector('#storage-histories img')).toBeNull(); expect(document.querySelector('#storage-histories')!.textContent).toContain('<img');
    render({ ...value, storage: { status: 'ready', root: 'root', histories, cleanupBlocked: 'Unreadable metadata' } });
    expect(document.querySelector<HTMLButtonElement>('#storage-history-preview')!.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('.storage-history-row input')!.disabled).toBe(true);
  });
  it('keeps history rows on quota/status updates and rebuilds them after a usage refresh', () => {
    render(); choose('filter-range', 'all');
    const row = document.querySelector('#model-breakdown tbody tr')!;
    expect(row).toBeTruthy();
    render({ ...value, accounts: { Claude: { ...value.accounts!.Claude!, status: 'loading' } } });
    expect(document.querySelector('#model-breakdown tbody tr')).toBe(row);
    render({ ...value, data: { ...value.data!, files: value.data!.files + 1 } });
    expect(document.querySelector('#model-breakdown tbody tr')).not.toBe(row);
  });
  it('shows storage location, cleanup preview and failures, and sends only the approved preview token', () => {
    render({ ...value, storage: { status: 'ready', root: 'C:/profile/globalStorage/agent-tandem', total: 4096, categories: [{ label: 'Review snapshots & tracking', bytes: 4096, files: 3 }], cleanable: { bytes: 1024, files: 1 }, plan: { token: 'preview', createdAt: Date.now(), bytes: 1024, files: [{ relative: 'reviews/history/blobs/old', bytes: 1024, modified: 0, changed: 0, inode: 1 }] } } });
    postMessage.mockClear(); document.querySelector<HTMLButtonElement>('[data-page="storage"]')!.click();
    expect(document.querySelector<HTMLElement>('#storage')!.hidden).toBe(false); expect(postMessage).toHaveBeenLastCalledWith({ type: 'storage', value: undefined });
    expect(document.querySelector('#storage-path')!.textContent).toContain('globalStorage');
    expect(document.querySelector('#storage-plan-files')!.textContent).toContain('reviews/history/blobs/old');
    expect(document.querySelector('#storage')!.textContent).toContain('checkpoints');
    document.querySelector<HTMLButtonElement>('#storage-clean')!.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'cleanup', value: { token: 'preview' } });
    render({ ...value, storage: { status: 'ready', root: 'root', total: 0, cleanable: { files: 0, bytes: 0 }, result: { removed: 1, bytes: 1024, skipped: 2, failures: ['locked: EBUSY'] } } });
    expect(document.querySelector('#storage-result')!.textContent).toContain('locked: EBUSY');
    expect(document.querySelector('#storage-result')!.textContent).toContain('2 changed or newly protected');
    expect(document.querySelector<HTMLButtonElement>('#storage-clean')!.disabled).toBe(true);
  });
  it('disables cleanup while loading or when metadata protection cannot be verified', () => {
    render({ ...value, storage: { status: 'loading', root: 'root' } });
    expect(document.querySelector<HTMLButtonElement>('#storage-preview')!.disabled).toBe(true);
    render({ ...value, storage: { status: 'ready', root: 'root', cleanupBlocked: 'Unreadable checkpoint metadata' } });
    expect(document.querySelector('#storage-error')!.textContent).toContain('Unreadable checkpoint');
    expect(document.querySelector<HTMLButtonElement>('#storage-preview')!.disabled).toBe(true);
  });
  it('labels API and Local sources, never adds server tokens to local totals, and preserves zero/null semantics', () => {
    const identity = { signedIn: true, email: 'codex@test.invalid', method: 'ChatGPT', id: 'workspace-one' };
    const accountId = usageAccount('Codex', identity)!.id;
    const status = { status: 'ready' as const, account: identity, usage: codexTokenActivity({ summary: { lifetimeTokens: 9000000, peakDailyTokens: null, currentStreakDays: 0 }, dailyUsageBuckets: [{ startDate: '2026-10-09', tokens: 700000 }] }, accountId, Date.now()) };
    render({ ...value, accounts: { Codex: status } }); choose('filter-range', 'all');
    const api = document.querySelector('#api-activity')!;
    expect(api.textContent).toContain('account/usage/read'); expect(api.textContent).toContain('codex@test.invalid');
    expect(api.querySelector('strong')?.getAttribute('title')).toBe('700,000');
    expect([...api.querySelectorAll('strong')].map(node => node.getAttribute('title'))).toContain('9,000,000');
    expect(api.textContent).toContain('Not reported by API'); expect(api.textContent).toContain('Current streak0');
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('1,200');
    expect(document.querySelector('#api-cost-caption')!.textContent).toContain('Local tokens × API prices');
    choose('filter-model', 'codex-model');
    expect(api.textContent).toContain('model filter applies only to Local');
    expect(api.querySelector('strong')?.getAttribute('title')).toBe('700,000');
    render({ ...value, accounts: { Codex: { ...status, status: 'loading' } } });
    expect(api.textContent).toContain('previous snapshot'); expect(api.querySelector('.skeleton')).toBeNull();
    choose('filter-account', UNKNOWN_ACCOUNT);
    expect(api.textContent).toContain('only for the signed-in Codex account'); expect(api.querySelector('strong')).toBeNull();
    choose('filter-provider', 'Claude'); expect(api.textContent).toContain('No personal-account token activity API');
  });
  it('shows an account breakdown and filters all usage views without changing the live quota account', () => {
    const one = usageAccount('Codex', { signedIn: true, email: 'one@test.invalid', method: 'ChatGPT' })!;
    const two = usageAccount('Codex', { signedIn: true, email: 'two@test.invalid', method: 'ChatGPT' })!;
    render({ ...value, data: { ...value.data!, days: [
      { ...row('2026-10-09', 'Codex', 'one-model', 200), account: one },
      { ...row('2026-10-09', 'Codex', 'two-model', 600), account: two },
      row('2026-10-09', 'Claude', 'unknown-model', 400),
    ] } });
    choose('filter-range', 'all');
    expect(document.querySelectorAll('#account-breakdown tbody tr')).toHaveLength(3);
    expect(document.querySelector('#account-breakdown')!.textContent).toContain('Unknown account');
    const quotaBefore = document.querySelector('#quota-estimates')!.textContent;
    choose('filter-account', one.id);
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('200');
    expect(document.querySelector('#model-breakdown')!.textContent).toContain('one-model');
    expect(document.querySelector('#model-breakdown')!.textContent).not.toContain('two-model');
    expect(document.querySelectorAll('#account-breakdown tbody tr')).toHaveLength(1);
    expect(document.querySelector('#quota-estimates')!.textContent).toBe(quotaBefore);
    render({ ...value, data: { ...value.data!, days: [{ ...row('2026-10-09', 'Codex', 'one-model', 200), account: one }] } });
    expect((document.querySelector('#filter-account') as HTMLSelectElement).value).toBe(one.id);
    document.getElementById('reset-filters')!.click();
    expect((document.querySelector('#filter-account') as HTMLSelectElement).value).toBe('');
    render(); choose('filter-range', 'all'); choose('filter-account', UNKNOWN_ACCOUNT);
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('1,200');
  });
  it('shows skeletons before data arrives, preserves data during refresh and clears loading on an error', () => {
    const dashboard = document.getElementById('dashboard')!;
    expect(dashboard.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelectorAll('#totals .skeleton-value')).toHaveLength(4);
    expect(document.querySelector('#totals strong')).toBeNull();
    expect(document.querySelectorAll('#usage-chart .skeleton-bar')).toHaveLength(9);
    expect(document.querySelector('#accounts .skeleton')).not.toBeNull();
    render({ status: 'loading', preferences: value.preferences });
    choose('filter-range', 'all'); expect(document.querySelector('#period-breakdown .skeleton')).not.toBeNull();
    render(); choose('filter-range', 'all');
    expect(document.querySelector('#totals .skeleton')).toBeNull();
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('1,200');
    render({ ...value, status: 'loading' });
    expect(dashboard.dataset.loading).toBe('true'); expect(document.querySelector('#totals .skeleton')).toBeNull();
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('1,200');
    render({ status: 'error', error: 'Could not read history', preferences: value.preferences });
    expect(dashboard.getAttribute('aria-busy')).toBe('false'); expect(dashboard.dataset.loading).toBe('false');
    expect(document.querySelector('#dashboard-error')!.textContent).toBe('Could not read history');
    expect(document.querySelector('#dashboard .skeleton')).toBeNull();
  });
  it('filters USD costs with usage while preserving current-window quota estimates', () => {
    const now = Date.parse('2026-10-10T08:00:00Z'); vi.spyOn(Date, 'now').mockReturnValue(now);
    const codex = { ...row('2026-10-10', 'Codex', 'gpt-5.3-codex', 1100000), input: 1000000, output: 100000, cacheRead: 800000 };
    codex.cost = apiCost('Codex', codex.model, codex);
    const claude = { ...row('2026-10-10', 'Claude', 'claude-sonnet-4-6', 1000000), input: 900000, output: 100000, cacheRead: 500000, cacheWrite: 300000 };
    claude.cost = apiCost('Claude', claude.model, claude);
    render({ ...value, data: { ...value.data!, updatedAt: now, days: [codex, claude], recent: [{ timestamp: now - 3600000, provider: 'Codex', accountId: usageAccount('Codex', { signedIn: true, email: 'codex@test.invalid', method: 'ChatGPT' })!.id, total: codex.total }] }, accounts: {
      Codex: { status: 'ready', account: { signedIn: true, email: 'codex@test.invalid', method: 'ChatGPT' }, updatedAt: now, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 25, resetsAt: now + 3600000 }] } },
    } });
    expect(document.querySelector('#api-cost-total')!.getAttribute('title')).toBe('4.965000 USD for priced token usage');
    expect(document.querySelector('#api-cost-parts')!.textContent).toContain('Cache write');
    expect(document.querySelector('#model-breakdown')!.textContent).toContain('API USD');
    expect(document.querySelector('#period-breakdown')!.textContent).toContain('API USD');
    const quota = document.querySelector('#quota-estimates')!;
    expect(quota.textContent).toContain('tokens / 1%');
    expect(quota.querySelector('.quota-estimate-value')!.getAttribute('title')).toBe('44,000 tokens per percentage point');
    const before = quota.textContent;
    choose('filter-provider', 'Claude');
    expect(document.querySelector('#api-cost-total')!.getAttribute('title')).toBe('3.075000 USD for priced token usage');
    expect(quota.textContent).toBe(before);
    choose('filter-provider', 'Codex');
    expect(document.querySelector('#api-cost-total')!.getAttribute('title')).toBe('1.890000 USD for priced token usage');
  });
  it('shows the weighted lifetime ratio and changes across cycles independent of dashboard filters', () => {
    const now = Date.parse('2026-10-11T06:00:00Z'); vi.spyOn(Date, 'now').mockReturnValue(now);
    const identity = { signedIn: true, email: 'codex@test.invalid', method: 'ChatGPT', plan: 'plus' };
    const sample: QuotaObservation = { provider: 'Codex', accountId: usageAccount('Codex', identity)!.id, plan: 'plus', label: '5h',
      from: now - 12 * 3600000, resetsAt: now - 7 * 3600000, to: now - 8 * 3600000, observedTokens: 1000000, usedPercent: 25 };
    render({ ...value, accounts: { Codex: { status: 'ready', account: identity } }, quotaHistory: [sample,
      { ...sample, from: now - 6 * 3600000, resetsAt: now - 3600000, to: now - 2 * 3600000, observedTokens: 2000000, usedPercent: 25 },
    ] });
    const root = document.getElementById('quota-estimates')!;
    expect(root.querySelector('.quota-estimate-value')?.getAttribute('title')).toBe('60,000 tokens per percentage point');
    expect(root.querySelector('.quota-trend-change')?.textContent).toContain('+100% vs earlier cycles');
    expect(root.textContent).toContain('All observed cycles · 2 cycles · All projects & models');
    expect(root.querySelectorAll('.quota-trend-history tbody tr')).toHaveLength(2);
    const before = root.textContent;
    choose('filter-provider', 'Claude'); choose('filter-range', 'all');
    expect(root.textContent).toBe(before);
  });
  it('defaults to today with daily grouping and resets to today after browsing other ranges', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 9, 12).getTime());
    render();
    expect((document.getElementById('filter-range') as HTMLSelectElement).value).toBe('today');
    expect((document.getElementById('filter-group') as HTMLSelectElement).value).toBe('day');
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('600');
    expect(document.querySelectorAll('#period-breakdown tbody tr')).toHaveLength(1);
    expect(document.querySelectorAll('.chart-column')).toHaveLength(2);
    expect(document.querySelector('#period-breakdown td.total-cell')!.getAttribute('title')).toBe('600');
    choose('filter-range', 'all'); expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('1,200');
    document.getElementById('reset-filters')!.click();
    expect((document.getElementById('filter-range') as HTMLSelectElement).value).toBe('today');
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('600');
    render({ ...value, status: 'loading' });
    expect((document.getElementById('filter-range') as HTMLSelectElement).value).toBe('today');
    expect(document.getElementById('dashboard')!.getAttribute('aria-busy')).toBe('true');
  });
  it('opens dashboard first, renders global totals/accounts, and filters provider/model without losing controls on refresh', () => {
    render(); choose('filter-range', 'all'); expect(document.getElementById('dashboard')!.hidden).toBe(false); expect(document.getElementById('preferences')!.hidden).toBe(true);
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('1,200');
    expect(document.querySelectorAll('#model-breakdown tbody tr')).toHaveLength(2);
    expect(document.querySelector('#accounts')!.textContent).toContain('claude@example.test');
    expect(document.querySelector('#accounts')!.textContent).toContain('75% left');
    choose('filter-provider', 'Codex'); expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('800');
    expect(document.querySelectorAll('#filter-model option')).toHaveLength(2);
    choose('filter-model', 'codex-model'); render({ ...value, status: 'loading' });
    expect((document.getElementById('filter-model') as HTMLSelectElement).value).toBe('codex-model');
    expect((document.getElementById('refresh') as HTMLButtonElement).disabled).toBe(true);
    choose('filter-provider', 'Claude'); expect((document.getElementById('filter-model') as HTMLSelectElement).value).toBe('');
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('400');
  });
  it('regroups all usage by week/month and applies custom date ranges without inflating totals', () => {
    render(); choose('filter-range', 'all'); choose('filter-group', 'month');
    expect(document.querySelector('#period-title')!.textContent).toBe('Monthly breakdown');
    expect(document.querySelectorAll('#period-breakdown tbody tr')).toHaveLength(2);
    choose('filter-group', 'week'); expect(document.querySelector('#period-caption')!.textContent).toContain('Monday');
    choose('filter-range', 'custom'); choose('filter-from', '2026-10-01'); choose('filter-to', '2026-10-31');
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('1,000');
    choose('filter-to', '2026-09-01'); expect(document.getElementById('dashboard-error')!.hidden).toBe(false);
    document.getElementById('reset-filters')!.click(); choose('filter-range', 'all'); expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('1,200');
  });
  it('edits preferences through the host bridge and a repeated status-bar open returns to Dashboard', () => {
    render(); document.querySelector<HTMLButtonElement>('[data-page="preferences"]')!.click();
    const toggle = document.getElementById('show-status-quota') as HTMLInputElement; toggle.checked = false; toggle.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'preferences', value: { showQuotaInStatusBar: false } });
    choose('default-grouping', 'month'); expect(postMessage).toHaveBeenLastCalledWith({ type: 'preferences', value: { grouping: 'month' } });
    document.getElementById('manage-clis')!.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'clis', value: undefined });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard' } }));
    expect(document.getElementById('dashboard')!.hidden).toBe(false);
    document.getElementById('refresh')!.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'refresh', value: undefined });
  });
  it('renders empty/error/incomplete states, never treats model/account text as HTML, and pages long periods', () => {
    render({ ...value, status: 'error', error: 'History unavailable', data: { ...value.data!, days: [], unreadableFiles: 1 } });
    choose('filter-range', 'all');
    expect(document.querySelector('#usage-chart')!.textContent).toContain('No recorded usage');
    expect(document.querySelector('#usage-coverage')!.textContent).toContain('Incomplete coverage');
    expect(document.querySelector('#dashboard-error')!.textContent).toBe('History unavailable');
    const days = Array.from({ length: 75 }, (_, i) => row(`2026-${String(Math.floor(i / 25) + 1).padStart(2, '0')}-${String(i % 25 + 1).padStart(2, '0')}`, 'Codex', '<img src=x onerror=alert(1)>', 200));
    render({ ...value, data: { ...value.data!, days } });
    expect(document.querySelector('#model-breakdown img')).toBeNull(); expect(document.querySelector('#model-breakdown')!.textContent).toContain('<img');
    expect(document.querySelectorAll('#period-breakdown tbody tr')).toHaveLength(60);
    document.querySelector<HTMLButtonElement>('#period-breakdown button')!.click(); expect(document.querySelectorAll('#period-breakdown tbody tr')).toHaveLength(75);
    expect(document.querySelectorAll('.chart-column')).toHaveLength(30);
  });
});
