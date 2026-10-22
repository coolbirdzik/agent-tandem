import { describe, it, expect, vi } from 'vitest';
import type { UsageDashboardState } from '../src/core/usage-dashboard';
const host = vi.hoisted(() => ({ pickers: [] as any[] }));
vi.mock('vscode', () => ({
  ThemeIcon: class { constructor(public id: string) {} }, QuickPickItemKind: { Separator: -1 },
  window: { createQuickPick: () => {
    const listeners: Record<string, Function> = {};
    const picker = { items: [] as any[], activeItems: [] as any[], selectedItems: [] as any[], busy: false,
      show: vi.fn(), dispose: vi.fn(),
      onDidHide: (f: Function) => { listeners.hide = f; return { dispose: vi.fn() }; },
      onDidTriggerButton: (f: Function) => { listeners.refresh = f; return { dispose: vi.fn() }; },
      onDidAccept: (f: Function) => { listeners.accept = f; return { dispose: vi.fn() }; },
      accept(label: string) { this.selectedItems = this.items.filter(item => item.label.includes(label)); listeners.accept?.(); },
      hide: () => listeners.hide?.(), refresh: () => listeners.refresh?.(), button(tooltip: string) { listeners.refresh?.((this as any).buttons.find((button: any) => button.tooltip === tooltip)); },
    }; host.pickers.push(picker); return picker;
  } },
}));
import { QuickAccounts, quickQuota } from '../src/host/quick-accounts';
function fixture() {
  const identity = { signedIn: true, method: 'ChatGPT', email: 'one@example.test', plan: 'plus' };
  const status = { status: 'ready' as const, account: identity, quota: { status: 'available' as const, windows: [{ id: '5h', label: '5h', usedPercent: 25, resetsAt: Date.now() + 3600000 }] } };
  const state: UsageDashboardState = { status: 'ready', preferences: { showQuotaInStatusBar: true, grouping: 'day' }, accounts: { Codex: status }, managedAccounts: [
    { id: 'first', provider: 'Codex', label: 'Personal', identity, active: true, status, createdAt: 1 },
    { id: 'second', provider: 'Codex', label: 'Work', identity: { ...identity, email: 'two@example.test' }, status: { ...status, account: { ...identity, email: 'two@example.test' }, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 61.5 }] } }, createdAt: 1 },
    { id: 'cursor', provider: 'Cursor', label: 'Studio', identity: { signedIn: true, method: 'Cursor account', email: 'studio@example.test' }, createdAt: 1 },
  ] };
  const deps = { state: () => state, publish: vi.fn(async () => {}), refresh: vi.fn(async (_signal: AbortSignal) => {}), switch: vi.fn(async (_id: string) => {}), resetUsage: vi.fn(async () => {}), open: vi.fn(async (_page: string) => {}), report: vi.fn() };
  const popup = new QuickAccounts(deps); return { state, deps, popup, picker: () => host.pickers.at(-1)! };
}
describe('Quick quota/account popup', () => {
  it('shows one saved row per identity and uses its current quota instead of a stale duplicate', async () => {
    const f = fixture(), work = f.state.managedAccounts![1]!;
    f.state.managedAccounts!.push({ ...work, id: 'old-copy', label: 'Old Work', status: { ...work.status!, quotaCached: true, updatedAt: 1, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 100 }] } } });
    await f.popup.show('Codex');
    const saved = f.picker().items.filter((row: any) => row.id === 'second' || row.id === 'old-copy');
    expect(saved).toHaveLength(1); expect(saved[0].id).toBe('second'); expect(saved[0].detail).toContain('38.5% left');
    f.popup.dispose();
  });
  it('displays the last quota and its timestamp through loading and failed native refreshes', async () => {
    const f = fixture(), previous = f.state.accounts!.Codex!;
    for (const phase of ['loading', 'error'] as const) {
      f.state.accounts!.Codex = { ...previous, status: phase, quotaCached: true, updatedAt: Date.now() - 3600000, ...(phase === 'error' ? { error: 'Offline' } : {}) };
      await f.popup.show('Codex'); const row = f.picker().items.find((i: any) => i.id === 'first');
      expect(row.detail).toContain('5h 75% left'); expect(row.detail).toContain('Cached quota');
      expect(row.description).toContain('one@example.test');
      if (phase === 'error') expect(row.detail).toContain('Offline');
      expect(f.picker().items.find((i: any) => i.id === 'second').action).toBe('switch');
    }
    f.popup.dispose();
  });
  it('allows a switch while automatic quota refresh is pending and cancels that refresh', async () => {
    const f = fixture(); let finish!: () => void;
    f.deps.refresh.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const showing = f.popup.show('Codex');
    await vi.waitFor(() => expect(f.deps.refresh).toHaveBeenCalledOnce());
    const picker = f.picker(), signal = f.deps.refresh.mock.calls[0]![0];
    expect(picker.busy).toBe(true);
    expect(picker.items.find((i: any) => i.id === 'second').action).toBe('switch');
    picker.refresh(); expect(f.deps.refresh).toHaveBeenCalledOnce();
    picker.accept('Work'); expect(f.deps.switch).toHaveBeenCalledWith('second'); expect(signal.aborted).toBe(true);
    finish(); await showing; expect(f.deps.report).not.toHaveBeenCalled(); f.popup.dispose();
  });
  it('keeps account selection enabled during a manual quota refresh', async () => {
    const f = fixture(); await f.popup.show('Codex'); let fail!: (error: Error) => void;
    f.deps.refresh.mockImplementation(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    f.picker().refresh(); const signal = f.deps.refresh.mock.calls[1]![0];
    f.picker().accept('Work'); expect(f.deps.switch).toHaveBeenCalledWith('second'); expect(signal.aborted).toBe(true);
    fail(new Error('Account refresh cancelled.'));
    await vi.waitFor(() => expect(f.picker().busy).toBe(false)); expect(f.deps.report).not.toHaveBeenCalled(); f.popup.dispose();
  });
  it('cancels refresh on hide and ignores its late completion after reopening', async () => {
    const f = fixture(); let finish!: () => void;
    f.deps.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const showing = f.popup.show(); await vi.waitFor(() => expect(f.deps.refresh).toHaveBeenCalledOnce());
    const old = f.picker(), signal = f.deps.refresh.mock.calls[0]![0]; old.hide(); expect(signal.aborted).toBe(true);
    await f.popup.show(); const picker = f.picker();
    let switched!: () => void; f.deps.switch.mockImplementation(() => new Promise<void>(resolve => { switched = resolve; }));
    picker.accept('Work'); finish(); await showing;
    expect(picker.busy).toBe(true); expect(old.dispose).toHaveBeenCalledOnce();
    switched(); await vi.waitFor(() => expect(picker.busy).toBe(false)); f.popup.dispose();
  });
  it('shows account quota immediately, prioritizes the clicked provider and opens no dashboard on click or refresh', async () => {
    const f = fixture(); await f.popup.show('Cursor'); const picker = f.picker();
    expect(picker.items[0].label).toBe('Cursor'); expect(picker.items.some((i: any) => i.id === 'second')).toBe(false);
    picker.accept('Show all accounts'); expect(picker.items.find((i: any) => i.id === 'second').detail).toContain('5h 38.5% left');
    expect(picker.items.find((i: any) => i.id === 'first').action).toBeUndefined(); expect(f.deps.open).not.toHaveBeenCalled(); expect(f.deps.refresh).toHaveBeenCalledOnce();
    picker.refresh(); await vi.waitFor(() => expect(f.deps.refresh).toHaveBeenCalledTimes(2)); expect(f.deps.open).not.toHaveBeenCalled();
    f.popup.dispose();
  });
  it('switches by opaque saved ID, keeps live progress and results in the popup, and prevents repeated actions', async () => {
    const f = fixture(); await f.popup.show('Codex'); const picker = f.picker(); let finish!: () => void;
    f.deps.switch.mockImplementation(async () => {
      f.state.accountsBusy = true; f.state.accountSwitch = { id: 'switch', profileId: 'second', label: 'Work', provider: 'Codex', status: 'running', outcome: 'unknown', startedAt: Date.now(), logs: [{ at: Date.now(), message: 'Verifying the new native sign-in.', level: 'info' }] }; f.popup.update();
      await new Promise<void>(resolve => { finish = resolve; }); f.state.accountsBusy = false; f.state.accountSwitch.status = 'success'; f.state.accountSwitch.notice = 'Account switch complete.';
    });
    picker.accept('Work'); expect(f.deps.switch).toHaveBeenCalledWith('second'); expect(picker.busy).toBe(true); expect(picker.title).toBe('Switching · Work'); expect(picker.placeholder).toContain('Verifying');
    picker.accept('Work'); expect(f.deps.switch).toHaveBeenCalledOnce(); expect(picker.dispose).not.toHaveBeenCalled();
    finish(); await vi.waitFor(() => expect(picker.busy).toBe(false)); expect(picker.items.some((i: any) => i.label.includes('Account switched'))).toBe(true); expect(f.deps.open).not.toHaveBeenCalled();
    picker.accept('Account switched'); expect(picker.items.some((i: any) => i.label.includes('Verifying the new native'))).toBe(true); f.popup.dispose();
  });
  it('blocks switches during agent work and sends Dashboard/Manage through distinct menu actions', async () => {
    const f = fixture(); f.state.accountSwitchBlocked = 'Finish the active turn.'; await f.popup.show('Codex');
    expect(f.picker().items.find((i: any) => i.id === 'second').action).toBeUndefined(); f.picker().accept('Work'); expect(f.deps.switch).not.toHaveBeenCalled();
    f.picker().accept('Open dashboard'); expect(f.deps.open).toHaveBeenCalledWith('dashboard'); expect(f.picker().dispose).toHaveBeenCalledOnce();
    await f.popup.show(); f.picker().accept('Manage accounts'); expect(f.deps.open).toHaveBeenCalledWith('accounts'); f.popup.dispose();
  });
  it('reuses one popup and does not reopen when hidden during a switch', async () => {
    const f = fixture(); await f.popup.show('Codex'); const picker = f.picker(); await f.popup.show('Claude'); expect(f.picker()).toBe(picker);
    await f.popup.show('Codex');
    let finish!: () => void; f.deps.switch.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; })); picker.accept('Work'); picker.hide(); finish();
    await vi.waitFor(() => expect(picker.dispose).toHaveBeenCalledOnce()); f.popup.update(); expect(picker.show).toHaveBeenCalledTimes(3);
  });
  it('shows an unsaved native sign-in separately and never fabricates quota for missing snapshots', async () => {
    const f = fixture(); f.state.managedAccounts = []; await f.popup.show('Codex');
    expect(f.picker().items.find((i: any) => i.label.includes('one@example.test')).action).toBeUndefined();
    expect(quickQuota()).toBe('Quota unavailable'); expect(quickQuota({ status: 'loading' })).toBe('Loading quota…'); f.popup.dispose();
  });
  it('redeems only available active Codex resets and prevents duplicate clicks', async () => {
    const f = fixture(); f.state.accounts!.Codex!.quota!.bankedResets = { availableCount: 2 };
    await f.popup.show('Codex'); const picker = f.picker();
    expect(picker.items.find((item: any) => item.action === 'reset').description).toBe('2 earned resets available');
    let finish!: () => void; f.deps.resetUsage.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    picker.accept('Reset Codex usage'); picker.accept('Reset Codex usage');
    expect(f.deps.resetUsage).toHaveBeenCalledOnce(); expect(picker.busy).toBe(true);
    finish(); await vi.waitFor(() => expect(picker.busy).toBe(false));
    f.state.accounts!.Codex!.quota!.bankedResets = { availableCount: 0 }; f.popup.update();
    picker.accept('Reset Codex usage'); expect(f.deps.resetUsage).toHaveBeenCalledOnce();
    expect(picker.items.find((item: any) => item.label.includes('Reset Codex usage')).action).toBeUndefined();
    f.popup.dispose();
  });
});
