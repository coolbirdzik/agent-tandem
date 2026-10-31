// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { settingsHtml } from '../src/host/settings-html';
import { emptyTotals, type UsageDashboardState, type UsageDay } from '../src/core/usage-dashboard';
import { apiCost } from '../src/core/api-pricing';
import { usageAccount, UNKNOWN_ACCOUNT } from '../src/core/usage-account';
import { codexTokenActivity } from '../src/core/api-token-activity';
import { quotaMeters, type QuotaObservation } from '../src/core/quota-estimate';
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
  it('offers review cleanup presets next to the category and explains their different impact', () => {
    const storage = { status: 'ready' as const, root: 'root', categories: [{ label: 'Review snapshots & tracking', bytes: 4096, files: 3 }], retainedReviews: [{ project: 'D:/project', files: 7, undo: 1, bytes: 4096 }] };
    render({ ...value, storage });
    expect(document.querySelector('#storage-categories')!.textContent).toContain('D:/project');
    expect(document.querySelector('#storage-categories')!.textContent).toContain('7 saved comparisons');
    expect(document.querySelector('#storage-totals')!.textContent).toContain('Unused snapshots');
    for (const scope of ['accepted', 'all', 'discard']) {
      document.querySelector<HTMLButtonElement>(`button[data-review-cleanup="${scope}"]`)!.click();
      expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewReviewCleanup', value: { scope } });
    }
    const historyPlan = { token: 'review-only', createdAt: Date.now(), reviewScope: 'accepted' as const, histories: [], records: [], files: [], bytes: 0 };
    render({ ...value, storage: { ...storage, historyPlan } });
    expect(document.querySelector('#storage-history-plan-heading')!.textContent).toContain('Clean accepted');
    expect(document.querySelector('#storage-history-impact')!.textContent).toContain('Tracking baselines, pending review, checkpoints and Undo stay protected');
    expect(document.querySelector('#storage-history-plan-files')!.textContent).toContain('Nothing to clean');
    expect(document.querySelector<HTMLButtonElement>('#storage-history-delete')!.disabled).toBe(true);
    const histories = [{ id: 'track', projectId: 'one', project: 'project', label: 'Baseline', kind: 'tracking' as const, count: 0, bytes: 1024, reclaimable: 1024, createdAt: 1, updatedAt: 2 }];
    render({ ...value, storage: { ...storage, historyPlan: { ...historyPlan, token: 'all', reviewScope: 'all', histories, records: [{ relative: 'reviews/one.json', digest: 'one', ids: [] }] } } });
    expect(document.querySelector('#storage-history-plan-heading')!.textContent).toBe('Clean all review snapshots & tracking');
    expect(document.querySelector('#storage-history-impact')!.textContent).toContain('Change tracking stops in 1 project');
    expect(document.querySelector('#storage-history-impact')!.textContent).toContain('Pending review and its revert Undo stay protected');
    document.querySelector<HTMLButtonElement>('#storage-history-delete')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'deleteHistory', value: { token: 'all' } });
    expect(document.querySelector<HTMLButtonElement>('[data-review-cleanup="all"]')!.disabled).toBe(true);
    render({ ...value, storage: { ...storage, historyPlan: { ...historyPlan, token: 'discard', reviewScope: 'discard', discardedReviews: [{ project: 'D:/project', files: 7, undo: 1 }] } } });
    expect(document.querySelector('#storage-history-plan-heading')!.textContent).toBe('Clear saved review data');
    expect(document.querySelector('#storage-history-impact')!.textContent).toContain('These changes can no longer be reverted from Review');
    expect(document.querySelector('#storage-history-plan-groups')!.textContent).toContain('D:/project · 7 saved comparisons');
  });
  it('shows extension data warnings and opens extension cleanup without scanning native chats', () => {
    render({ ...value, extensionStorage: { status: 'ready', total: 2 * 1024 ** 3, warningBytes: 1024 ** 3, files: 400 } });
    const health = document.querySelector<HTMLElement>('#extension-storage-health')!;
    expect(health.hidden).toBe(false); expect(health.dataset.level).toBe('warning'); expect(health.textContent).toContain('2 GB');
    postMessage.mockClear();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'page', page: 'storage', storagePage: 'unused' } }));
    expect(document.querySelector<HTMLElement>('#storage-unused-page')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#storage-conversations-page')!.hidden).toBe(true);
    expect(postMessage.mock.calls.some(([request]) => request.type === 'scanConversations')).toBe(false);
    health.querySelector('button')!.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'storage', value: undefined });
  });
  it('sorts by last message, filters before local midnight and deletes all matches beyond the visible page once', () => {
    const before = new Date('2025-04-01T00:00:00').getTime();
    const conversations = Array.from({ length: 105 }, (_, index) => ({ key: `Codex:${index}`, id: String(index), provider: 'Codex' as const,
      title: `Chat ${index}`, project: '/repo', archived: false, updatedAt: Date.now() - 86400000,
      lastMessageAt: before - (index + 1) * 86400000, bytes: index + 100, files: [] }));
    conversations.push({ ...conversations[0]!, key: 'Codex:boundary', id: 'boundary', lastMessageAt: before });
    const fixture = { ...value, conversationCleanup: { status: 'ready' as const, roots: { Codex: '/codex', Claude: '/claude' }, conversations } };
    render(fixture); choose('native-history-before', '2025-04-01');
    const keys = () => [...document.querySelectorAll<HTMLInputElement>('#native-history-list input')].map(input => input.dataset.nativeKey);
    expect(keys()).toHaveLength(100); expect(keys()[0]).toBe('Codex:104'); expect(keys()).not.toContain('Codex:boundary');
    expect((document.querySelector('#native-history-age') as HTMLSelectElement).value).toBe('0');
    expect(document.querySelector('#native-history-delete-matching')!.textContent).toBe('Delete all matching (105)');
    render({ ...fixture, conversationCleanup: { ...fixture.conversationCleanup, dates: { done: 1, total: 4 } } });
    expect(document.querySelector('#native-history-delete-matching')!.textContent).toBe('Delete all matching (105+)');
    render(fixture);
    expect(document.querySelector('.native-row-date')!.getAttribute('title')).toContain('Last message:');
    document.querySelector<HTMLButtonElement>('#native-history-sort')!.click(); expect(keys()[0]).toBe('Codex:0');
    document.querySelector<HTMLButtonElement>('#native-history-delete-matching')!.click();
    const request = postMessage.mock.lastCall![0];
    expect(request).toEqual({ type: 'deleteConversations', value: { filter: { before } } });
    const count = postMessage.mock.calls.length;
    document.querySelector<HTMLButtonElement>('#native-history-delete-matching')!.click(); expect(postMessage).toHaveBeenCalledTimes(count);
    render({ ...fixture, conversationCleanup: { ...fixture.conversationCleanup, status: 'error', error: 'Locked' } });
    expect(document.querySelector('#native-history-errors')!.textContent).toContain('Locked');
  });
  it('follows a deletion in a result dialog from date reading to the kept and deleted lists', () => {
    const old = Date.now() - 60 * 86400000;
    const conversations = [{ key: 'Codex:a', id: 'a', provider: 'Codex' as const, title: 'Old chat', project: '/repo', archived: false, updatedAt: old, bytes: 2048, files: [] }];
    const base = { status: 'ready' as const, roots: { Codex: '/codex', Claude: '/claude' }, conversations };
    render({ ...value, conversationCleanup: base });
    choose('native-history-provider', 'Codex'); document.querySelector<HTMLButtonElement>('#native-history-delete-matching')!.click();
    expect(postMessage.mock.lastCall![0].value.filter).toMatchObject({ provider: 'Codex', before: expect.any(Number) });
    const dialog = document.querySelector<HTMLDialogElement>('#native-cleanup-dialog')!;
    expect(dialog.open).toBe(true); expect(document.querySelector('#native-cleanup-scope')!.textContent).toBe('All matching · Codex · last message 30+ days ago');
    render({ ...value, conversationCleanup: { ...base, status: 'cleaning', dates: { done: 3, total: 10 } } });
    expect(document.querySelector('#native-cleanup-summary')!.textContent).toContain('Reading message dates · 3 / 10');
    render({ ...value, conversationCleanup: { ...base, status: 'cleaning', done: 1, total: 2 } });
    expect(document.querySelector('#native-cleanup-summary')!.textContent).toContain('Deleting conversations · 1 / 2');
    expect(document.querySelector('#native-cleanup-close')!.textContent).toBe('Hide');
    render({ ...value, conversationCleanup: { ...base, conversations: [], result: { removed: ['Codex:a'], bytes: 2048, skipped: [], failures: [], titles: { 'Codex:a': 'Old chat' },
      kept: [{ key: 'Codex:b', title: 'Parent chat', reason: 'Has subagent history newer than the cutoff.' }] } } });
    expect(document.querySelector('#native-cleanup-title')!.textContent).toBe('Cleanup complete');
    expect(document.querySelector('#native-cleanup-summary')!.textContent).toBe('Deleted 1 conversation and freed 2.0 KB. 1 conversation kept.');
    expect(document.querySelector('[data-kind="kept"]')!.textContent).toContain('Parent chatHas subagent history newer');
    expect(document.querySelector('[data-kind="removed"]')!.textContent).toContain('Old chat');
    expect(dialog.dataset.status).toBe('warning'); expect(document.querySelector('#native-cleanup-close')!.textContent).toBe('Done');
    document.querySelector<HTMLButtonElement>('#native-cleanup-close')!.click(); expect(dialog.open).toBe(false);
  });
  it('filters and deletes by local calendar year, listing years with counts', () => {
    const at = (date: string) => new Date(`${date}T12:00:00`).getTime();
    const conversations = [['a', '2024-06-01'], ['b', '2025-01-01'], ['c', '2025-12-31'], ['d', '2023-03-03']].map(([id, date]) => ({ key: `Codex:${id}`, id: id!, provider: 'Codex' as const,
      title: `Chat ${id}`, project: '/repo', archived: false, updatedAt: at(date!), lastMessageAt: at(date!), bytes: 100, files: [] }));
    render({ ...value, conversationCleanup: { status: 'ready', roots: { Codex: '/codex', Claude: '/claude' }, conversations } });
    const year = document.querySelector<HTMLSelectElement>('#native-history-year')!;
    expect([...year.options].map(option => option.textContent)).toEqual(['All years', '2025 (2)', '2024 (1)', '2023 (1)']);
    choose('native-history-year', '2025');
    expect([...document.querySelectorAll<HTMLInputElement>('#native-history-list input')].map(input => input.dataset.nativeKey)).toEqual(['Codex:b', 'Codex:c']);
    expect(document.querySelector('[data-native-preset="old"]')!.getAttribute('aria-pressed')).toBe('false');
    document.querySelector<HTMLButtonElement>('#native-history-delete-matching')!.click();
    expect(postMessage.mock.lastCall![0].value.filter).toEqual({ after: new Date(2025, 0, 1).getTime(), before: new Date(2026, 0, 1).getTime() });
    expect(document.querySelector('#native-cleanup-scope')!.textContent).toBe('All matching · both agents · last message 30+ days ago · year 2025');
    render({ ...value, conversationCleanup: { status: 'cleaning', roots: { Codex: '/codex', Claude: '/claude' }, conversations } });
    render({ ...value, conversationCleanup: { status: 'ready', roots: { Codex: '/codex', Claude: '/claude' }, conversations: conversations.filter(row => !row.key.match(/[bc]$/)) } });
    expect([...year.options].map(option => option.textContent)).toEqual(['All years', '2025 (0)', '2024 (1)', '2023 (1)']); expect(year.value).toBe('2025');
    document.querySelector<HTMLButtonElement>('[data-native-preset="all"]')!.click(); expect(year.value).toBe('');
  });
  it('shift-selects and clears native conversation ranges in either direction, skipping protected rows', () => {
    const conversations = Array.from({ length: 6 }, (_, index) => ({ key: `Codex:${index}`, id: String(index), provider: 'Codex' as const, title: `Chat ${index}`, project: '/repo', archived: false,
      updatedAt: Date.now() - 60 * 86400000, bytes: 100, files: [], ...(index === 1 ? { blocked: 'Open conversation' } : {}) }));
    const fixture = { ...value, conversationCleanup: { status: 'ready' as const, roots: { Codex: '/codex', Claude: '/claude' }, conversations } };
    const click = (index: number, shift = false) => document.querySelectorAll<HTMLInputElement>('#native-history-list input')[index]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: shift }));
    const selected = () => [...document.querySelectorAll<HTMLInputElement>('#native-history-list input')].filter(input => input.checked).map(input => input.dataset.nativeKey);
    render(fixture); click(5); click(0);
    render({ ...fixture, conversationCleanup: { ...fixture.conversationCleanup, conversations: conversations.map(row => ({ ...row, title: `${row.title} renamed` })) } });
    click(3, true); expect(selected()).toEqual(['Codex:0', 'Codex:2', 'Codex:3', 'Codex:5']);
    click(2, true); expect(selected()).toEqual(['Codex:3', 'Codex:5']);
    document.querySelector<HTMLButtonElement>('#native-history-clear')!.click(); click(4); click(0, true);
    expect(selected()).toEqual(['Codex:0', 'Codex:2', 'Codex:3', 'Codex:4']);
    expect(document.querySelector<HTMLInputElement>('#native-history-list input:disabled')!.checked).toBe(false);
    document.querySelector<HTMLButtonElement>('#native-history-preview')!.click();
    expect(postMessage.mock.lastCall![0].value.keys.sort()).toEqual(['Codex:0', 'Codex:2', 'Codex:3', 'Codex:4']);
  });
  it('resets range anchors on filter and clear actions and never includes filtered-out conversations', () => {
    const conversations = Array.from({ length: 5 }, (_, index) => ({ key: `${index === 2 ? 'Claude' : 'Codex'}:${index}`, id: String(index), provider: index === 2 ? 'Claude' as const : 'Codex' as const,
      title: `Chat ${index}`, project: '/repo', archived: false, updatedAt: Date.now() - 60 * 86400000, bytes: 100, files: [] }));
    render({ ...value, conversationCleanup: { status: 'ready', roots: { Codex: '/codex', Claude: '/claude' }, conversations } });
    const click = (index: number, shift = false) => document.querySelectorAll<HTMLInputElement>('#native-history-list input')[index]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: shift }));
    const selected = () => [...document.querySelectorAll<HTMLInputElement>('#native-history-list input')].filter(input => input.checked).map(input => input.dataset.nativeKey);
    click(0); choose('native-history-provider', 'Codex'); click(3, true);
    expect(selected()).toEqual(['Codex:4']);
    click(0, true); expect(selected()).toEqual(['Codex:0', 'Codex:1', 'Codex:3', 'Codex:4']);
    document.querySelector<HTMLButtonElement>('#native-history-clear')!.click(); click(2, true);
    expect(selected()).toEqual(['Codex:3']);
  });
  it('supports shift-clicking restore history labels with the same range behavior', () => {
    const histories = Array.from({ length: 4 }, (_, index) => ({ id: `history-${index}`, projectId: 'repo', project: '/repo', label: `Restore ${index}`, kind: 'checkpoints' as const,
      count: 1, bytes: 100, reclaimable: 100, createdAt: 1, updatedAt: 2 }));
    render({ ...value, storage: { status: 'ready', root: '/extension', histories } });
    const click = (index: number, shift = false) => document.querySelectorAll<HTMLLabelElement>('#storage-histories label')[index]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: shift }));
    const selected = () => [...document.querySelectorAll<HTMLInputElement>('#storage-histories input')].filter(input => input.checked).map(input => input.dataset.historyId);
    click(0); click(3, true); expect(selected()).toEqual(['history-0', 'history-1', 'history-2', 'history-3']);
    click(1, true); expect(selected()).toEqual(['history-2', 'history-3']);
    document.querySelector<HTMLButtonElement>('#storage-history-preview')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewHistoryDeletion', value: { ids: ['history-2', 'history-3'] } });
  });
  it('opens conversation cleanup first, scans once and keeps restore history and unused files in separate views', () => {
    render(value); postMessage.mockClear();
    document.querySelector<HTMLButtonElement>('[data-page="storage"]')!.click();
    expect((document.querySelector('#storage-conversations-page') as HTMLElement).hidden).toBe(false);
    expect((document.querySelector('#storage-restore-page') as HTMLElement).hidden).toBe(true);
    expect((document.querySelector('#storage-extension-summary') as HTMLElement).hidden).toBe(true);
    expect(postMessage.mock.calls.filter(([message]) => message.type === 'scanConversations')).toHaveLength(1);
    render({ ...value, accountsBusy: true });
    expect(postMessage.mock.calls.filter(([message]) => message.type === 'scanConversations')).toHaveLength(1);
    document.querySelector<HTMLButtonElement>('[data-storage-page="restore"]')!.click();
    expect((document.querySelector('#storage-conversations-page') as HTMLElement).hidden).toBe(true);
    expect((document.querySelector('#storage-restore-page') as HTMLElement).hidden).toBe(false);
    expect((document.querySelector('#storage-extension-summary') as HTMLElement).hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('[data-storage-page="unused"]')!.click();
    expect((document.querySelector('#storage-unused-page') as HTMLElement).hidden).toBe(false);
    expect((document.querySelector('#storage-restore-page') as HTMLElement).hidden).toBe(true);
  });
  it('offers archive and age presets and preserves conversation checkboxes across unrelated updates', () => {
    const row = { key: 'Codex:old', id: 'old', provider: 'Codex' as const, title: 'Old archived chat', project: '/repo', archived: true, updatedAt: Date.now() - 45 * 86400000, bytes: 100, files: [] };
    const conversationCleanup: NonNullable<UsageDashboardState['conversationCleanup']> = { status: 'ready', roots: { Codex: '/codex', Claude: '/claude' }, conversations: [row, { ...row, key: 'Codex:recent', id: 'recent', title: 'Recent chat', archived: false, updatedAt: Date.now() - 86400000 }] };
    render({ ...value, conversationCleanup });
    const checkbox = document.querySelector<HTMLInputElement>('#native-history-list input')!; checkbox.click();
    const selected = document.querySelector<HTMLInputElement>('#native-history-list input')!;
    render({ ...value, conversationCleanup, accountsBusy: true });
    expect(document.querySelector('#native-history-list input')).toBe(selected);
    expect(selected.checked).toBe(true); expect(document.querySelector('#native-history-selection')!.textContent).toBe('1 conversation selected');
    document.querySelector<HTMLButtonElement>('[data-native-preset="all"]')!.click();
    expect(document.querySelectorAll('#native-history-list input')).toHaveLength(2);
    document.querySelector<HTMLButtonElement>('[data-native-preset="archived"]')!.click();
    expect(document.querySelectorAll('#native-history-list input')).toHaveLength(1);
    expect(document.querySelector('[data-native-preset="archived"]')!.getAttribute('aria-pressed')).toBe('true');
  });
  it('deletes selected native history immediately, keeps protected sessions disabled and supports legacy preview tokens', () => {
    const old = Date.now() - 60 * 86400000;
    const conversationCleanup: NonNullable<UsageDashboardState['conversationCleanup']> = { status: 'ready', roots: { Codex: '/codex', Claude: '/claude' }, conversations: [
      { key: 'Codex:old', id: 'old', provider: 'Codex', title: 'Archived cleanup', project: '/repo', archived: true, updatedAt: old, bytes: 100, files: [] },
      { key: 'Claude:old', id: 'old', provider: 'Claude', title: 'Claude history', project: '/other', archived: false, updatedAt: old, bytes: 200, files: [] },
      { key: 'Codex:protected', id: 'protected', provider: 'Codex', title: 'Open history', project: '/repo', archived: false, updatedAt: old, bytes: 300, files: [], blocked: 'Open conversation' },
    ] };
    render({ ...value, conversationCleanup });
    document.querySelector<HTMLButtonElement>('#native-history-select')!.click();
    expect(document.querySelector('#native-history-status')!.textContent).toContain('2 selected');
    choose('native-history-archive', 'archived');
    expect(document.querySelectorAll('#native-history-list input')).toHaveLength(1);
    document.querySelector<HTMLButtonElement>('#native-history-select')!.click(); document.querySelector<HTMLButtonElement>('#native-history-preview')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'deleteConversations', value: { keys: ['Codex:old'], before: expect.any(Number) } });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'previewConversationCleanup' }));
    render({ ...value, conversationCleanup: { ...conversationCleanup, status: 'cleaning' } });
    render({ ...value, conversationCleanup: { ...conversationCleanup, plan: { token: 'approved', createdAt: Date.now(), conversations: [conversationCleanup.conversations![0]!], bytes: 100 } } });
    expect((document.querySelector('#native-history-plan') as HTMLElement).hidden).toBe(false);
    expect((document.querySelector('#native-history-archive') as HTMLSelectElement).disabled).toBe(true);
    document.querySelector<HTMLButtonElement>('#native-history-delete')!.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'deleteConversations', value: { token: 'approved' } });
    render({ ...value, conversationCleanup: { ...conversationCleanup, status: 'cleaning', done: 1, total: 2 } });
    expect(document.querySelector('#native-history-status')!.textContent).toContain('1 / 2');
    expect((document.querySelector('#native-history-delete') as HTMLButtonElement).disabled).toBe(true);
  });
  it('opens a reviewable date scope for unknown external Claude history in the all-time view', () => {
    const account = usageAccount('Claude', { signedIn: true, email: 'claude@test.invalid', method: 'Claude account' })!;
    render({ ...value, accounts: { Claude: { status: 'ready', account: { signedIn: true, email: account.email, method: account.method } } }, data: { ...value.data!, days: [
      row('2026-10-01', 'Claude', 'sonnet', 100), row('2026-10-14', 'Claude', 'sonnet', 200), row('2026-09-01', 'Codex', 'codex', 999),
    ] } });
    choose('filter-range', 'all');
    const unknown = [...document.querySelectorAll<HTMLElement>('#account-groups .account-group')].find(item => item.dataset.provider === 'Claude' && item.textContent?.includes('Unknown account'))!;
    expect(unknown.textContent).toContain('Claude transcripts without account identity');
    [...unknown.querySelectorAll('button')].find(button => button.textContent === 'Assign history')!.click();
    expect((document.querySelector('#attribution-from') as HTMLInputElement).value).toBe('2026-10-01');
    expect((document.querySelector('#attribution-to') as HTMLInputElement).value).toBe('2026-10-14');
    choose('attribution-account', account.id);
    expect(document.querySelector('#attribution-preview')!.textContent).toContain('300 tokens');
    expect((document.querySelector('#attribution-save') as HTMLButtonElement).disabled).toBe(false);
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'usageAttribution' }));
    document.querySelector<HTMLFormElement>('#attribution-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'usageAttribution', value: { action: 'assign', scope: { provider: 'Claude', conversationId: undefined, from: '2026-10-01', to: '2026-10-14' }, accountId: account.id } });
  });
  it('previews explicit history scopes, labels inferred usage and sends reversible assignments', () => {
    const account = usageAccount('Codex', { signedIn: true, email: 'history@test.invalid', method: 'ChatGPT' })!;
    const days = [{ ...row('2026-10-14', 'Codex', 'model', 200), account, accountSource: 'inferred' as const }, row('2026-10-14', 'Codex', 'model', 300)];
    const fixture: UsageDashboardState = { ...value, accounts: { Codex: { status: 'ready', account: { signedIn: true, email: account.email, method: 'ChatGPT' } } }, data: { ...value.data!, days,
      conversations: [{ key: 'Codex:session', id: 'session', provider: 'Codex', firstAt: 1, lastAt: 2, days }], assignments: [{ id: 'saved', provider: 'Codex', conversationId: 'session', account }] } };
    render(fixture); choose('filter-range', 'all');
    expect(document.querySelector('#account-groups')!.textContent).toContain('Inferred from session evidence: 200 tokens');
    choose('attribution-conversation', 'session'); choose('attribution-account', account.id);
    expect(document.querySelector('#attribution-preview')!.textContent).toContain('500 tokens');
    expect((document.querySelector('#attribution-save') as HTMLButtonElement).disabled).toBe(false);
    document.querySelector<HTMLFormElement>('#attribution-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'usageAttribution', value: { action: 'assign', scope: { provider: 'Codex', conversationId: 'session', from: undefined, to: undefined }, accountId: account.id } });
    choose('attribution-account', UNKNOWN_ACCOUNT);
    document.querySelector<HTMLFormElement>('#attribution-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(postMessage.mock.lastCall![0].value.accountId).toBeNull();
    document.querySelector<HTMLButtonElement>('#attribution-assignments button')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'usageAttribution', value: { action: 'remove', id: 'saved' } });
    render({ ...fixture, data: { ...fixture.data!, assignments: [{ id: 'responses', provider: 'Codex', conversationId: 'session', responseIds: ['Codex:first', 'Codex:second'], account }] } });
    expect(document.querySelector('#attribution-assignments')!.textContent).toContain('2 selected responses');
    document.querySelector<HTMLButtonElement>('#attribution-assignments button')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'usageAttribution', value: { action: 'remove', id: 'responses' } });
    render({ ...fixture, attributionBusy: true });
    expect((document.querySelector('#attribution-save') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('#attribution-conversation') as HTMLSelectElement).value).toBe('session');
    expect(document.querySelector('#attribution-status')!.textContent).toContain('Saving');
    render({ ...fixture, attributionError: 'Could not write assignments.' });
    expect(document.querySelector<HTMLElement>('#attribution-error')!.hidden).toBe(false);
    expect(document.querySelector('#attribution-error')!.textContent).toContain('Could not write');
    choose('attribution-conversation', '');
    expect((document.querySelector('#attribution-save') as HTMLButtonElement).disabled).toBe(true);
  });
  it('previews distinct agent icons and switches appearance without losing selected details', () => {
    render();
    expect(document.querySelector('#status-bar-preview .provider-icon[data-provider=Codex]')).not.toBeNull();
    expect(document.querySelector('#status-bar-preview .provider-icon[data-provider=Claude]')).not.toBeNull();
    choose('status-bar-style', 'icons');
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'preferences', value: { statusBar: { style: 'icons' } } });
    const items = [...document.querySelectorAll<HTMLElement>('.status-bar-preview-item')];
    expect(items).toHaveLength(2); expect(items.every(item => item.textContent === '')).toBe(true);
    expect(items[1]!.getAttribute('aria-label')).toContain('Claude Code');
    expect(items[1]!.title).toContain('5h: 75% remaining');
    const quota = document.querySelector<HTMLInputElement>('[data-status-field="quota"]')!;
    expect(quota.disabled).toBe(true); expect(quota.checked).toBe(true);
    choose('status-bar-style', 'text');
    expect(quota.disabled).toBe(false); expect(quota.checked).toBe(true);
    expect(document.querySelectorAll('#status-bar-preview .provider-icon')).toHaveLength(2);
    expect(document.querySelector('#status-bar-preview')!.textContent).toContain('5h 75%');
    expect(document.querySelector('#status-bar-preview')!.textContent).not.toContain('Claude Code');
  });
  it('customizes both status items through Preferences with an accurate preview and host persistence requests', () => {
    render({ ...value, activeProvider: 'Claude' });
    expect(document.querySelectorAll('#status-bar-preview .provider-icon')).toHaveLength(2);
    expect(document.querySelector('#status-bar-preview')!.textContent).toBe('Quota —5h 75%');
    choose('status-bar-providers', 'claude');
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'preferences', value: { statusBar: { providers: 'claude' } } });
    expect(document.querySelector('#status-bar-preview .provider-icon[data-provider=Codex]')).toBeNull();
    const account = document.querySelector<HTMLInputElement>('[data-status-field="account"]')!; account.checked = true; account.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'preferences', value: { statusBar: { fields: ['quota', 'bankedResets', 'account'] } } });
    expect(document.querySelector('#status-bar-preview')!.textContent).toContain('claude@example.test');
    choose('status-bar-windows', 'main'); expect(postMessage).toHaveBeenLastCalledWith({ type: 'preferences', value: { statusBar: { quotaWindows: 'main' } } });
    choose('status-bar-alignment', 'left'); expect(postMessage).toHaveBeenLastCalledWith({ type: 'preferences', value: { statusBar: { alignment: 'left' } } });
    const toggle = document.querySelector<HTMLInputElement>('#show-status-quota')!; toggle.checked = false; toggle.dispatchEvent(new Event('change'));
    expect(document.querySelector('#status-bar-preview')!.textContent).toBe('Status bar hidden');
    expect(account.disabled).toBe(true);
    render({ ...value, preferences: { ...value.preferences, statusBar: { providers: 'codex', fields: ['plan'], quotaWindows: 'main', alignment: 'left', style: 'compact', codexColor: '', claudeColor: '' } } });
    expect(document.querySelector<HTMLSelectElement>('#status-bar-providers')!.value).toBe('codex');
    expect(account.checked).toBe(false); expect(account.disabled).toBe(false);
    expect(document.querySelector('#status-bar-preview')!.textContent).toBe('Plan —');
  });
  it('picks a separate text color for each agent from theme presets or a custom color', () => {
    render();
    const custom = document.querySelector<HTMLInputElement>('#status-bar-codex-custom')!, claude = () => [...document.querySelectorAll<HTMLElement>('.status-bar-preview-item')].at(-1)!;
    expect(claude().style.color).toBe('var(--vscode-charts-green)'); expect(custom.hidden).toBe(true);
    choose('status-bar-claude-color', 'charts.purple');
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'preferences', value: { statusBar: { claudeColor: 'charts.purple' } } });
    expect(claude().style.color).toBe('var(--vscode-charts-purple)');
    choose('status-bar-codex-color', 'custom'); expect(custom.hidden).toBe(false);
    custom.value = '#ff8800'; custom.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'preferences', value: { statusBar: { codexColor: '#ff8800' } } });
    render({ ...value, preferences: { ...value.preferences, statusBar: { providers: 'both', fields: ['quota'], quotaWindows: 'all', alignment: 'right', style: 'compact', codexColor: '#00AA11', claudeColor: '' } } });
    expect(document.querySelector<HTMLSelectElement>('#status-bar-codex-color')!.value).toBe('custom'); expect(custom.value).toBe('#00aa11');
    expect(document.querySelector<HTMLSelectElement>('#status-bar-claude-color')!.value).toBe('');
    expect(document.querySelector<HTMLElement>('.status-bar-preview-item')!.style.color).toBe('rgb(0, 170, 17)');
  });
  it('previews and persists progress bars, retains accessible quota and restores the saved mode', () => {
    render(); choose('status-bar-style', 'progress');
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'preferences', value: { statusBar: { style: 'progress' } } });
    const items = [...document.querySelectorAll<HTMLElement>('.status-bar-preview-item')];
    expect(items.map(item => item.textContent)).toEqual(['Quota —', '5h ███▊░ 75%']);
    expect(items[1]!.getAttribute('aria-label')).toContain('Claude Code');
    expect(items[1]!.title).toContain('5h: 75% remaining');
    expect(document.querySelector<HTMLInputElement>('[data-status-field="quota"]')!.disabled).toBe(false);
    render({ ...value, preferences: { ...value.preferences, statusBar: { providers: 'claude', fields: ['quota'], quotaWindows: 'all', alignment: 'right', style: 'progress', codexColor: '', claudeColor: '' } } });
    expect(document.querySelector<HTMLSelectElement>('#status-bar-style')!.value).toBe('progress');
    expect(document.querySelector('#status-bar-preview')!.textContent).toBe('5h ███▊░ 75%');
    choose('status-bar-style', 'compact');
    expect(document.querySelector('#status-bar-preview')!.textContent).toBe('5h 75%');
    choose('status-bar-style', 'rings');
    expect([...document.querySelectorAll('.status-bar-glyph')].map(glyph => glyph.textContent)).toEqual(['']);
    expect(document.querySelector('#status-bar-preview')!.textContent).toBe('5h  75%');
    choose('status-bar-style', 'minimal');
    expect(document.querySelector('#status-bar-preview')!.textContent).toBe(' 75%');
  });
  it('shows banked reset counts and expiry in dashboard account cards and managed accounts', () => {
    const expiresAt = Date.parse('2026-11-01T00:00:00Z');
    const status = { status: 'ready' as const, account: { signedIn: true, email: 'codex@test', method: 'ChatGPT' }, quota: { status: 'available' as const, windows: [], bankedResets: { availableCount: 2, credits: [{ title: 'Full reset', expiresAt }] } } };
    render({ ...value, accounts: { Codex: status }, managedAccounts: [{ id: 'codex-profile', provider: 'Codex', label: 'Work', createdAt: 1, status, active: true }] });
    for (const selector of ['#accounts', '#account-groups', '#managed-accounts']) {
      const root = document.querySelector(selector)!;
      expect(root.textContent).toContain('Banked resets: 2 available');
      expect(root.textContent).toContain(`Expires ${new Date(expiresAt).toLocaleString()}`);
    }
    const button = document.querySelector<HTMLButtonElement>('#accounts [data-reset-usage]')!;
    expect(button.textContent).toBe('Reset usage · uses 1 reset'); expect(button.disabled).toBe(false);
    button.click(); expect(button.disabled).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'accountAction', value: { action: 'resetUsage', provider: 'Codex' } });
    render({ ...value, accounts: { Codex: { ...status, quotaCached: true } } });
    expect(document.querySelector<HTMLButtonElement>('#accounts [data-reset-usage]')!.disabled).toBe(true);
    render({ ...value, accountsBusy: true, accounts: { Codex: status } });
    expect(document.querySelector<HTMLButtonElement>('#accounts [data-reset-usage]')!.disabled).toBe(true);
  });
  it('shows live switch progress, lets users hide and reopen it, and retains rollback/error logs without reopening on every update', () => {
    const operation: NonNullable<UsageDashboardState['accountSwitch']> = { id: 'operation-one', profileId: 'selected', provider: 'Codex', label: 'Work', startedAt: Date.now(), status: 'running', outcome: 'notChanged', logs: [{ at: Date.now(), level: 'info', message: 'Backing up the current sign-in.' }] };
    render({ ...value, accountsBusy: true, accountSwitch: operation });
    const dialog = document.querySelector<HTMLDialogElement>('#account-switch-dialog')!;
    expect(dialog.open).toBe(true); expect(document.querySelector('#account-switch-result')?.textContent).toContain('Backing up'); expect(document.querySelector('#account-switch-target')?.textContent).toContain('Work');
    document.querySelector<HTMLButtonElement>('#account-switch-close')!.click(); expect(dialog.open).toBe(false);
    render({ ...value, accountsBusy: true, accountSwitch: { ...operation, logs: [...operation.logs, { at: Date.now(), level: 'info', message: 'Checking the selected sign-in.' }] } }); expect(dialog.open).toBe(false);
    document.querySelector<HTMLButtonElement>('#account-switch-view')!.click(); expect(dialog.open).toBe(true);
    render({ ...value, accountSwitch: { ...operation, status: 'error', outcome: 'restored', error: 'Native CLI did not verify the selected sign-in.', finishedAt: Date.now(), logs: [...operation.logs, { at: Date.now(), level: 'success', message: 'Previous sign-in restored.' }] } });
    expect(document.querySelector('#account-switch-title')?.textContent).toBe('Switch failed'); expect(document.querySelector('#account-switch-result')?.textContent).toContain('previous sign-in was restored');
    expect(document.querySelector('#account-switch-log')?.textContent).toContain('Previous sign-in restored'); expect(document.querySelector('#account-switch-error')?.textContent).toContain('did not verify');
    expect(document.querySelector('#account-switch-close')?.textContent).toBe('Close');
  });
  it('filters and searches all four account apps, with native desktop actions and an inline connection panel', () => {
    const profile = (provider: 'Codex' | 'Cursor' | 'Antigravity', email: string) => ({ id: `${provider}-opaque-id`, provider, label: `${provider} work`, createdAt: 1, identity: { signedIn: true, email, method: `${provider} account` } });
    render({ ...value, managedAccounts: [profile('Codex', 'codex@test'), profile('Cursor', 'cursor@test'), profile('Antigravity', 'gravity@test')] });
    expect(document.querySelectorAll('#account-platforms button')).toHaveLength(5);
    expect(document.querySelectorAll('.managed-account')).toHaveLength(3);
    [...document.querySelectorAll<HTMLButtonElement>('#account-platforms button')].find(button => button.textContent?.includes('Cursor'))!.click();
    expect(document.querySelectorAll('.managed-account')).toHaveLength(1); expect(document.querySelector('.account-state')?.textContent).toBe('Saved');
    [...document.querySelectorAll<HTMLButtonElement>('.managed-account button')].find(button => button.textContent === 'Open app')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'accountAction', value: { action: 'open', id: 'Cursor-opaque-id' } });
    document.querySelector<HTMLButtonElement>('#account-connect')!.click(); expect(document.querySelector<HTMLElement>('#account-connection')!.hidden).toBe(false);
    expect(document.querySelector<HTMLSelectElement>('#account-provider')!.value).toBe('Cursor'); expect(document.querySelector('#account-add')!.textContent).toBe('Open Cursor');
    document.querySelector<HTMLButtonElement>('#account-save')!.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'accountAction', value: { action: 'importCurrent', provider: 'Cursor' } });
    const search = document.querySelector<HTMLInputElement>('#account-search')!; search.value = 'no-match'; search.dispatchEvent(new Event('input')); expect(document.querySelectorAll('.managed-account')).toHaveLength(0); expect(document.querySelector('.account-empty')?.textContent).toContain('No matching accounts');
  });
  it('defaults to account groups, opens a saved account with its own quota, and can show All accounts', () => {
    const now = Date.parse('2026-10-13T06:00:00Z'); vi.spyOn(Date, 'now').mockReturnValue(now);
    const one = { signedIn: true, email: 'one@test', method: 'ChatGPT', plan: 'plus' }, two = { ...one, email: 'two@test' };
    const first = { ...row('2026-10-13', 'Codex', 'model', 100), account: usageAccount('Codex', one)! }, second = { ...row('2026-10-13', 'Codex', 'model', 200), account: usageAccount('Codex', two)! };
    const status = (identity: typeof one, usedPercent: number) => ({ status: 'ready' as const, account: identity, updatedAt: now, quota: { status: 'available' as const, windows: [{ id: '5h', label: '5h', usedPercent, resetsAt: now + 3600000 }] } });
    render({ ...value, data: { ...value.data!, days: [first, second] }, accounts: { Codex: status(one, 20) }, managedAccounts: [{ id: '11111111-1111-4111-8111-111111111111', provider: 'Codex', label: 'Work', identity: two, createdAt: now, status: status(two, 60) }] });
    expect(document.querySelector<HTMLSelectElement>('#dashboard-view')!.value).toBe('accounts');
    expect(document.querySelector<HTMLElement>('#dashboard-detail')!.hidden).toBe(true);
    expect(document.querySelectorAll('.account-group')).toHaveLength(2);
    const work = [...document.querySelectorAll('.account-group')].find(row => row.textContent?.includes('Work'))!;
    expect(work.textContent).toContain('40% left'); work.querySelector<HTMLButtonElement>('button')!.click();
    expect(document.querySelector<HTMLSelectElement>('#filter-account')!.value).toBe(second.account.id);
    expect(document.querySelector<HTMLElement>('#dashboard-detail')!.hidden).toBe(false);
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('200');
    expect(document.querySelector('#accounts')!.textContent).toContain('two@test');
    expect(document.querySelector('#accounts')!.textContent).toContain('40% left');
    expect(document.querySelector('#accounts')!.textContent).not.toContain('80% left');
    expect(document.querySelector<HTMLElement>('#account-overview')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#account-detail-bar')!.hidden).toBe(false);
    expect(document.querySelector('#account-detail-title')!.textContent).toBe('Work');
    document.querySelector<HTMLButtonElement>('#account-detail-back')!.click();
    expect(document.querySelector<HTMLSelectElement>('#filter-account')!.value).toBe('');
    expect(document.querySelector<HTMLElement>('#account-overview')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#dashboard-detail')!.hidden).toBe(true);
    [...document.querySelectorAll('.account-group')].find(row => row.textContent?.includes('Work'))!.querySelector<HTMLButtonElement>('button')!.click();
    choose('dashboard-view', 'all'); expect(document.querySelector<HTMLElement>('#account-overview')!.hidden).toBe(true);
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('300');
    expect(document.querySelector<HTMLSelectElement>('#filter-account')!.value).toBe('');
  });
  it('opens conversation usage details, respects dashboard filters and safely renders native titles', () => {
    const now = Date.parse('2026-10-13T06:00:00Z'); vi.spyOn(Date, 'now').mockReturnValue(now);
    const codex = row('2026-10-13', 'Codex', 'codex-model', 1200), claude = row('2026-10-13', 'Claude', 'claude-model', 2400);
    render({ ...value, conversationTitles: { 'Codex:one': '<img src=x onerror=alert(1)>', 'Claude:two': 'Fix dashboard' }, data: { ...value.data!, days: [codex, claude], conversations: [
      { key: 'Codex:one', id: 'one', provider: 'Codex', project: 'L:/one', firstAt: now - 600000, lastAt: now, days: [codex] },
      { key: 'Claude:two', id: 'two', provider: 'Claude', project: 'L:/two', firstAt: now - 1200000, lastAt: now, days: [claude] },
    ] } });
    expect(document.querySelectorAll('#conversation-breakdown tbody tr')).toHaveLength(2);
    const link = document.querySelector<HTMLButtonElement>('#conversation-breakdown tbody tr:first-child button')!; link.click();
    expect(document.querySelector<HTMLElement>('#conversation-detail')!.hidden).toBe(false);
    expect(document.querySelector('#conversation-title')!.textContent).toBe('Fix dashboard');
    expect(document.querySelector('#conversation-totals strong')!.getAttribute('title')).toBe('2,400');
    expect(document.querySelector('#conversation-quota')!.textContent).toContain('120 tokens / min');
    expect(document.querySelector('#conversation-models')!.textContent).toContain('claude-model');
    choose('filter-provider', 'Codex'); expect(document.querySelectorAll('#conversation-breakdown tbody tr')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('#conversation-detail')!.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>('#conversation-breakdown button')!.click(); expect(document.querySelector('#conversation-title img')).toBeNull();
    const search = document.querySelector<HTMLInputElement>('#conversation-search')!; search.value = 'missing'; search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('#conversation-breakdown tbody tr')).toHaveLength(0);
  });
  it('shows measured quota pace and wires managed-account buttons to opaque IDs', () => {
    const now = Date.parse('2026-10-13T06:00:00Z'); vi.spyOn(Date, 'now').mockReturnValue(now);
    const identity = { signedIn: true, email: 'one@test', method: 'ChatGPT', plan: 'plus' };
    const accountId = usageAccount('Codex', identity)!.id;
    const status = { status: 'ready' as const, account: identity, updatedAt: now, quota: { status: 'available' as const, windows: [{ id: 'primary', label: '5h', usedPercent: 50, resetsAt: now + 4.5 * 3600000 }] } };
    const tick = { provider: 'Codex' as const, accountId, plan: 'plus', windowId: 'primary', label: '5h', resetsAt: now + 4.5 * 3600000, at: now - 3600000, usedPercent: 25 };
    const profile = { id: '11111111-1111-4111-8111-111111111111', provider: 'Codex' as const, label: 'Work', identity, createdAt: now, status };
    const state = { ...value, accounts: { Codex: status }, quotaTicks: [tick], managedAccounts: [profile] };
    render(state); expect(document.querySelector('#quota-pace')!.textContent).toContain('25% / hour');
    expect(document.querySelector('#quota-pace')!.textContent).toContain('before reset');
    expect(document.querySelector('#quota-pace .burn-verdict')!.getAttribute('data-state')).toBe('over');
    expect(document.querySelector('#quota-pace polyline')!.getAttribute('points')).toBeTruthy();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'page', page: 'accounts' } }));
    expect(document.querySelector<HTMLElement>('#managed-accounts')!.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('#managed-account-list button')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'accountAction', value: { action: 'switch', id: profile.id } });
    render({ ...state, accountSwitchBlocked: 'Finish the active turn.' });
    expect(document.querySelector<HTMLButtonElement>('#managed-account-list button')!.disabled).toBe(true);
    expect(document.querySelector('#accounts-notice')!.textContent).toContain('Finish the active turn.');
    render({ ...state, accountsBusy: true }); expect(document.querySelector<HTMLButtonElement>('#account-add')!.disabled).toBe(true);
    render({ ...state, accountsError: 'Native CLI rejected sign-in.' }); expect(document.querySelector<HTMLElement>('#accounts-error')!.hidden).toBe(false);
    render({ ...state, managedAccounts: [{ ...profile, status: { ...status, quotaCached: true } }] });
    expect(document.querySelector('#managed-account-list')!.textContent).toContain('5h · 50% left');
    expect(document.querySelector('#managed-account-list .account-checked')!.textContent).toContain('Cached quota');
  });
  it('shows Device fallback and compares reset cycles without assigning unknown token history to an account', () => {
    const now = Date.parse('2026-10-13T06:00:00Z'); vi.spyOn(Date, 'now').mockReturnValue(now);
    const identity = { signedIn: true, email: 'codex@test.invalid', method: 'ChatGPT', plan: 'plus' };
    const accountId = usageAccount('Codex', identity)!.id;
    const account = { status: 'ready' as const, account: identity, updatedAt: now,
      quota: { status: 'available' as const, windows: [{ id: 'weekly', label: '7d', usedPercent: 20, resetsAt: now + 86400000 }] } };
    const recent = [{ provider: 'Codex' as const, timestamp: now - 60000, total: 1000000 }];
    const sample: QuotaObservation = { provider: 'Codex', accountId, plan: 'plus', label: 'Weekly', source: 'Device',
      from: now - 13 * 86400000, resetsAt: now - 6 * 86400000, to: now - 7 * 86400000, observedTokens: 500000, usedPercent: 20 };
    render({ ...value, data: { ...value.data!, updatedAt: now, recent }, accounts: { Codex: account }, quotaHistory: [sample] });
    const root = document.getElementById('quota-estimates')!;
    expect(root.textContent).toContain('Device estimate · 2 cycles');
    expect(root.textContent).toContain('Includes history without native turn identity');
    expect(root.querySelector('.quota-estimate-value')!.getAttribute('title')).toBe('37,500 tokens per percentage point');
    expect(root.querySelector('.quota-cycle-capacity')?.getAttribute('data-basis')).toBe('current');
    expect(root.querySelector('.quota-cycle-capacity')?.getAttribute('title')).toContain('5,000,000 estimated tokens for 100% quota');
    const latest = root.querySelectorAll('.quota-trend-history tbody tr:first-child td');
    expect(latest[0]?.textContent).toContain('current'); expect(latest[0]?.getAttribute('title')).toContain('Partial observation');
    expect(latest[1]?.textContent).toBe('Start unknown');
    expect(latest[2]?.textContent).toBe('1,000,000');
    expect(latest[3]?.textContent).toBe('20'); expect(latest[4]?.textContent).toBe('50,000');
    expect(latest[5]?.getAttribute('title')).toBe('5,000,000'); expect(latest[6]?.textContent).toBe('+100%');
    expect(root.querySelector('.quota-calculation')?.textContent).toContain('1,500,000 recorded tokens ÷ 40 quota percentage points');
    expect(root.querySelector('.quota-recorded-period')?.textContent).toContain(new Date(now).toLocaleString());
    expect(recent[0]).not.toHaveProperty('accountId');
    expect(document.querySelector('.quota-estimate-note details[open]')).toBeNull();
    expect(document.querySelector('.quota-estimate-note')?.tagName).toBe('DETAILS');
  });
  it('keeps cycle history compact and lets users expand earlier resets', () => {
    const now = Date.parse('2026-10-13T06:00:00Z'); vi.spyOn(Date, 'now').mockReturnValue(now);
    const identity = { signedIn: true, email: 'codex@test.invalid', method: 'ChatGPT', plan: 'plus' };
    const quotaHistory: QuotaObservation[] = Array.from({ length: 5 }, (_, i) => ({ provider: 'Codex',
      accountId: usageAccount('Codex', identity)!.id, plan: 'plus', label: '5h', from: now - (i + 1) * 5 * 3600000,
      resetsAt: now - i * 5 * 3600000, to: now - i * 5 * 3600000 - 60000, observedTokens: 1000 * (i + 1), usedPercent: 10 }));
    render({ ...value, accounts: { Codex: { status: 'ready', account: identity } }, quotaHistory });
    const root = document.querySelector('.quota-trend-history')!, rows = [...root.querySelectorAll<HTMLElement>('tbody tr')];
    expect(rows.filter(row => !row.hidden)).toHaveLength(3);
    const button = root.querySelector('button')!; button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true'); expect(rows.every(row => !row.hidden)).toBe(true);
    button.click(); expect(rows.filter(row => !row.hidden)).toHaveLength(3);
  });
  it('collapses weekly reset jitter and labels only the current reading in both table and chart', () => {
    const now = Date.parse('2026-10-27T23:30:00+07:00'); vi.spyOn(Date, 'now').mockReturnValue(now);
    const identity = { signedIn: true, email: 'codex@test.invalid', method: 'ChatGPT', plan: 'plus' };
    const old: QuotaObservation = { provider: 'Codex', accountId: usageAccount('Codex', identity)!.id, plan: 'plus', label: 'Weekly',
      from: Date.parse('2026-10-25T16:45:25+07:00'), to: Date.parse('2026-10-26T11:57:31+07:00'), resetsAt: Date.parse('2026-11-01T16:45:25+07:00'), observedTokens: 41907611, usedPercent: 17 };
    const first = { ...old, from: Date.parse('2026-10-26T13:13:13+07:00'), to: Date.parse('2026-10-27T22:34:15+07:00'),
      resetsAt: Date.parse('2026-11-02T13:13:13+07:00'), observedTokens: 194911940, usedPercent: 35 };
    const latest = { ...first, from: first.from - 1000, resetsAt: first.resetsAt - 1000, to: Date.parse('2026-10-27T23:09:15+07:00'), observedTokens: 222856032, usedPercent: 39 };
    const account = { status: 'ready' as const, account: identity, updatedAt: now, quota: { status: 'available' as const,
      windows: [{ id: 'weekly', label: '7d', resetsAt: latest.resetsAt + 500, usedPercent: 39 }] } };
    render({ ...value, data: undefined, accounts: { Codex: account }, quotaHistory: [first, latest, old] });
    const root = document.querySelector('#quota-estimates')!;
    const rows = [...root.querySelectorAll('.quota-trend-history tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows.filter(row => row.children[0]!.textContent?.includes('current'))).toHaveLength(1);
    expect(rows[0]?.children[2]?.textContent).toBe('222,856,032');
    expect(root.querySelectorAll('.quota-chart-point[data-current=true]')).toHaveLength(1);
    expect(root.querySelector('.quota-cycle-capacity')?.getAttribute('data-basis')).toBe('current');
    render({ ...value, data: undefined, accounts: { Codex: { ...account, quota: { ...account.quota, windows: [{ ...account.quota.windows[0]!, resetsAt: latest.resetsAt + 86400000 }] } } }, quotaHistory: [first, latest, old] });
    expect(document.querySelectorAll('#quota-estimates .quota-chart-point[data-current=true]')).toHaveLength(0);
    expect(document.querySelector('.quota-cycle-capacity')?.getAttribute('data-basis')).toBe('history');
  });
  it('uses the last full-quota start for labels and current status, closing it immediately on a new full reading', () => {
    const now = Date.parse('2026-10-27T23:30:00+07:00'); vi.spyOn(Date, 'now').mockReturnValue(now);
    const identity = { signedIn: true, email: 'codex@test.invalid', method: 'ChatGPT', plan: 'plus' };
    const scope = { provider: 'Codex' as const, accountId: usageAccount('Codex', identity)!.id, plan: 'plus', label: 'Weekly' as const };
    const from = now - 86400000;
    const sample: QuotaObservation = { ...scope, from, to: now, resetsAt: now + 6 * 86400000, observedTokens: 1000, usedPercent: 20,
      cycleStartedAt: from, cycleStartKnown: true, startUsedPercent: 0 };
    const account = { status: 'ready' as const, account: identity, updatedAt: now, quota: { status: 'available' as const,
      windows: [{ id: 'weekly', label: '7d', resetsAt: now + 2 * 86400000, usedPercent: 20 }] } };
    const quotaCycleStarts = [{ ...scope, from, startUsedPercent: 0, usedPercent: 20, to: now }];
    render({ ...value, data: undefined, accounts: { Codex: account }, quotaCycleStarts, quotaHistory: [sample] });
    const root = document.querySelector('#quota-estimates')!;
    expect(root.querySelector('th')?.textContent).toBe('Cycle start');
    expect(root.querySelectorAll('.quota-chart-point[data-current=true]')).toHaveLength(1);
    expect(root.querySelector('.quota-recorded-period')?.textContent).toBe(`${new Date(from).toLocaleString()} – ${new Date(now).toLocaleString()}`);
    expect(root.querySelector('.quota-cycle-capacity')?.getAttribute('data-basis')).toBe('current');
    vi.spyOn(Date, 'now').mockReturnValue(now + 60000);
    render({ ...value, data: undefined, accounts: { Codex: { ...account, updatedAt: now + 60000,
      quota: { ...account.quota, windows: [{ ...account.quota.windows[0]!, usedPercent: 0 }] } } }, quotaCycleStarts, quotaHistory: [sample] });
    expect(document.querySelectorAll('#quota-estimates .quota-chart-point[data-current=true]')).toHaveLength(0);
    expect(document.querySelector('.quota-trend-history tbody td')?.textContent).not.toContain('current');
    expect(document.querySelector('.quota-cycle-capacity')?.getAttribute('data-basis')).toBe('history');
    const partial = { ...sample, cycleStartKnown: false, startUsedPercent: 30, usedPercent: 10 };
    render({ ...value, data: undefined, accounts: { Codex: account }, quotaCycleStarts: [{ ...quotaCycleStarts[0]!, startUsedPercent: 30, usedPercent: 40 }], quotaHistory: [partial] });
    expect(document.querySelector('.quota-trend-history tbody td')?.textContent).toContain('partial');
    expect(document.querySelector('.quota-interval-chart')?.textContent).toContain('100% start not observed');
    expect(document.querySelector('.quota-interval-chart')?.textContent).toContain('70% → 60%');
    expect(document.querySelector('#quota-estimates')?.textContent).toMatch(/≈ 6[kK] tokens left/);
  });
  it('shows persisted API baseline progress and then the API ratio without local attribution', () => {
    const now = Date.parse('2026-10-13T06:00:00Z'); vi.spyOn(Date, 'now').mockReturnValue(now);
    const identity = { signedIn: true, email: 'codex@test.invalid', method: 'ChatGPT', plan: 'plus' };
    const account = { status: 'ready' as const, account: identity, updatedAt: now,
      quota: { status: 'available' as const, windows: [{ id: 'weekly', label: '7d', usedPercent: 18, resetsAt: now + 86400000 }] },
      usage: { source: 'API' as const, status: 'available' as const, accountId: usageAccount('Codex', identity)!.id, updatedAt: now, summary: { lifetimeTokens: 10200000 } } };
    const latest = quotaMeters('Codex', account, now)[0]!, start = { ...latest, to: now - 60000, totalTokens: 10000000, usedPercent: 16 };
    const baseline = { start, latest };
    render({ ...value, data: undefined, accounts: { Codex: { ...account, usage: { ...account.usage, summary: { lifetimeTokens: start.totalTokens } } } }, quotaBaselines: [{ start, latest: start }] });
    expect(document.querySelector('#quota-estimates')!.textContent).toContain('Waiting for API tokens to update');
    render({ ...value, data: undefined, accounts: { Codex: account }, quotaBaselines: [baseline] });
    expect(document.querySelector('.quota-estimate-value')!.getAttribute('title')).toBe('100,000 tokens per percentage point');
    render({ ...value, data: undefined, accounts: { Codex: account }, quotaBaselines: [baseline], quotaHistory: [{ provider: 'Codex', accountId: latest.accountId,
      plan: 'plus', label: 'Weekly', from: start.to, to: now, resetsAt: latest.resetsAt, observedTokens: 200000, usedPercent: 2, source: 'API' }] });
    const root = document.querySelector('#quota-estimates')!;
    expect(root.querySelector('.quota-estimate-value')!.getAttribute('title')).toBe('100,000 tokens per percentage point');
    expect(root.querySelector('.quota-estimate-source')!.getAttribute('title')).toContain('API counters');
    const cells = root.querySelectorAll('.quota-trend-history tbody tr:first-child td');
    expect(cells[1]?.textContent).toBe('84% → 82%');
    expect(cells[2]?.textContent).toBe('200,000');
    expect(cells[3]?.textContent).toBe('2');
    expect(cells[4]?.getAttribute('title')).toBe('200,000 tokens ÷ 2 percentage points');
    expect(root.textContent).toContain('8.2M tokens left');
    expect(root.querySelector('.quota-cycle-capacity')?.textContent).toContain('≈ 10M tokens / cycle');
    expect(root.querySelector('.quota-cycle-capacity')?.getAttribute('data-basis')).toBe('current');
    const before = root.textContent; choose('filter-provider', 'Claude'); expect(root.textContent).toBe(before);
  });
  it('shows legacy API deltas without inventing a 100% starting point', () => {
    const now = Date.parse('2026-10-13T06:00:00Z'); vi.spyOn(Date, 'now').mockReturnValue(now);
    const identity = { signedIn: true, email: 'codex@test.invalid', method: 'ChatGPT', plan: 'plus' };
    const sample: QuotaObservation = { provider: 'Codex', accountId: usageAccount('Codex', identity)!.id, plan: 'plus', label: '5h', source: 'API',
      from: now - 60000, to: now, resetsAt: now + 3600000, observedTokens: 200000, usedPercent: 2 };
    render({ ...value, data: undefined, accounts: { Codex: { status: 'ready', account: identity } }, quotaHistory: [sample] });
    const cells = document.querySelectorAll('.quota-trend-history tbody tr:first-child td');
    expect(cells[1]?.textContent).toBe('Start unknown'); expect(cells[2]?.textContent).toBe('200,000');
    expect(cells[3]?.textContent).toBe('2');
    expect(document.querySelector('.quota-cycle-capacity')?.getAttribute('title')).toContain('10,000,000 estimated tokens for 100% quota');
    expect(document.querySelector('.quota-cycle-capacity')?.getAttribute('data-basis')).toBe('history');
  });
  it('filters restore history, selects visible conversations, previews impact and sends only the delete token', () => {
    const group = (id: string, projectId: string, kind: 'checkpoints' | 'undo' = 'checkpoints') => ({ id, projectId, project: `L:/Code/${projectId}`, label: kind === 'undo' ? 'Last restore backup' : `Codex:${id}`, kind, count: 2, bytes: 1024, reclaimable: 512, createdAt: 1000, updatedAt: 2000 });
    const histories = [group('first', 'one'), group('second', 'two'), group('backup', 'one', 'undo')];
    const storage = { status: 'ready' as const, root: 'root', histories, total: 3000 };
    render({ ...value, storage }); choose('storage-project', 'one'); choose('storage-kind', 'checkpoints');
    expect(document.querySelectorAll('.storage-history-row')).toHaveLength(1);
    document.querySelector<HTMLButtonElement>('#storage-select-visible')!.click();
    expect(document.querySelector('#storage-selection')!.textContent).toContain('1 selected · 2 restore points · frees at least 512 B');
    expect(document.querySelector('.storage-history-size')!.textContent).toBe('512 Bof 1.0 KB referenced');
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
    render({ ...value, storage: { ...storage, histories: histories.slice(1), historyResult: { checkpointsRemoved: 2, trackingStopped: 0, removed: 1, bytes: 100, skipped: 1, failures: ['locked: EBUSY'] } } });
    expect(document.querySelector('#storage-selection')!.textContent).toContain('No history selected');
    expect(document.querySelector('#storage-history-result')!.textContent).toContain('Deleted 2 restore points');
    expect(document.querySelector('#storage-history-result')!.textContent).not.toContain('tracking');
    expect(document.querySelector('#storage-history-result')!.textContent).toContain('locked: EBUSY');
  });
  it('offers change tracking baselines as opt-in cleanup and explains that tracking stops', () => {
    const tracking = { id: 'track', projectId: 'one', project: 'L:/Code/big', label: 'Change tracking baseline', kind: 'tracking' as const, count: 0, bytes: 2048, reclaimable: 1024, createdAt: 1, updatedAt: 2 };
    const checkpoint = { id: 'one', projectId: 'one', project: 'L:/Code/big', label: 'Codex:one', kind: 'checkpoints' as const, count: 3, bytes: 1, reclaimable: 1, createdAt: 1, updatedAt: 2 };
    const storage = { status: 'ready' as const, root: 'root', histories: [tracking, checkpoint], cleanable: { files: 0, bytes: 0 } };
    render({ ...value, storage }); choose('storage-kind', 'tracking');
    expect(document.querySelectorAll('.storage-history-row')).toHaveLength(1);
    expect(document.querySelector('.storage-history-row')!.textContent).toContain('Deleting stops change tracking for this project');
    document.querySelector<HTMLButtonElement>('#storage-select-visible')!.click();
    expect(document.querySelector('#storage-selection')!.textContent).toBe('1 selected · 0 restore points · 1 tracking baseline · frees at least 1.0 KB');
    choose('storage-kind', '');
    document.querySelector<HTMLButtonElement>('#storage-clean-all')!.click();
    const kind = (name: string) => document.querySelector<HTMLInputElement>(`input[data-clean-kind="${name}"]`)!;
    expect(kind('tracking').checked).toBe(false); expect(kind('tracking').disabled).toBe(false);
    expect(document.querySelector('#storage-clean-choices')!.textContent).toContain('1 project · stops change tracking');
    kind('tracking').click(); document.querySelector<HTMLButtonElement>('#storage-clean-review')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewCleanAll', value: { kinds: ['checkpoints', 'tracking'] } });
    const historyPlan = { token: 'track', createdAt: Date.now(), histories: [tracking], records: [], files: [], bytes: 1024, kinds: ['tracking' as const] };
    render({ ...value, storage: { ...storage, historyPlan } });
    expect(document.querySelector('#storage-history-plan-heading')!.textContent).toBe('Clean up change tracking baselines');
    const impact = document.querySelector('#storage-history-impact')!.textContent;
    expect(impact).toContain('Change tracking stops in 1 project'); expect(impact).not.toContain('permanently unavailable'); expect(impact).not.toContain('tracking baselines stay');
    expect(document.querySelector('#storage-history-plan-groups')!.textContent).toContain('stops tracking');
    render({ ...value, storage: { ...storage, historyResult: { checkpointsRemoved: 0, trackingStopped: 1, removed: 3, bytes: 1024, skipped: 0, failures: [] } } });
    expect(document.querySelector('#storage-history-result')!.textContent).toContain('Deleted 0 restore points · stopped change tracking in 1 project · 1.0 KB freed');
  });
  it('quick-selects the biggest space savers or stale history within the current filters', () => {
    const day = 86_400_000, now = Date.now();
    const group = (id: string, reclaimable: number, age: number, projectId = 'one') => ({ id, projectId, project: projectId, label: `Codex:${id}`, kind: 'checkpoints' as const, count: 1, bytes: reclaimable + 100, reclaimable, createdAt: now - age, updatedAt: now - age });
    const histories = [group('huge', 900, 0), group('big', 300, 10 * day), group('small', 50, 40 * day), group('shared', 0, 40 * day), group('other', 5000, 40 * day, 'two')];
    render({ ...value, storage: { status: 'ready', root: 'root', histories } }); choose('storage-project', 'one');
    const selected = () => [...document.querySelectorAll<HTMLInputElement>('.storage-history-row input')].filter(input => input.checked).map(input => input.dataset.historyId);
    const quick = document.querySelector<HTMLSelectElement>('#storage-quick-select')!;
    choose('storage-quick-select', 'space'); expect(selected()).toEqual(['huge', 'big']); expect(quick.value).toBe('');
    choose('storage-quick-select', 'week'); expect(selected()).toEqual(['big', 'small', 'shared']);
    choose('storage-quick-select', 'month'); expect(selected()).toEqual(['small', 'shared']);
    document.querySelector<HTMLButtonElement>('#storage-history-preview')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewHistoryDeletion', value: { ids: ['small', 'shared'] } });
  });
  it('lets the storage heading choose what to clean up and confirms it from the same preview', () => {
    const histories = [{ id: 'one', projectId: 'one', project: 'project', label: 'Codex:one', kind: 'checkpoints' as const, count: 3, bytes: 1, reclaimable: 1, createdAt: 1, updatedAt: 2 }];
    const button = document.querySelector<HTMLButtonElement>('#storage-clean-all')!, chooser = document.querySelector<HTMLElement>('#storage-clean-choices')!;
    const review = document.querySelector<HTMLButtonElement>('#storage-clean-review')!;
    const kind = (name: string) => document.querySelector<HTMLInputElement>(`input[data-clean-kind="${name}"]`)!;
    render({ ...value, storage: { status: 'ready', root: 'root', histories: [], cleanable: { files: 0, bytes: 0 } } }); expect(button.disabled).toBe(true);
    const storage = { status: 'ready' as const, root: 'root', histories, cleanable: { files: 2, bytes: 2048 } };
    render({ ...value, storage }); expect(button.disabled).toBe(false); expect(chooser.hidden).toBe(true);
    button.click(); expect(chooser.hidden).toBe(false); expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'previewCleanAll' }));
    expect(kind('checkpoints').checked).toBe(true); expect(kind('unused').checked).toBe(true);
    expect(kind('undo').disabled).toBe(true); expect(chooser.textContent).toContain('3 restore points in 1 conversation');
    kind('unused').click(); expect(kind('unused').checked).toBe(false);
    review.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewCleanAll', value: { kinds: ['checkpoints'] } });
    kind('checkpoints').click(); expect(review.disabled).toBe(true);
    kind('checkpoints').click(); kind('unused').click();
    const historyPlan = { token: 'chosen', createdAt: Date.now(), histories, records: [], files: [], bytes: 0, kinds: ['checkpoints' as const, 'unused' as const] };
    render({ ...value, storage: { ...storage, historyPlan } });
    expect(chooser.hidden).toBe(true); expect(button.disabled).toBe(true);
    expect(document.querySelector('#storage-history-plan-heading')!.textContent).toBe('Clean up message checkpoints and unused snapshots');
    expect(document.querySelector('#storage-history-impact')!.textContent).toContain('Every message checkpoint will be permanently unavailable');
    expect(document.querySelector('#storage-history-impact')!.textContent).not.toContain('restore backup');
    expect(document.querySelector('#storage-history-delete')!.textContent).toBe('Clean up');
    document.querySelector<HTMLButtonElement>('#storage-history-delete')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'deleteHistory', value: { token: 'chosen' } });
    render({ ...value, storage: { ...storage, historyPlan: { ...historyPlan, token: 'selected', kinds: undefined } } });
    expect(document.querySelector('#storage-history-delete')!.textContent).toBe('Delete history');
  });
  it('shows deletion progress inside the preview that started it without rebuilding history rows', () => {
    const histories = [{ id: 'one', projectId: 'one', project: 'project', label: 'Codex:one', kind: 'checkpoints' as const, count: 1, bytes: 1, reclaimable: 1, createdAt: 1, updatedAt: 2 }];
    const plan = { token: 'cleanup', createdAt: Date.now(), files: [{ relative: 'reviews/history/blobs/a', bytes: 2048, modified: 1, changed: 1, inode: 1 }], bytes: 4096 };
    const storage = { status: 'cleaning' as const, root: 'root', histories, plan };
    render({ ...value, storage });
    const cleanup = document.querySelector<HTMLElement>('#storage-cleanup-progress')!, bar = document.querySelector<HTMLProgressElement>('#storage-cleanup-progress-bar')!;
    expect(cleanup.hidden).toBe(false); expect(document.querySelector<HTMLElement>('#storage-history-progress')!.hidden).toBe(true);
    expect(bar.hasAttribute('value')).toBe(false); expect(cleanup.textContent).toContain('Checking references');
    const row = document.querySelector('.storage-history-row');
    render({ ...value, storage: { ...storage, progress: { phase: 'removing', done: 3, total: 4, bytes: 3072, totalBytes: 4096 } } });
    expect(bar.value).toBe(75); expect(cleanup.textContent).toContain('Removing files'); expect(cleanup.textContent).toContain('75% · 3 / 4 files');
    expect(document.querySelector('#storage-status')!.textContent).toContain('3 / 4 files');
    expect(document.querySelector('.storage-history-row')).toBe(row);
    render({ ...value, storage: { status: 'cleaning', root: 'root', histories, historyPlan: { ...plan, histories, records: [] }, progress: { phase: 'history', done: 0, total: 1, bytes: 0, totalBytes: 2048 } } });
    expect(cleanup.hidden).toBe(true); expect(document.querySelector('#storage-history-progress')!.textContent).toContain('Updating restore history');
    render({ ...value, storage: { status: 'ready', root: 'root', histories, result: { removed: 4, bytes: 4096, skipped: 0, failures: [] } } });
    expect(document.querySelector<HTMLElement>('#storage-history-progress')!.hidden).toBe(true);
  });
  it('renders untrusted history labels as text and disables history deletion on unreadable metadata', () => {
    const histories = [{ id: 'one', projectId: 'one', project: 'project', label: '<img src=x onerror=alert(1)>', kind: 'checkpoints' as const, count: 1, bytes: 1, reclaimable: 1, createdAt: 1, updatedAt: 2 }];
    render({ ...value, storage: { status: 'ready', root: 'root', histories } });
    expect(document.querySelector('#storage-histories img')).toBeNull(); expect(document.querySelector('#storage-histories')!.textContent).toContain('<img');
    render({ ...value, storage: { status: 'ready', root: 'root', histories, cleanupBlocked: 'Unreadable metadata' } });
    expect(document.querySelector<HTMLButtonElement>('#storage-history-preview')!.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('.storage-history-row input')!.disabled).toBe(true);
  });
  it('keeps history rows on quota/status updates and rebuilds them after a usage refresh', () => {
    render(); choose('filter-range', 'all');
    const row = document.querySelector('#period-breakdown tr.model-row')!;
    expect(row).toBeTruthy();
    render({ ...value, accounts: { Claude: { ...value.accounts!.Claude!, status: 'loading' } } });
    expect(document.querySelector('#period-breakdown tr.model-row')).toBe(row);
    render({ ...value, data: { ...value.data!, files: value.data!.files + 1 } });
    expect(document.querySelector('#period-breakdown tr.model-row')).not.toBe(row);
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
    expect(api.textContent).toContain('Model filter: Local only');
    expect(api.querySelector('strong')?.getAttribute('title')).toBe('700,000');
    render({ ...value, accounts: { Codex: { ...status, status: 'loading' } } });
    expect(api.textContent).toContain('previous snapshot'); expect(api.querySelector('.skeleton')).toBeNull();
    choose('filter-account', UNKNOWN_ACCOUNT);
    expect(api.textContent).toContain('API token activity unavailable'); expect(api.querySelector('strong')).toBeNull();
    choose('filter-provider', 'Claude'); expect(api.textContent).toContain('No personal-account token activity API');
  });
  it('shows matching Local range usage when daily API reporting lags, and clears the fallback for a reported zero', () => {
    const identity = { signedIn: true, email: 'one@test.invalid', method: 'ChatGPT', id: 'workspace-one' };
    const account = usageAccount('Codex', identity)!;
    const other = usageAccount('Codex', { ...identity, id: 'workspace-two', email: 'two@test.invalid' })!;
    const raw = { summary: { lifetimeTokens: 9000000 }, dailyUsageBuckets: [{ startDate: '2026-10-08', tokens: 100 }] };
    const status = { status: 'ready' as const, account: identity, usage: codexTokenActivity(raw, account.id, Date.now()) };
    const fixture = { ...value, accounts: { Codex: status }, data: { ...value.data!, days: [
      { ...row('2026-10-09', 'Codex', 'one-model', 1200000), account },
      { ...row('2026-10-09', 'Codex', 'two-model', 200000), account },
      { ...row('2026-10-08', 'Codex', 'one-model', 9000000), account },
      { ...row('2026-10-09', 'Codex', 'one-model', 9000000), account: other },
      row('2026-10-09', 'Codex', 'one-model', 9000000), row('2026-10-09', 'Claude', 'one-model', 9000000),
    ] } };
    render(fixture);
    choose('filter-range', 'custom'); choose('filter-from', '2026-10-09'); choose('filter-to', '2026-10-10');
    const api = document.querySelector('#api-activity')!;
    expect(api.querySelector('.api-activity-coverage')!.textContent).toContain('through 2026-10-08');
    expect(api.querySelector('.api-activity-coverage')!.textContent).toContain('have not been reported');
    expect(api.querySelector('.api-activity-local [title]')!.getAttribute('title')).toBe('1,400,000 local tokens');
    expect(api.querySelector('strong')!.getAttribute('title')).toBe('Not reported by API');
    choose('filter-model', 'one-model');
    expect(api.querySelector('.api-activity-local [title]')!.getAttribute('title')).toBe('1,200,000 local tokens');
    const scroll = vi.fn(); document.getElementById('totals')!.scrollIntoView = scroll;
    api.querySelector<HTMLButtonElement>('.api-activity-local button')!.click(); expect(scroll).toHaveBeenCalled();
    render({ ...fixture, accounts: { Codex: { ...status, usage: codexTokenActivity({ ...raw, dailyUsageBuckets: [{ startDate: '2026-10-09', tokens: 0 }] }, account.id) } } });
    expect(api.querySelector('.api-activity-local')).toBeNull();
    expect(api.querySelector('strong')!.getAttribute('title')).toBe('0');
    choose('filter-provider', 'Claude'); expect(api.querySelector('.api-activity-local')).toBeNull();
  });
  it('keeps partially reported API range totals visible with their latest reported date', () => {
    const identity = { signedIn: true, email: 'one@test.invalid', method: 'ChatGPT' };
    const account = usageAccount('Codex', identity)!;
    render({ ...value, accounts: { Codex: { status: 'ready', account: identity, usage: codexTokenActivity({
      dailyUsageBuckets: [{ startDate: '2026-10-08', tokens: 100 }, { startDate: '2026-10-09', tokens: 200 }],
    }, account.id) } } });
    choose('filter-range', 'custom'); choose('filter-from', '2026-10-08'); choose('filter-to', '2026-10-10');
    const api = document.querySelector('#api-activity')!;
    expect(api.querySelector('strong')!.getAttribute('title')).toBe('300');
    expect(api.querySelector('.api-activity-coverage')!.textContent).toContain('through 2026-10-09');
    expect(api.querySelector('.api-activity-coverage')!.textContent).toContain('have not been reported');
    expect(api.querySelector('.api-activity-local')).toBeNull();
  });
  it('scopes account usage and quota together without switching native sign-in', () => {
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
    expect(document.querySelector('#account-detail-title')!.textContent).toBe('one@test.invalid');
    expect(document.querySelector('#account-detail-meta')!.textContent).toContain('Codex');
    expect(document.querySelector('#account-detail-meta')!.textContent).not.toContain('Unattributed history');
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('200');
    expect(document.querySelector('#period-breakdown')!.textContent).toContain('one-model');
    expect(document.querySelector('#period-breakdown')!.textContent).not.toContain('two-model');
    expect(document.querySelector('#chart-legend')!.textContent).toContain('one-model');
    expect(document.querySelectorAll('#account-breakdown tbody tr')).toHaveLength(1);
    expect(document.querySelector('#quota-estimates')!.textContent).not.toBe(quotaBefore);
    expect(document.querySelector('#quota-estimates')!.textContent).toContain('one@test.invalid');
    expect(document.querySelector('#quota-estimates')!.textContent).not.toContain('claude@example.test');
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
    expect(root.textContent).toContain('Local · 2 cycles');
    expect(root.querySelectorAll('.quota-trend-history tbody tr')).toHaveLength(2);
    const cells = root.querySelectorAll('.quota-trend-history tbody tr:first-child td');
    expect(cells[2]?.getAttribute('title')).toBe('2,000,000');
    expect(cells[5]?.getAttribute('title')).toBe('8,000,000');
    expect(cells[6]?.textContent).toBe('+100%');
    const before = root.textContent;
    choose('filter-provider', 'Claude'); choose('filter-range', 'all');
    expect(root.textContent).toBe(before);
  });
  it('filters Yesterday as the previous local calendar date across month and year boundaries', () => {
    const clock = vi.spyOn(Date, 'now');
    for (const [today, yesterday] of [[new Date(2026, 9, 1, 0, 15), '2026-09-30'], [new Date(2027, 0, 1, 23, 45), '2026-12-31']] as const) {
      clock.mockReturnValue(today.getTime());
      render({ ...value, data: { ...value.data!, days: [row(yesterday, 'Codex', 'codex-model', 200), row(today.getFullYear() === 2027 ? '2027-01-01' : '2026-10-01', 'Codex', 'codex-model', 900)] } });
      choose('filter-range', 'yesterday');
      expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('200');
      expect(document.querySelectorAll('#period-breakdown tr.period-row')).toHaveLength(1);
      expect(document.getElementById('custom-dates')!.hidden).toBe(true);
      render({ ...value, data: { ...value.data!, days: [row(yesterday, 'Codex', 'codex-model', 400)] } });
      expect((document.getElementById('filter-range') as HTMLSelectElement).value).toBe('yesterday');
      expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('400');
    }
  });
  it('defaults to today with daily grouping and resets to today after browsing other ranges', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 9, 12).getTime());
    render();
    expect((document.getElementById('filter-range') as HTMLSelectElement).value).toBe('today');
    expect((document.getElementById('filter-group') as HTMLSelectElement).value).toBe('day');
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('600');
    expect(document.querySelectorAll('#period-breakdown tr.period-row')).toHaveLength(1);
    expect(document.querySelectorAll('#period-breakdown tr.model-row')).toHaveLength(1);
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
    expect(document.querySelectorAll('#period-breakdown tr.model-row')).toHaveLength(3);
    expect(document.querySelectorAll('#chart-legend > span')).toHaveLength(2);
    const swatches = () => [...document.querySelectorAll<HTMLElement>('#chart-legend .model-swatch')].map(item => item.style.background);
    const colors = swatches(); expect(new Set(colors).size).toBe(2);
    expect(document.querySelector('#accounts')!.textContent).toContain('claude@example.test');
    expect(document.querySelector('#accounts')!.textContent).toContain('75% left');
    choose('filter-provider', 'Codex'); expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('800');
    expect(colors).toContain(swatches()[0]); expect(swatches()).toHaveLength(1);
    expect(document.querySelectorAll('#filter-model option')).toHaveLength(2);
    choose('filter-model', 'codex-model'); render({ ...value, status: 'loading' });
    expect((document.getElementById('filter-model') as HTMLSelectElement).value).toBe('codex-model');
    expect((document.getElementById('refresh') as HTMLButtonElement).disabled).toBe(true);
    choose('filter-provider', 'Claude'); expect((document.getElementById('filter-model') as HTMLSelectElement).value).toBe('');
    expect(document.querySelector('#totals strong')!.getAttribute('title')).toBe('400');
  });
  it('regroups all usage by week/month and applies custom date ranges without inflating totals', () => {
    render(); choose('filter-range', 'all'); choose('filter-group', 'month');
    expect(document.querySelector('#period-title')!.textContent).toBe('Monthly breakdown by model');
    expect(document.querySelectorAll('#period-breakdown tr.period-row')).toHaveLength(2);
    const toggle = document.querySelector<HTMLButtonElement>('#period-breakdown .period-toggle')!, models = document.querySelectorAll('#period-breakdown tr.model-row').length;
    expect(toggle.getAttribute('aria-expanded')).toBe('true'); toggle.click();
    expect(document.querySelectorAll('#period-breakdown tr.model-row').length).toBeLessThan(models);
    expect(document.querySelector('#period-breakdown .period-toggle')!.getAttribute('aria-expanded')).toBe('false');
    document.getElementById('period-toggle-all')!.click(); expect(document.querySelectorAll('#period-breakdown tr.model-row')).toHaveLength(0);
    document.getElementById('period-toggle-all')!.click(); expect(document.querySelectorAll('#period-breakdown tr.model-row')).toHaveLength(models);
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
    expect(document.querySelector('#period-breakdown img:not(.provider-icon)')).toBeNull(); expect(document.querySelector('#period-breakdown .model-name')!.textContent).toContain('<img');
    expect(document.querySelector('#chart-legend img')).toBeNull(); expect(document.querySelector('#chart-legend')!.textContent).toContain('<img');
    expect(document.querySelectorAll('#period-breakdown tr.period-row')).toHaveLength(60);
    document.querySelector<HTMLButtonElement>('#period-breakdown > button')!.click(); expect(document.querySelectorAll('#period-breakdown tr.period-row')).toHaveLength(75);
    expect(document.querySelectorAll('.chart-column')).toHaveLength(30);
  });
});
