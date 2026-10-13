import * as vscode from 'vscode';
import { AccountProfiles, profileIdentityKey, type AccountProfile } from '../core/account-profiles';
import { isAccountProvider, isChatAccount, type AccountProvider } from '../core/account-providers';
import type { ProviderAccountStatus } from '../providers/account-status';
import type { UsageDashboardState } from '../core/usage-dashboard';
import { withStorageLock } from '../core/storage-lock';
import { randomUUID } from 'node:crypto';
import type { AccountSwitchLog } from '../core/account-switch';

interface Dependencies {
  busy(): boolean; project(): string | undefined; current(provider: AccountProvider): ProviderAccountStatus | undefined;
  read(profile: AccountProfile | AccountProvider): Promise<ProviderAccountStatus>;
  executable(provider: AccountProvider): Promise<string>; changed(provider: AccountProvider): Promise<void>; update(): void;
  openDesktop?(provider: 'Cursor' | 'Antigravity'): Promise<void>;
  observed?(statuses: ProviderAccountStatus[]): Promise<void>;
}
export class AccountManager {
  state: Pick<UsageDashboardState, 'managedAccounts' | 'accountsBusy' | 'accountsError' | 'accountsNotice' | 'accountSwitch'> = { managedAccounts: [] };
  private switchLog(message: string, level: AccountSwitchLog['level'] = 'info') {
    this.state.accountSwitch?.logs.push({ at: Date.now(), level, message }); this.deps.update();
  }
  private statuses = new Map<string, ProviderAccountStatus>();
  private desktopCurrent = new Map<AccountProvider, ProviderAccountStatus>();
  private current(provider: AccountProvider) { return isChatAccount(provider) ? this.deps.current(provider) : this.desktopCurrent.get(provider); }
  private job?: Promise<void>;
  constructor(readonly store: AccountProfiles, private deps: Dependencies) {}
  async refresh() {
    if (this.job) return this.job;
    this.job = (async () => {
      const profiles = (await this.store.read()).profiles;
      for (const provider of ['Cursor', 'Antigravity'] as const) if (profiles.some(row => row.provider === provider)) {
        try { this.desktopCurrent.set(provider, await this.deps.read(provider)); } catch { this.desktopCurrent.delete(provider); }
      }
      for (const id of this.statuses.keys()) if (!profiles.some(row => row.id === id)) this.statuses.delete(id);
      for (let offset = 0; offset < profiles.length; offset += 2) await Promise.all(profiles.slice(offset, offset + 2).map(async row => {
        try {
          const native = this.current(row.provider), id = profileIdentityKey(row.provider, row.identity);
          const active = !!id && id === profileIdentityKey(row.provider, native?.account);
          const status = active && native ? native : await this.deps.read(row);
          // The default CLI owns token rotation while this account is active.
          // Mirror its latest auth instead of independently refreshing the same grant in a copy.
          if (active && status.status === 'ready' && status.account) await this.store.importCurrent(row.provider, status.account);
          this.statuses.set(row.id, status); if (status.status === 'ready' && status.account) await this.store.identify(row.id, status.account);
        }
        catch { this.statuses.set(row.id, { status: 'error', error: 'Could not refresh this sign-in.' }); }
        await this.publish();
      }));
      await this.deps.observed?.(profiles.filter(row => isChatAccount(row.provider)).flatMap(row => this.statuses.get(row.id) ? [this.statuses.get(row.id)!] : []));
      await this.publish();
    })().catch(error => { this.state.accountsError = error instanceof Error ? error.message : 'Could not load accounts.'; this.deps.update(); }).finally(() => { this.job = undefined; });
    return this.job;
  }
  async publish() {
    try { this.state.managedAccounts = (await this.store.read()).profiles.map(row => {
      const current = profileIdentityKey(row.provider, this.current(row.provider)?.account);
      return { ...row, status: this.statuses.get(row.id), active: !!current && current === profileIdentityKey(row.provider, row.identity) };
    }); } catch (error) { this.state.accountsError = error instanceof Error ? error.message : 'Could not load accounts.'; }
    this.deps.update();
  }
  async action(value: unknown) {
    if (!value || typeof value !== 'object') throw new Error('Invalid account action.');
    const request = value as { action?: string; provider?: AccountProvider; id?: string; label?: string };
    if (!['refresh', 'importCurrent', 'importFile', 'add', 'login', 'open', 'switch', 'rename', 'remove'].includes(request.action || '')) throw new Error('Unsupported account action.');
    if (this.state.accountsBusy) throw new Error('Account operation is still running.');
    this.state.accountsBusy = true; this.state.accountsError = undefined; this.state.accountsNotice = undefined; this.deps.update();
    if (request.action === 'switch') {
      const profile = this.state.managedAccounts?.find(row => row.id === request.id);
      this.state.accountSwitch = { id: randomUUID(), profileId: request.id || '', provider: profile?.provider, label: profile?.label, status: 'running', startedAt: Date.now(), outcome: 'notChanged', logs: [] };
      this.switchLog('Preparing account switch.');
    }
    try {
      if (request.action === 'switch' && this.job) this.switchLog('Waiting for the current account refresh.');
      if (request.action !== 'refresh') await this.job;
      if (request.action === 'refresh') { await this.refresh(); return; }
      const provider = request.id ? (await this.store.get(request.id)).provider : request.provider;
      if (!isAccountProvider(provider)) throw new Error('Choose a supported app.');
      if (request.action === 'switch') { this.state.accountSwitch!.provider = provider; this.switchLog('Checking active agent work.'); }
      if (request.action === 'switch' && this.deps.busy()) throw new Error('Finish the active agent turn before switching accounts.');
      if (request.action === 'importCurrent') {
        const current = await this.deps.read(provider);
        const row = await this.store.importCurrent(provider, current.account); this.statuses.set(row.id, current);
        if (!isChatAccount(provider)) this.desktopCurrent.set(provider, current);
        this.state.accountsNotice = `Current ${provider} sign-in saved.`;
      } else if (request.action === 'importFile') {
        const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Native account JSON': ['json'] }, title: `Import ${provider} sign-in` });
        if (files?.[0]) { const row = await this.store.importFile(provider, files[0].fsPath), status = await this.deps.read(row); this.statuses.set(row.id, status); if (status.account) await this.store.identify(row.id, status.account); }
      } else if (!isChatAccount(provider) && ['add', 'login', 'open'].includes(request.action!)) {
        if (!this.deps.openDesktop) throw new Error('Desktop app launch is unavailable.');
        await this.deps.openDesktop(provider);
        this.state.accountsNotice = `Sign in in ${provider}, then Save current sign-in here.`;
      } else if (request.action === 'add' || request.action === 'login') {
        const row = request.id ? await this.store.get(request.id) : await this.store.create(provider);
        const executable = await this.deps.executable(provider);
        const env = Object.fromEntries(Object.entries(this.store.environment(row)).map(([key, value]) => [key, value === undefined ? null : value]));
        const terminal = vscode.window.createTerminal({ name: `${provider} account sign-in`, shellPath: executable, shellArgs: provider === 'Codex' ? ['login'] : ['auth', 'login'], env, cwd: this.deps.project() });
        terminal.show(); this.state.accountsNotice = 'Complete native sign-in in the terminal, then Refresh accounts.';
      } else if (request.action === 'switch') {
        const row = await this.store.get(request.id!);
        this.state.accountSwitch!.label = row.label;
        await withStorageLock(this.store.root, async () => {
          // Save rotated credentials for the outgoing native account before replacing them.
          this.switchLog('Reading the current native sign-in.');
          const current = await this.deps.read(provider);
          if (!isChatAccount(provider)) this.desktopCurrent.set(provider, current);
          if (current.account?.signedIn) { this.switchLog('Backing up the current sign-in.'); await this.store.importCurrent(provider, current.account); }
          else this.switchLog('No outgoing sign-in to back up.');
          this.switchLog('Checking the selected sign-in.');
          const expected = await this.deps.read(row);
          if (!expected.account?.signedIn) throw new Error('Sign in to this account before switching.');
          this.switchLog(isChatAccount(provider) ? 'Updating the default CLI sign-in.' : 'Checking IDE windows and updating native sign-in.');
          this.state.accountSwitch!.outcome = 'unknown';
          const rollback = await this.store.apply(row.id, status => {
            if (status === 'success') { this.state.accountSwitch!.outcome = 'restored'; this.switchLog('Previous sign-in restored.', 'success'); }
            else if (status === 'error') { this.state.accountSwitch!.outcome = 'recoveryRequired'; this.switchLog('Restore failed. Sign in again in the native app.', 'error'); }
            else this.switchLog('Restoring the previous sign-in.');
          });
          try {
            this.switchLog('Verifying the new native sign-in.');
            const actual = await this.deps.read(provider), target = profileIdentityKey(provider, expected.account);
            if (!actual.account?.signedIn || (target && profileIdentityKey(provider, actual.account) !== target)) throw new Error('Native CLI did not verify the selected sign-in.');
            await this.store.identify(row.id, actual.account); this.statuses.set(row.id, actual);
            if (!isChatAccount(provider)) this.desktopCurrent.set(provider, actual);
            this.state.accountSwitch!.outcome = 'switched'; this.switchLog('Selected sign-in verified.', 'success');
          } catch (error) { this.switchLog('Verification failed.', 'error'); await rollback(); throw error; }
        });
        this.switchLog(isChatAccount(provider) ? 'Refreshing account, models and usage.' : 'Refreshing the saved account list.');
        await this.deps.changed(provider); this.state.accountsNotice = isChatAccount(provider) ? `${provider} switched in AgentTandem and the default CLI.` : `${provider} default sign-in switched. Reopen the app to use it.`;
        this.state.accountSwitch!.status = 'success'; this.state.accountSwitch!.notice = this.state.accountsNotice; this.switchLog(isChatAccount(provider) ? 'Account switch complete.' : 'Account switch complete. Reopen the IDE to use it.', 'success');
      } else if (request.action === 'rename') {
        const row = await this.store.get(request.id!);
        const label = request.label ?? await vscode.window.showInputBox({ prompt: 'Account name', value: row.label });
        if (label !== undefined) await this.store.rename(row.id, label);
      } else if (request.action === 'remove') {
        await this.store.remove(request.id!); this.statuses.delete(request.id!);
        this.state.accountsNotice = 'Saved profile removed. Native sign-in stays active.';
      }
      await this.publish();
    } catch (error) {
      this.state.accountsError = error instanceof Error ? error.message : 'Account operation failed.';
      if (request.action === 'switch') {
        this.state.accountSwitch!.status = 'error';
        this.state.accountSwitch!.error = this.state.accountsError;
        // Logs describe fixed steps, never raw RPC errors, credentials or auth payloads.
        this.switchLog(this.state.accountSwitch!.outcome === 'switched' ? 'Sign-in changed, but the dashboard refresh failed. Refresh accounts to retry.' : 'Account switch failed. See the error above.', 'error');
      }
    }
    finally {
      if (request.action === 'switch') this.state.accountSwitch!.finishedAt = Date.now();
      this.state.accountsBusy = false; await this.publish();
    }
  }
}
