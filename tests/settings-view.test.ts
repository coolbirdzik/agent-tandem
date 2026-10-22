import { describe, it, expect, vi } from 'vitest';
import type { UsageDashboardState } from '../src/core/usage-dashboard';
const host = vi.hoisted(() => ({ post: vi.fn(), receive: undefined as any, dispose: undefined as any }));
vi.mock('vscode', () => ({
  Uri: { joinPath: (_uri: unknown, ...parts: string[]) => ({ toString: () => parts.join('/') }) }, ViewColumn: { One: 1 },
  window: { createWebviewPanel: () => ({ visible: true, reveal: vi.fn(), dispose: () => host.dispose?.(),
    onDidDispose: (fn: unknown) => { host.dispose = fn; return { dispose: vi.fn() }; },
    webview: { postMessage: host.post, asWebviewUri: (uri: unknown) => uri, cspSource: 'test',
      onDidReceiveMessage: (fn: unknown) => { host.receive = fn; return { dispose: vi.fn() }; } } }) }
}));
import { SettingsView } from '../src/host/settings-view';

describe('Settings host updates', () => {
  it('routes native conversation cleanup and publishes preview and progress changes', async () => {
    const state: UsageDashboardState = { status: 'ready', preferences: { grouping: 'day', showQuotaInStatusBar: true } }, invoke = vi.fn();
    const view = new SettingsView({} as any, () => state, invoke, vi.fn()); view.open();
    for (const [type, command, value] of [['scanConversations', 'scanConversationCleanup', undefined], ['previewConversationCleanup', 'previewConversationCleanup', { keys: ['Codex:id'] }], ['deleteConversations', 'deleteConversations', { token: 'approved' }]] as const) {
      await host.receive({ type, value }); expect(invoke).toHaveBeenLastCalledWith(`agentTandem.${command}`, value);
    }
    host.post.mockClear(); state.conversationCleanup = { status: 'cleaning', roots: { Codex: '/codex', Claude: '/claude' }, done: 1, total: 2 };
    view.update(); expect(host.post).toHaveBeenCalledTimes(1); state.conversationCleanup.done = 2; view.update(); expect(host.post).toHaveBeenCalledTimes(2); view.dispose();
  });
  it('routes history assignments and publishes busy/errors even when usage has not changed', async () => {
    const state: UsageDashboardState = { status: 'ready', preferences: { grouping: 'day', showQuotaInStatusBar: true } }, invoke = vi.fn();
    const view = new SettingsView({} as any, () => state, invoke, vi.fn()); view.open();
    await host.receive({ type: 'usageAttribution', value: { action: 'assign', scope: { provider: 'Codex', conversationId: 'session' }, accountId: 'selected' } });
    expect(invoke).toHaveBeenLastCalledWith('agentTandem.usageAttribution', { action: 'assign', scope: { provider: 'Codex', conversationId: 'session' }, accountId: 'selected' });
    host.post.mockClear(); state.attributionBusy = true; view.update(); expect(host.post).toHaveBeenCalledTimes(1);
    state.attributionBusy = false; state.attributionError = 'Write failed'; view.update(); expect(host.post).toHaveBeenCalledTimes(2); view.dispose();
  });
  it('opens Accounts directly and forwards account actions through the host allowlist', async () => {
    const state: UsageDashboardState = { status: 'ready', preferences: { grouping: 'day', showQuotaInStatusBar: true } }, invoke = vi.fn();
    const view = new SettingsView({} as any, () => state, invoke, vi.fn()); view.open('accounts');
    await host.receive({ type: 'ready' }); expect(host.post).toHaveBeenLastCalledWith({ type: 'page', page: 'accounts' });
    await host.receive({ type: 'accountAction', value: { action: 'switch', id: 'selected' } });
    expect(invoke).toHaveBeenLastCalledWith('agentTandem.accountAction', { action: 'switch', id: 'selected' }); view.dispose();
  });
  it('opens Storage directly, including when the webview becomes ready after creation', async () => {
    const state: UsageDashboardState = { status: 'ready', preferences: { grouping: 'day', showQuotaInStatusBar: true } };
    const view = new SettingsView({} as any, () => state, vi.fn(), vi.fn()); view.open('storage');
    await host.receive({ type: 'ready' }); expect(host.post).toHaveBeenLastCalledWith({ type: 'page', page: 'storage' });
    view.open('storage'); expect(host.post).toHaveBeenCalledWith({ type: 'page', page: 'storage' });
    view.open(); expect(host.post).toHaveBeenCalledWith({ type: 'dashboard' }); view.dispose();
  });
  it('opens extension storage on Unused files even before the webview is ready', async () => {
    const state: UsageDashboardState = { status: 'ready', preferences: { grouping: 'day', showQuotaInStatusBar: true } };
    const view = new SettingsView({} as any, () => state, vi.fn(), vi.fn()); view.open('storage', 'unused');
    await host.receive({ type: 'ready' });
    expect(host.post).toHaveBeenLastCalledWith({ type: 'page', page: 'storage', storagePage: 'unused' });
    view.open('storage', 'restore'); expect(host.post).toHaveBeenCalledWith({ type: 'page', page: 'storage', storagePage: 'restore' }); view.dispose();
  });
  it('routes history preview and deletion through the extension command allowlist', async () => {
    const invoke = vi.fn(), report = vi.fn(), state: UsageDashboardState = { status: 'ready', preferences: { grouping: 'day', showQuotaInStatusBar: true } };
    const view = new SettingsView({} as any, () => state, invoke, report); view.open();
    await host.receive({ type: 'previewHistoryDeletion', value: { ids: ['selected'] } });
    expect(invoke).toHaveBeenLastCalledWith('agentTandem.previewHistoryDeletion', { ids: ['selected'] });
    await host.receive({ type: 'previewCleanAll', value: { kinds: ['unused'] } }); expect(invoke.mock.lastCall).toEqual(['agentTandem.previewCleanAll', { kinds: ['unused'] }]);
    await host.receive({ type: 'deleteHistory', value: { token: 'approved' } });
    await host.receive({ type: 'previewReviewCleanup', value: { scope: 'all' } });
    expect(invoke).toHaveBeenLastCalledWith('agentTandem.previewReviewCleanup', { scope: 'all' });
    await host.receive({ type: 'deleteHistory', value: { token: 'approved' } });
    expect(invoke).toHaveBeenLastCalledWith('agentTandem.deleteHistory', { token: 'approved' });
    await host.receive({ type: 'deleteArbitraryPath', value: { path: 'outside' } });
    expect(report).toHaveBeenCalled(); view.dispose();
  });
  it('suppresses unchanged state, sends changed quota/usage, and resends when a webview is ready or recreated', async () => {
    let state: UsageDashboardState = { status: 'ready', preferences: { grouping: 'day', showQuotaInStatusBar: true } };
    host.post.mockClear();
    const view = new SettingsView({} as any, () => ({ ...state }), vi.fn(), vi.fn());
    view.open(); expect(host.post).toHaveBeenCalledTimes(1);
    view.update(); view.update(); expect(host.post).toHaveBeenCalledTimes(1);
    state = { ...state, accounts: { Codex: { status: 'loading' } } }; view.update(); expect(host.post).toHaveBeenCalledTimes(2);
    state = { ...state, status: 'loading' }; view.update(); expect(host.post).toHaveBeenCalledTimes(3);
    await host.receive({ type: 'ready' }); expect(host.post).toHaveBeenCalledTimes(4);
    view.dispose(); view.open(); expect(host.post).toHaveBeenCalledTimes(5);
    await host.receive({ type: 'ready' }); expect(host.post).toHaveBeenCalledTimes(6);
    state = { ...state, quotaHistoryError: 'Could not save quota history.' }; view.update(); expect(host.post).toHaveBeenCalledTimes(7);
    state = { ...state, quotaHistoryError: undefined, quotaHistory: [] }; view.update(); expect(host.post).toHaveBeenCalledTimes(8);
    const meter = { provider: 'Codex' as const, accountId: 'demo', plan: 'plus', label: '5h' as const, from: 1, to: 2, resetsAt: 3, totalTokens: 100, usedPercent: 0 };
    state = { ...state, quotaBaselines: [{ start: meter, latest: meter }] }; view.update(); expect(host.post).toHaveBeenCalledTimes(9);
    state = { ...state, activeProvider: 'Claude' }; view.update(); expect(host.post).toHaveBeenCalledTimes(10);
    view.dispose();
  });
});
