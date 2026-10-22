import * as vscode from 'vscode';
import { ACCOUNT_PROVIDERS, accountProviderName, isChatAccount, type AccountProvider } from '../core/account-providers';
import { profileIdentityKey } from '../core/account-profiles';
import type { UsageDashboardState } from '../core/usage-dashboard';
import type { ProviderAccountStatus } from '../providers/account-status';
import { compactCountdown } from '../core/quota-status';
import { uniqueQuotaWindows } from '../core/quota-windows';
import { uniqueAccountProfiles, accountProfileStatus } from '../core/account-display';

interface Item extends vscode.QuickPickItem { action?: 'switch' | 'all' | 'reset' | 'log' | 'dashboard' | 'manage'; id?: string }
interface Dependencies {
  state(): UsageDashboardState; publish(): Promise<void>; refresh(signal: AbortSignal): Promise<void>;
  switch(id: string): Promise<void>; open(page: 'dashboard' | 'accounts'): Promise<void>; report(error: unknown): void;
  resetUsage(): Promise<void>;
}
export function quickQuota(status?: ProviderAccountStatus) {
  const windows = uniqueQuotaWindows(status?.quota?.windows);
  if (windows?.length) return [...windows.map(window => `${window.label} ${Math.round(Math.max(0, 100 - window.usedPercent) * 10) / 10}% left`), ...(status?.quota?.bankedResets?.availableCount ? [`↻ ${status.quota.bankedResets.availableCount}`] : [])].join(' · ');
  return status?.quota?.credits || status?.quota?.detail || status?.error || (status?.status === 'loading' ? 'Loading quota…' : 'Quota unavailable');
}
function quotaDetail(status?: ProviderAccountStatus) {
  const reset = uniqueQuotaWindows(status?.quota?.windows).filter(window => window.resetsAt).map(window => `${window.label} resets in ${compactCountdown(window.resetsAt!)}`).join(' · ');
  return [status?.quotaCached ? 'Cached quota' : undefined, status?.error, reset].filter(Boolean).join(' · ');
}
/** Native popup; remains open for quota refresh, switches and live host progress. */
export class QuickAccounts implements vscode.Disposable {
  private picker?: vscode.QuickPick<Item>;
  private subscriptions: vscode.Disposable[] = [];
  private provider?: AccountProvider;
  private working = false;
  private refreshAbort?: AbortController;
  private logOpen = false;
  private generation = 0;
  private readonly refreshButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Refresh account quota' };
  private readonly dashboardButton = { iconPath: new vscode.ThemeIcon('dashboard'), tooltip: 'Open dashboard' };
  private readonly manageButton = { iconPath: new vscode.ThemeIcon('settings-gear'), tooltip: 'Manage accounts' };
  constructor(private deps: Dependencies) {}
  async show(provider?: AccountProvider) {
    this.provider = provider; this.logOpen = false;
    if (this.picker) { this.update(); this.picker.show(); return; }
    const picker = vscode.window.createQuickPick<Item>(); this.picker = picker;
    picker.matchOnDescription = true; picker.matchOnDetail = true;
    picker.buttons = [this.dashboardButton, this.manageButton, this.refreshButton];
    this.subscriptions = [picker.onDidHide(() => this.dispose()),
      picker.onDidTriggerButton(button => {
        if (button === this.dashboardButton || button === this.manageButton) { const page = button === this.dashboardButton ? 'dashboard' : 'accounts'; this.dispose(); void this.deps.open(page).catch(this.deps.report); }
        else void this.refresh();
      }),
      picker.onDidAccept(() => {
        const item = picker.selectedItems[0];
        if (!item?.action) return;
        if (item.action === 'dashboard' || item.action === 'manage') { const page = item.action === 'dashboard' ? 'dashboard' : 'accounts'; this.dispose(); void this.deps.open(page).catch(this.deps.report); }
        else if (item.action === 'all') { this.provider = undefined; picker.value = ''; this.update(); }
        else if (item.action === 'log') { this.logOpen = !this.logOpen; this.update(); }
        else if (this.working || this.deps.state().accountsBusy) return;
        else if (item.action === 'reset') {
          const state = this.deps.state();
          if (state.accountSwitchBlocked || state.accounts?.Codex?.status !== 'ready' || state.accounts.Codex.quotaCached || (state.accounts.Codex.quota?.bankedResets?.availableCount ?? 0) <= 0) return;
          void this.run(() => this.deps.resetUsage());
        }
        else if (item.id) {
          const state = this.deps.state(), profile = state.managedAccounts?.find(row => row.id === item.id);
          if (!profile || profile.active || state.accountSwitchBlocked) return;
          this.logOpen = false; void this.run(() => this.deps.switch(item.id!));
        }
      })];
    this.update(); picker.show();
    // Publish saved profiles immediately, then read quota without opening Settings/history.
    const generation = this.generation;
    try { await this.deps.publish(); } catch (error) { this.deps.report(error); }
    if (generation !== this.generation) return;
    this.update(); await this.refresh();
  }
  private async refresh() {
    if (this.working || this.deps.state().accountsBusy || this.refreshAbort) return;
    const abort = new AbortController(); this.refreshAbort = abort; this.update();
    try { await this.deps.refresh(abort.signal); }
    catch (error) { if (!abort.signal.aborted) this.deps.report(error); }
    finally { if (this.refreshAbort === abort) { this.refreshAbort = undefined; this.update(); } }
  }
  private async run(job: () => Promise<void>) {
    if (this.working) return;
    this.refreshAbort?.abort(); this.refreshAbort = undefined;
    this.working = true; const generation = this.generation; this.update();
    try { await job(); } catch (error) { this.deps.report(error); }
    finally { if (generation === this.generation) { this.working = false; this.update(); } }
  }
  update() {
    const picker = this.picker; if (!picker) return;
    const state = this.deps.state(), operation = state.accountSwitch, switching = operation?.status === 'running';
    picker.busy = this.working || !!state.accountsBusy || !!this.refreshAbort;
    picker.title = switching ? `Switching · ${operation.label || accountProviderName(operation.provider || 'Codex')}` : this.provider ? `${accountProviderName(this.provider)} · Accounts` : 'AgentTandem · Accounts';
    picker.placeholder = switching ? operation.logs.at(-1)?.message || 'Switching account…' : state.accountSwitchBlocked || 'Search accounts · select to switch';
    const items: Item[] = [];
    const providers = this.provider ? [this.provider] : ACCOUNT_PROVIDERS;
    for (const provider of providers) {
      const profiles = uniqueAccountProfiles((state.managedAccounts || []).filter(row => row.provider === provider)).sort((a, b) => Number(!!b.active) - Number(!!a.active) || a.label.localeCompare(b.label));
      const native = isChatAccount(provider) ? state.accounts?.[provider] : undefined;
      if (!profiles.length && !native && provider !== this.provider) continue;
      items.push({ label: accountProviderName(provider), kind: vscode.QuickPickItemKind.Separator });
      const currentId = profileIdentityKey(provider, native?.account);
      if (native && !profiles.some(row => row.active || (currentId && currentId === profileIdentityKey(provider, row.identity)))) {
        items.push({ label: `$(check) ${native.account?.email || 'Current CLI'}`, description: ['Active', native.account?.plan].filter(Boolean).join(' · '), detail: [quickQuota(native), quotaDetail(native)].filter(Boolean).join(' · ') });
      }
      for (const profile of profiles) {
        const active = profile.active || !!currentId && currentId === profileIdentityKey(provider, profile.identity);
        const status = accountProfileStatus(profile, active && native?.quota ? native : profile.status);
        const identity = status?.account || profile.identity;
        const blocked = state.accountSwitchBlocked || (state.accountsBusy ? 'Account operation in progress' : undefined);
        items.push({ id: profile.id, label: `$(${active ? 'check' : switching && operation.profileId === profile.id ? 'loading~spin' : 'account'}) ${profile.label}`,
          description: [active ? 'Active' : undefined, identity?.email, identity?.plan].filter(Boolean).join(' · '), detail: [quickQuota(status), quotaDetail(status), !active && blocked ? blocked : undefined, !isChatAccount(provider) ? 'Close app windows before switching' : undefined].filter(Boolean).join(' · '),
          ...(!active && !blocked && !this.working ? { action: 'switch' as const } : {}) });
      }
    }
    if (!items.length) items.push({ label: 'No saved accounts yet', detail: 'Open Manage accounts to save a sign-in.' });
    if (operation) {
      items.push({ label: 'Switch activity', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: `$(${switching ? 'loading~spin' : operation.status === 'success' ? 'check' : 'error'}) ${switching ? 'Switching…' : operation.status === 'success' ? 'Account switched' : operation.outcome === 'switched' ? 'Switched · refresh failed' : 'Switch failed'}`,
        description: operation.label, detail: operation.error || operation.notice || operation.logs.at(-1)?.message, action: switching ? undefined : 'log' });
      const logs = this.logOpen ? operation.logs : [];
      for (const log of logs) items.push({ label: `$(${log.level === 'error' ? 'error' : log.level === 'success' ? 'check' : 'circle-small-filled'}) ${log.message}`, description: new Date(log.at).toLocaleTimeString() });
    }
    const codex = state.accounts?.Codex;
    if ((!this.provider || this.provider === 'Codex') && codex?.account?.signedIn && codex.account.method === 'ChatGPT') {
      const count = codex.quota?.bankedResets?.availableCount;
      items.push({ label: 'Usage', kind: vscode.QuickPickItemKind.Separator }, { label: '$(discard) Reset Codex usage', description: count === undefined ? 'Refresh quota to check resets' : `${count} earned reset${count === 1 ? '' : 's'} available`,
        detail: state.accountSwitchBlocked || (count ? 'Uses 1 earned reset to restore eligible quota' : 'No earned reset is available'),
        ...(count && codex.status === 'ready' && !codex.quotaCached && !state.accountSwitchBlocked && !state.accountsBusy && !this.working ? { action: 'reset' as const } : {}), alwaysShow: true });
    }
    if (state.accountsError || state.accountsNotice) items.push({ label: `$(${state.accountsError ? 'error' : 'check'}) ${state.accountsError || state.accountsNotice}`, alwaysShow: true });
    if (this.provider) items.push({ label: '$(list-selection) Show all accounts', action: 'all', alwaysShow: true });
    items.push({ label: 'Open', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(dashboard) Open dashboard', action: 'dashboard', alwaysShow: true },
      { label: '$(settings-gear) Manage accounts', action: 'manage', alwaysShow: true });
    const selected = picker.activeItems[0]; picker.items = items;
    if (selected) { const same = items.find(row => selected.id ? row.id === selected.id : row.label === selected.label); if (same) picker.activeItems = [same]; }
  }
  dispose() {
    this.refreshAbort?.abort(); this.refreshAbort = undefined;
    ++this.generation; const picker = this.picker; this.picker = undefined; this.working = false;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose(); picker?.dispose();
  }
}
