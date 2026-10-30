import * as vscode from 'vscode';
import { AccountProfiles, profileIdentityKey, type AccountProfile } from '../core/account-profiles';
import { isAccountProvider, isChatAccount, type AccountProvider } from '../core/account-providers';
import type { AccountIdentity, AccountReadOptions, ProviderAccountStatus } from '../providers/account-status';
import type { UsageDashboardState } from '../core/usage-dashboard';
import { withStorageLock } from '../core/storage-lock';
import { randomUUID } from 'node:crypto';
import type { AccountSwitchLog } from '../core/account-switch';
import { AccountQuotaCache } from '../core/account-quota-cache';
import { QuotaRefreshPolicy, quotaRetryAfter } from '../core/quota-refresh-policy';
import { assertAccountIdentity, accountIdentityMatches, sameAccountIdentity, AccountIdentityMismatchError } from '../core/account-identity';

interface Dependencies {
  busy(): boolean; project(): string | undefined; current(provider: AccountProvider): ProviderAccountStatus | undefined;
  read(profile: AccountProfile | AccountProvider, signal?: AbortSignal, options?: AccountReadOptions): Promise<ProviderAccountStatus>;
  executable(provider: AccountProvider): Promise<string>; changed(provider: AccountProvider): Promise<void>; update(): void;
  openDesktop?(provider: 'Cursor' | 'Antigravity'): Promise<void>;
  observed?(statuses: ProviderAccountStatus[]): Promise<void>;
  resetUsage?(account: AccountIdentity): Promise<string>;
  // Native IDE extensions read the CLI sign-in at startup, so offer an extension host restart.
  switched?(provider: 'Codex' | 'Claude'): Promise<void> | void;
}
export class AccountManager {
  state: Pick<UsageDashboardState, 'managedAccounts' | 'accountsBusy' | 'accountsRefreshing' | 'accountsError' | 'accountsNotice' | 'accountSwitch'> = { managedAccounts: [] };
  private switchLog(message: string, level: AccountSwitchLog['level'] = 'info') {
    this.state.accountSwitch?.logs.push({ at: Date.now(), level, message }); this.deps.update();
  }
  private statuses = new Map<string, ProviderAccountStatus>();
  private desktopCurrent = new Map<AccountProvider, ProviderAccountStatus>();
  private current(provider: AccountProvider) { return isChatAccount(provider) ? this.deps.current(provider) : this.desktopCurrent.get(provider); }
  private job?: Promise<void>;
  private refreshAbort?: AbortController;
  private quotaCache: AccountQuotaCache;
  private quotaRefresh = new QuotaRefreshPolicy();
  constructor(readonly store: AccountProfiles, private deps: Dependencies) { this.quotaCache = new AccountQuotaCache(store.root); }
  async rememberQuota(provider: AccountProvider, status: ProviderAccountStatus) {
    await this.quotaCache.remember(provider, status);
    return this.quotaCache.restore(provider, status);
  }
  async refresh(signal?: AbortSignal, background = false) {
    if (this.state.accountsBusy) return;
    if (this.job) return this.job;
    if (signal?.aborted) return;
    const abort = new AbortController(); this.refreshAbort = abort;
    const stop = () => abort.abort(); signal?.addEventListener('abort', stop, { once: true });
    // A cache-only hover must not toggle the tooltip's refreshing state: that
    // would invalidate the lazy tooltip and cause another hover resolution.
    const markRefreshing = () => { if (!this.state.accountsRefreshing) { this.state.accountsRefreshing = true; this.deps.update(); } };
    this.job = (async () => {
      await this.quotaCache.load();
      const profiles = (await this.store.read()).profiles;
      for (const provider of ['Cursor', 'Antigravity'] as const) if (profiles.some(row => row.provider === provider)) {
        if (abort.signal.aborted) return;
        if (!this.quotaRefresh.due(provider, background, this.desktopCurrent.get(provider)?.updatedAt)) continue;
        markRefreshing();
        this.quotaRefresh.start(provider);
        try { const status = await this.deps.read(provider, abort.signal); if (!abort.signal.aborted) { this.desktopCurrent.set(provider, status); this.quotaRefresh.complete(provider, status.status === 'error', status.quota?.retryAfterAt); } }
        catch (error) { if (!abort.signal.aborted) { this.desktopCurrent.delete(provider); this.quotaRefresh.complete(provider, true, quotaRetryAfter(error)); } }
      }
      for (const id of this.statuses.keys()) if (!profiles.some(row => row.id === id)) this.statuses.delete(id);
      // Read saved accounts sequentially to avoid a burst of subscription queries.
      for (const row of profiles) {
        if (abort.signal.aborted) return;
        const native = this.current(row.provider), id = profileIdentityKey(row.provider, row.identity);
        const active = !!id && id === profileIdentityKey(row.provider, native?.account);
        const refreshKey = id ?? row.id;
        const saved = this.statuses.get(row.id) ?? this.quotaCache.restore(row.provider, { status: 'ready', account: row.identity });
        if (!active && !this.quotaRefresh.due(refreshKey, background, saved.updatedAt)) continue;
        try {
          if (!active) { markRefreshing(); this.quotaRefresh.start(refreshKey); }
          const status = active && native ? native : await this.deps.read(row, abort.signal);
          if (abort.signal.aborted) return;
          // The default CLI owns token rotation while this account is active.
          // Mirror its latest auth instead of independently refreshing the same grant in a copy.
          if (active && status.status === 'ready' && status.account) await this.store.importCurrent(row.provider, status.account);
          assertAccountIdentity(row.identity, status.account);
          if (status.status === 'ready' && status.account) await this.store.identify(row.id, status.account);
          if (!active) this.quotaRefresh.complete(refreshKey, status.status === 'error' || status.quota?.status === 'error', status.quota?.retryAfterAt);
          this.statuses.set(row.id, await this.rememberQuota(row.provider, status));
        }
        catch (error) { if (!abort.signal.aborted) {
          if (!active) this.quotaRefresh.complete(refreshKey, true, quotaRetryAfter(error));
          this.statuses.set(row.id, this.quotaCache.restore(row.provider, { status: 'error', account: row.identity, error: error instanceof AccountIdentityMismatchError ? error.message : 'Could not refresh this sign-in.' }));
        } }
        if (!abort.signal.aborted) await this.publish();
      }
      if (abort.signal.aborted) return;
      await this.deps.observed?.(profiles.filter(row => isChatAccount(row.provider)).flatMap(row => this.statuses.get(row.id) ? [this.statuses.get(row.id)!] : []));
      await this.publish();
    })().catch(error => { if (!abort.signal.aborted) { this.state.accountsError = error instanceof Error ? error.message : 'Could not load accounts.'; this.deps.update(); } }).finally(() => { signal?.removeEventListener('abort', stop); this.refreshAbort = undefined; this.job = undefined; this.state.accountsRefreshing = false; this.deps.update(); });
    return this.job;
  }
  async publish() {
    await this.quotaCache.load();
    try { this.state.managedAccounts = (await this.store.read()).profiles.map(row => {
      const current = profileIdentityKey(row.provider, this.current(row.provider)?.account);
      let active = !!current && current === profileIdentityKey(row.provider, row.identity);
      let status = active ? this.current(row.provider) : this.statuses.get(row.id);
      if (status && !accountIdentityMatches(row.identity, status.account)) {
        active = false; status = { status: 'error', account: row.identity, error: 'Saved sign-in belongs to a different account. Sign in again.' };
      }
      const restored = this.quotaCache.restore(row.provider, status || { status: 'ready', account: row.identity });
      return { ...row, status: status || restored.quota ? restored : undefined, active };
    }); } catch (error) { this.state.accountsError = error instanceof Error ? error.message : 'Could not load accounts.'; }
    this.deps.update();
  }
  async action(value: unknown) {
    if (!value || typeof value !== 'object') throw new Error('Invalid account action.');
    const request = value as { action?: string; provider?: AccountProvider; id?: string; label?: string };
    if (!['refresh', 'importCurrent', 'importFile', 'add', 'login', 'open', 'switch', 'rename', 'remove', 'resetUsage'].includes(request.action || '')) throw new Error('Unsupported account action.');
    if (this.state.accountsBusy) throw new Error('Account operation is still running.');
    if (request.action === 'refresh') { this.state.accountsError = undefined; await this.refresh(); return; }
    this.state.accountsBusy = true; this.state.accountsError = undefined; this.state.accountsNotice = undefined; this.deps.update();
    let reload: 'Codex' | 'Claude' | undefined;
    if (request.action === 'switch') {
      const profile = this.state.managedAccounts?.find(row => row.id === request.id);
      this.state.accountSwitch = { id: randomUUID(), profileId: request.id || '', provider: profile?.provider, label: profile?.label, status: 'running', startedAt: Date.now(), outcome: 'notChanged', logs: [] };
      this.switchLog('Preparing account switch.');
    }
    try {
      if ((request.action === 'switch' || request.action === 'resetUsage') && this.job) { if (request.action === 'switch') this.switchLog('Stopping background account refresh.'); this.refreshAbort?.abort(); }
      await this.job;
      const provider = request.id ? (await this.store.get(request.id)).provider : request.provider;
      if (!isAccountProvider(provider)) throw new Error('Choose a supported app.');
      if (request.action === 'switch') { this.state.accountSwitch!.provider = provider; this.switchLog('Checking active agent work.'); }
      if (request.action === 'switch' && this.deps.busy()) throw new Error('Finish the active agent turn before switching accounts.');
      if (request.action === 'resetUsage') {
        if (provider !== 'Codex' || request.id || !this.deps.resetUsage) throw new Error('Usage resets are available only for the active Codex account.');
        if (this.deps.busy()) throw new Error('Finish the active agent turn before resetting usage.');
        const account = this.deps.current('Codex')?.account;
        if (!account?.signedIn || account.method !== 'ChatGPT') throw new Error('Sign in to Codex with ChatGPT before resetting usage.');
        this.state.accountsNotice = await withStorageLock(this.store.root, () => this.deps.resetUsage!(account));
        // Cache writes use the same lock, so persist only after redemption releases it.
        const current = this.deps.current('Codex'); if (current) await this.rememberQuota('Codex', current);
      } else if (request.action === 'importCurrent') {
        const current = await this.deps.read(provider);
        const row = await this.store.importCurrent(provider, current.account); this.statuses.set(row.id, await this.rememberQuota(provider, current));
        if (!isChatAccount(provider)) this.desktopCurrent.set(provider, current);
        this.state.accountsNotice = `Current ${provider} sign-in saved.`;
      } else if (request.action === 'importFile') {
        const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Native account JSON': ['json'] }, title: `Import ${provider} sign-in` });
        if (files?.[0]) { const row = await this.store.importFile(provider, files[0].fsPath), status = await this.deps.read(row); this.statuses.set(row.id, await this.rememberQuota(provider, status)); if (status.account) await this.store.identify(row.id, status.account); }
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
          if (current.account?.signedIn) { this.switchLog('Backing up the current sign-in.'); const outgoing = await this.store.importCurrent(provider, current.account); this.statuses.set(outgoing.id, await this.rememberQuota(provider, current)); }
          else this.switchLog('No outgoing sign-in to back up.');
          this.switchLog('Checking the selected sign-in.');
          // The outgoing backup just copied the native grant. Never rotate that
          // same active grant independently in the profile copy.
          const activeCodex = provider === 'Codex' && sameAccountIdentity(row.identity, current.account);
          if (provider === 'Codex' && !activeCodex) this.switchLog('Refreshing the selected Codex sign-in.');
          const expected = activeCodex ? current : provider === 'Codex'
            ? await this.deps.read(row, undefined, { refreshToken: true }) : await this.deps.read(row);
          assertAccountIdentity(row.identity, expected.account);
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
            // Native verification/quota queries can rotate tokens too. Keep the
            // saved copy current so a later switch never reuses a spent grant.
            if (provider === 'Codex') await this.store.importCurrent(provider, actual.account);
            await this.store.identify(row.id, actual.account); this.statuses.set(row.id, await this.rememberQuota(provider, actual));
            if (!isChatAccount(provider)) this.desktopCurrent.set(provider, actual);
            this.state.accountSwitch!.outcome = 'switched'; this.switchLog('Selected sign-in verified.', 'success');
          } catch (error) { this.switchLog('Verification failed.', 'error'); await rollback(); throw error; }
        });
        if (isChatAccount(provider)) reload = provider;
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
    // Not awaited: the prompt must not keep the account UI busy. The sign-in already changed even if the refresh failed.
    if (reload) void Promise.resolve(this.deps.switched?.(reload)).catch(() => undefined);
  }
}
