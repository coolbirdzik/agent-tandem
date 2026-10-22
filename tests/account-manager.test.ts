import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const ui = vi.hoisted(() => ({ terminal: vi.fn(), show: vi.fn() }));
vi.mock('vscode', () => ({ window: { createTerminal: (options: unknown) => { ui.terminal(options); return { show: ui.show }; } } }));
import { AccountManager } from '../src/host/account-manager';
import { AccountProfiles, type AccountProfile } from '../src/core/account-profiles';
import type { ConversationProvider } from '../src/providers/conversations';
import type { AccountReadOptions, ProviderAccountStatus } from '../src/providers/account-status';

describe('Account switching controller', () => {
  it('refreshes the selected saved Codex grant before applying it and saves native rotation for the next switch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-switch-rotation-')), home = path.join(root, 'native'); await mkdir(home);
    try {
      const store = new AccountProfiles(path.join(root, 'accounts'), () => home);
      const identity = (email: string) => ({ signedIn: true, method: 'ChatGPT', email });
      const auth = (email: string, token: string) => JSON.stringify({ tokens: { access_token: token, refresh_token: `${token}-refresh` }, email });
      await writeFile(path.join(home, 'auth.json'), auth('old@test', 'native-original'));
      const selected = await store.import('Codex', auth('new@test', 'expired-saved'), identity('new@test'));
      const renewedFrom: string[] = [], applied: string[] = [];
      let readingNative = 0, outgoingEmail = 'old@test';
      const read = vi.fn(async (value: AccountProfile | ConversationProvider, _signal?: AbortSignal, options?: AccountReadOptions) => {
        const file = path.join(typeof value === 'string' ? home : store.home(value.id), 'auth.json');
        const data = JSON.parse(await readFile(file, 'utf8'));
        if (options?.refreshToken) {
          renewedFrom.push(data.tokens.refresh_token);
          // Refreshing a saved profile must not replace the current native auth.
          expect(JSON.parse(await readFile(path.join(home, 'auth.json'), 'utf8')).email).toBe(outgoingEmail);
          await writeFile(file, auth(data.email, 'saved-renewed'));
        } else if (typeof value === 'string' && ++readingNative % 2 === 0) {
          applied.push(data.tokens.access_token);
          await writeFile(file, auth(data.email, 'native-renewed'));
        } else if (typeof value === 'string') outgoingEmail = data.email;
        return { status: 'ready' as const, account: identity(data.email) };
      });
      const manager = new AccountManager(store, { busy: () => false, project: () => root, current: () => undefined, read, executable: vi.fn(), changed: vi.fn(), update: vi.fn() });
      await manager.action({ action: 'switch', id: selected.id });
      expect(manager.state.accountSwitch?.status).toBe('success');
      expect(applied).toEqual(['saved-renewed']);
      expect(JSON.parse(await readFile(path.join(store.home(selected.id), 'auth.json'), 'utf8')).tokens.refresh_token).toBe('native-renewed-refresh');
      const outgoing = (await store.read()).profiles.find(row => row.identity?.email === 'old@test')!;
      await manager.action({ action: 'switch', id: outgoing.id });
      expect(manager.state.accountSwitch?.status).toBe('success');
      await manager.action({ action: 'switch', id: selected.id });
      expect(manager.state.accountSwitch?.status).toBe('success');
      expect(renewedFrom).toEqual(['expired-saved-refresh', 'native-original-refresh', 'native-renewed-refresh']);
      expect(JSON.stringify(manager.state)).not.toContain('saved-renewed');
      expect(JSON.stringify(manager.state)).not.toContain('native-renewed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('keeps native auth and config intact when refreshing the selected saved grant fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-switch-refresh-failure-')), home = path.join(root, 'native'); await mkdir(home);
    try {
      const store = new AccountProfiles(path.join(root, 'accounts'), () => home);
      const original = JSON.stringify({ tokens: { access_token: 'original-native' } });
      await writeFile(path.join(home, 'auth.json'), original); await writeFile(path.join(home, 'config.toml'), 'model = "original"\n');
      const selected = await store.import('Codex', JSON.stringify({ tokens: { access_token: 'expired-saved' } }), { signedIn: true, method: 'ChatGPT', email: 'new@test' });
      const changed = vi.fn(), apply = vi.spyOn(store, 'apply');
      const manager = new AccountManager(store, { busy: () => false, project: () => root, current: () => undefined,
        read: async (value, _signal, options) => {
          if (typeof value !== 'string') { expect(options).toEqual({ refreshToken: true }); throw new Error('Could not refresh the saved Codex sign-in. Sign in again to this account.'); }
          return { status: 'ready', account: { signedIn: true, method: 'ChatGPT', email: 'old@test' } };
        }, executable: vi.fn(), changed, update: vi.fn() });
      await manager.action({ action: 'switch', id: selected.id });
      expect(manager.state.accountSwitch).toMatchObject({ status: 'error', outcome: 'notChanged', error: expect.stringContaining('Sign in again') });
      expect(apply).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
      expect(await readFile(path.join(home, 'auth.json'), 'utf8')).toBe(original);
      expect(await readFile(path.join(home, 'config.toml'), 'utf8')).toBe('model = "original"\n');
      expect((await store.get(selected.id)).identity?.email).toBe('new@test');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('uses the fresh native grant when selecting the already active Codex account', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-switch-active-')), home = path.join(root, 'native'); await mkdir(home);
    try {
      const store = new AccountProfiles(path.join(root, 'accounts'), () => home), identity = { signedIn: true, method: 'ChatGPT', email: 'same@test' };
      const selected = await store.import('Codex', JSON.stringify({ tokens: { access_token: 'stale-copy' } }), identity);
      await writeFile(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'latest-native' } }));
      const read = vi.fn(async () => ({ status: 'ready' as const, account: identity }));
      const manager = new AccountManager(store, { busy: () => false, project: () => root, current: () => undefined, read, executable: vi.fn(), changed: vi.fn(), update: vi.fn() });
      await manager.action({ action: 'switch', id: selected.id });
      expect(manager.state.accountSwitch?.status).toBe('success');
      expect(read.mock.calls).toEqual([['Codex'], ['Codex']]);
      for (const base of [home, store.home(selected.id)]) expect(JSON.parse(await readFile(path.join(base, 'auth.json'), 'utf8')).tokens.access_token).toBe('latest-native');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects another account returned for a saved profile without relabeling it or caching its quota', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-account-mismatch-'));
    try {
      const home = path.join(root, 'native'); await mkdir(home);
      await writeFile(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'personal-fixture' } }));
      const store = new AccountProfiles(root, () => home), profile = await store.create('Codex', 'dev@example.test');
      const dev = { signedIn: true, method: 'ChatGPT', email: 'dev@example.test', id: 'dev', plan: 'prolite' };
      await store.identify(profile.id, dev);
      const personal = { ...dev, id: 'personal', email: 'personal@example.test', plan: 'plus' };
      const manager = new AccountManager(store, { busy: () => false, project: () => root, current: () => undefined,
        read: async () => ({ status: 'ready', account: personal, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 100 }] } }),
        executable: vi.fn(), changed: vi.fn(), update: vi.fn() });
      await manager.refresh();
      expect((await store.get(profile.id)).identity).toEqual(dev);
      expect(manager.state.managedAccounts![0]!.status).toMatchObject({ status: 'error', account: dev, error: expect.stringContaining('different account') });
      expect(manager.state.managedAccounts![0]!.status?.quota).toBeUndefined();
      await expect(readFile(path.join(root, 'quota-cache.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await manager.action({ action: 'switch', id: profile.id });
      expect(manager.state.accountSwitch?.outcome).toBe('notChanged');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('resets only the active Codex account and blocks parallel or busy mutations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-reset-controller-'));
    try {
      const identity = { signedIn: true, method: 'ChatGPT', email: 'active@test' }, store = new AccountProfiles(root);
      let busy = false, complete!: (notice: string) => void;
      const resetUsage = vi.fn(() => new Promise<string>(resolve => { complete = resolve; }));
      const current: ProviderAccountStatus = { status: 'ready', account: identity, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 0 }] } };
      const manager = new AccountManager(store, { busy: () => busy, project: () => root, current: () => current, read: vi.fn(), executable: vi.fn(), changed: vi.fn(), update: vi.fn(), resetUsage });
      const pending = manager.action({ action: 'resetUsage', provider: 'Codex' });
      await vi.waitFor(() => expect(resetUsage).toHaveBeenCalledWith(identity));
      await expect(manager.action({ action: 'resetUsage', provider: 'Codex' })).rejects.toThrow('still running');
      complete('Codex usage reset. One earned reset was used.'); await pending;
      expect(manager.state.accountsNotice).toContain('One earned reset'); expect(manager.state.accountsBusy).toBe(false);
      expect(JSON.parse(await readFile(path.join(root, 'quota-cache.json'), 'utf8')).snapshots[0].quota.windows[0].usedPercent).toBe(0);
      busy = true; await manager.action({ action: 'resetUsage', provider: 'Codex' });
      expect(manager.state.accountsError).toContain('Finish the active'); expect(resetUsage).toHaveBeenCalledOnce();
      busy = false; await manager.action({ action: 'resetUsage', provider: 'Claude' });
      expect(manager.state.accountsError).toContain('active Codex'); expect(resetUsage).toHaveBeenCalledOnce();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('publishes saved quota before querying the CLI, keeps it after a failed refresh and updates it after success', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-managed-quota-'));
    try {
      const store = new AccountProfiles(root), row = await store.create('Codex', 'Work');
      const identity = { signedIn: true, method: 'ChatGPT', email: 'work@test', plan: 'plus' }; await store.identify(row.id, identity);
      const status: ProviderAccountStatus = { status: 'ready', account: identity, updatedAt: Date.now(), quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 25 }] } };
      const read = vi.fn(async () => status);
      const deps = { busy: () => false, project: () => root, current: () => undefined, read, executable: vi.fn(), changed: vi.fn(), update: vi.fn() };
      await new AccountManager(store, deps).refresh(); read.mockClear();
      const reopened = new AccountManager(new AccountProfiles(root), deps); await reopened.publish();
      expect(read).not.toHaveBeenCalled();
      expect(reopened.state.managedAccounts?.[0]?.status).toMatchObject({ quotaCached: true, updatedAt: status.updatedAt, quota: status.quota });
      let fail!: (error: Error) => void; read.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
      const refreshing = reopened.refresh(); await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      expect(reopened.state.managedAccounts?.[0]?.status?.quota).toEqual(status.quota);
      fail(new Error('Offline')); await refreshing;
      expect(reopened.state.managedAccounts?.[0]?.status).toMatchObject({ status: 'error', quotaCached: true, updatedAt: status.updatedAt, quota: status.quota });
      status.updatedAt! += 1000; status.quota!.windows[0]!.usedPercent = 40; await reopened.refresh();
      expect(reopened.state.managedAccounts?.[0]?.status?.quota?.windows[0]?.usedPercent).toBe(40);
      expect(reopened.state.managedAccounts?.[0]?.status?.quotaCached).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('interrupts a pending quota refresh to switch without waiting for other saved accounts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-switch-refresh-')), home = path.join(root, 'native'); await mkdir(home);
    try {
      const store = new AccountProfiles(path.join(root, 'profiles'), () => home);
      const identity = { signedIn: true, email: 'selected@test', method: 'ChatGPT' };
      const selected = await store.import('Codex', JSON.stringify({ tokens: { access_token: 'selected' } }), identity);
      const unrelated = await store.create('Claude', 'Other account');
      const queued = await store.create('Claude', 'Queued account');
      let refreshSignal: AbortSignal | undefined;
      const read = vi.fn(async (value: AccountProfile | ConversationProvider, signal?: AbortSignal) => {
        if (signal) {
          refreshSignal = signal;
          await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }); });
        }
        return { status: 'ready' as const, account: typeof value === 'string' && !(await readFile(path.join(home, 'auth.json'), 'utf8').catch(() => '')) ? { signedIn: false, method: 'ChatGPT' } : identity };
      });
      const observed = vi.fn(), manager = new AccountManager(store, { busy: () => false, project: () => root, current: () => undefined, read, executable: vi.fn(), changed: vi.fn(), update: vi.fn(), observed });
      const refresh = manager.action({ action: 'refresh' });
      await vi.waitFor(() => expect(refreshSignal).toBeDefined());
      expect(manager.state.accountsBusy).toBeFalsy();
      await manager.action({ action: 'switch', id: selected.id }); await refresh;
      expect(refreshSignal!.aborted).toBe(true); expect(manager.state.accountSwitch?.status).toBe('success');
      expect(manager.state.accountsError).toBeUndefined(); expect(observed).not.toHaveBeenCalled();
      expect(manager.state.managedAccounts?.find(row => row.id === unrelated.id)?.status).toBeUndefined();
      expect(read.mock.calls.some(([value]) => typeof value !== 'string' && value.id === queued.id)).toBe(false);
      expect(JSON.parse(await readFile(path.join(home, 'auth.json'), 'utf8')).tokens.access_token).toBe('selected');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('publishes real progress while reading native auth and reports refresh failure after a verified switch accurately', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-switch-progress-')), home = path.join(root, 'native'); await mkdir(home);
    try {
      const store = new AccountProfiles(path.join(root, 'profiles'), () => home), identity = { signedIn: true, email: 'selected@test', method: 'ChatGPT' };
      const selected = await store.import('Codex', JSON.stringify({ tokens: { access_token: 'private-auth' } }), identity);
      let unblock!: () => void; const wait = new Promise<void>(resolve => { unblock = resolve; });
      const phases: string[] = [];
      const read = async (value: AccountProfile | ConversationProvider) => { if (typeof value === 'string') await wait; return { status: 'ready' as const, account: typeof value === 'string' && !(await readFile(path.join(home, 'auth.json'), 'utf8').catch(() => '')) ? { signedIn: false, method: 'ChatGPT' } : identity }; };
      const manager = new AccountManager(store, { busy: () => false, project: () => root, current: () => undefined, read, executable: async () => 'codex.exe', changed: async () => { throw new Error('Could not refresh models.'); }, update: () => { if (manager?.state.accountSwitch) phases.push(manager.state.accountSwitch.logs.at(-1)?.message || ''); } });
      const task = manager.action({ action: 'switch', id: selected.id });
      await vi.waitFor(() => expect(phases).toContain('Reading the current native sign-in.'));
      expect(manager.state.accountsBusy).toBe(true); expect(manager.state.accountSwitch?.status).toBe('running');
      unblock(); await task;
      expect(manager.state.accountsBusy).toBe(false); expect(manager.state.accountSwitch?.status).toBe('error'); expect(manager.state.accountSwitch?.outcome).toBe('switched');
      expect(manager.state.accountSwitch?.error).toBe('Could not refresh models.');
      expect(manager.state.accountSwitch?.logs.at(-1)?.message).toContain('Sign-in changed');
      expect(JSON.stringify(manager.state.accountSwitch)).not.toContain('private-auth');
      expect(JSON.parse(await readFile(path.join(home, 'auth.json'), 'utf8')).tokens.access_token).toBe('private-auth');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('opens desktop native sign-in, saves its profile and never treats desktop status as CLI quota', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-desktop-manager-'));
    try {
      const store = new AccountProfiles(root), row = await store.create('Cursor');
      const identity = { signedIn: true, email: 'cursor@test', method: 'Cursor account' }; await store.identify(row.id, identity);
      vi.spyOn(store, 'importCurrent').mockResolvedValue(row);
      const read = vi.fn(async () => ({ status: 'ready' as const, account: identity })), openDesktop = vi.fn(), observed = vi.fn();
      const manager = new AccountManager(store, { busy: () => false, project: () => root, current: () => undefined, read, executable: vi.fn(), changed: vi.fn(), update: vi.fn(), openDesktop, observed });
      await manager.action({ action: 'open', id: row.id }); expect(openDesktop).toHaveBeenCalledWith('Cursor'); expect(manager.state.accountsNotice).toContain('Save current');
      await manager.refresh(); expect(manager.state.managedAccounts?.[0]?.active).toBe(true); expect(observed).toHaveBeenCalledWith([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('mirrors rotated default auth for an active profile without refreshing a duplicate OAuth grant', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-active-account-')), home = path.join(root, 'native'); await mkdir(home);
    try {
      const store = new AccountProfiles(path.join(root, 'profiles'), () => home), identity = { signedIn: true, email: 'one@test', method: 'ChatGPT' };
      const profile = await store.import('Codex', JSON.stringify({ tokens: { access_token: 'old' } }), identity);
      await writeFile(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'rotated' } }));
      const read = vi.fn(), manager = new AccountManager(store, { busy: () => false, project: () => root, current: () => ({ status: 'ready', account: identity }), read, executable: async () => 'codex.exe', changed: vi.fn(), update: vi.fn() });
      await manager.refresh(); expect(read).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(path.join(store.home(profile.id), 'auth.json'), 'utf8')).tokens.access_token).toBe('rotated');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('backs up the outgoing account, verifies native identity and restores credentials on a mismatch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-account-manager-')), home = path.join(root, 'native'); await mkdir(home);
    try {
      const store = new AccountProfiles(path.join(root, 'profiles'), () => home);
      const identity = (email: string) => ({ signedIn: true, method: 'ChatGPT', email });
      const encode = (email: string) => JSON.stringify({ tokens: { access_token: email } });
      await writeFile(path.join(home, 'auth.json'), encode('old@test'));
      const selected = await store.import('Codex', encode('new@test'), identity('new@test'));
      let mismatch = false;
      const read = async (profile: AccountProfile | ConversationProvider) => {
        const base = typeof profile === 'string' ? home : store.home(profile.id);
        const auth = JSON.parse(await readFile(path.join(base, 'auth.json'), 'utf8'));
        return { status: 'ready' as const, account: identity(typeof profile === 'string' && mismatch && auth.tokens.access_token === 'new@test' ? 'wrong@test' : auth.tokens.access_token) };
      };
      const changed = vi.fn(), switched = vi.fn(), manager = new AccountManager(store, { busy: () => false, project: () => root, current: () => ({ status: 'ready', account: identity('old@test') }), read, executable: async () => 'codex.exe', changed, update: vi.fn(), switched });
      mismatch = true; await manager.action({ action: 'switch', id: selected.id });
      expect(manager.state.accountsError).toContain('did not verify'); expect(changed).not.toHaveBeenCalled(); expect(switched).not.toHaveBeenCalled();
      expect(manager.state.accountSwitch?.status).toBe('error'); expect(manager.state.accountSwitch?.outcome).toBe('restored');
      expect(manager.state.accountSwitch?.logs.map(row => row.message)).toContain('Previous sign-in restored.');
      expect(manager.state.accountSwitch?.finishedAt).toBeGreaterThanOrEqual(manager.state.accountSwitch!.startedAt);
      expect(await readFile(path.join(home, 'auth.json'), 'utf8')).toBe(encode('old@test'));
      expect((await store.read()).profiles.some(row => row.identity?.email === 'old@test')).toBe(true);
      mismatch = false; await manager.action({ action: 'switch', id: selected.id });
      expect(manager.state.accountsError).toBeUndefined(); expect(changed).toHaveBeenCalledWith('Codex'); expect(switched).toHaveBeenCalledExactlyOnceWith('Codex');
      expect(await readFile(path.join(home, 'auth.json'), 'utf8')).toBe(encode('new@test'));
      expect(manager.state.accountsNotice).toContain('default CLI');
      expect(manager.state.accountSwitch?.status).toBe('success'); expect(manager.state.accountSwitch?.outcome).toBe('switched');
      expect(manager.state.accountSwitch?.logs.map(row => row.message)).toEqual(expect.arrayContaining(['Backing up the current sign-in.', 'Checking the selected sign-in.', 'Verifying the new native sign-in.', 'Refreshing account, models and usage.', 'Account switch complete.']));
      expect(JSON.stringify(manager.state.accountSwitch?.logs)).not.toContain('access_token');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('blocks a switch during an active turn and uses isolated homes for native interactive login', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-account-login-'));
    try {
      const store = new AccountProfiles(root), row = await store.create('Claude');
      const manager = new AccountManager(store, { busy: () => true, project: () => root, current: () => undefined, read: vi.fn(), executable: async () => 'claude.exe', changed: vi.fn(), update: vi.fn() });
      await manager.action({ action: 'switch', id: row.id }); expect(manager.state.accountsError).toContain('active agent turn');
      expect(manager.state.accountSwitch?.outcome).toBe('notChanged'); expect(manager.state.accountSwitch?.status).toBe('error');
      await manager.action({ action: 'login', id: row.id });
      expect(ui.terminal).toHaveBeenLastCalledWith(expect.objectContaining({ shellPath: 'claude.exe', shellArgs: ['auth', 'login'], env: expect.objectContaining({ CLAUDE_CONFIG_DIR: store.home(row.id) }) }));
      expect(ui.terminal).toHaveBeenLastCalledWith(expect.objectContaining({ env: expect.objectContaining({ ANTHROPIC_API_KEY: null, CLAUDE_CODE_OAUTH_TOKEN: null }) }));
      expect(ui.show).toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
