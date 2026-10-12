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
  it('opens Storage directly, including when the webview becomes ready after creation', async () => {
    const state: UsageDashboardState = { status: 'ready', preferences: { grouping: 'day', showQuotaInStatusBar: true } };
    const view = new SettingsView({} as any, () => state, vi.fn(), vi.fn()); view.open('storage');
    await host.receive({ type: 'ready' }); expect(host.post).toHaveBeenLastCalledWith({ type: 'page', page: 'storage' });
    view.open('storage'); expect(host.post).toHaveBeenCalledWith({ type: 'page', page: 'storage' });
    view.open(); expect(host.post).toHaveBeenCalledWith({ type: 'dashboard' }); view.dispose();
  });
  it('routes history preview and deletion through the extension command allowlist', async () => {
    const invoke = vi.fn(), report = vi.fn(), state: UsageDashboardState = { status: 'ready', preferences: { grouping: 'day', showQuotaInStatusBar: true } };
    const view = new SettingsView({} as any, () => state, invoke, report); view.open();
    await host.receive({ type: 'previewHistoryDeletion', value: { ids: ['selected'] } });
    expect(invoke).toHaveBeenLastCalledWith('agentDock.previewHistoryDeletion', { ids: ['selected'] });
    await host.receive({ type: 'deleteHistory', value: { token: 'approved' } });
    expect(invoke).toHaveBeenLastCalledWith('agentDock.deleteHistory', { token: 'approved' });
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
    view.dispose();
  });
});
