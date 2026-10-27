import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountProfiles } from '../src/core/account-profiles';
import { claudeKeychainService } from '../src/core/claude-keychain';

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-profiles-')); roots.push(root);
  const home = path.join(root, 'native'); await mkdir(home);
  return { root, home, store: new AccountProfiles(path.join(root, 'accounts'), () => home) };
}
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const identity = (email: string) => ({ signedIn: true, method: 'ChatGPT', email, plan: 'plus' });
const codex = (secret: string) => JSON.stringify({ tokens: { access_token: secret, refresh_token: `${secret}-refresh` } });
const credential = (email: string, id: string, plan = 'plus') => JSON.stringify({ tokens: { account_id: id,
  id_token: `header.${Buffer.from(JSON.stringify({ email, 'https://api.openai.com/auth': { chatgpt_account_id: id, chatgpt_plan_type: plan } })).toString('base64url')}.signature`, access_token: 'private-access' } });

describe('Native account profiles', () => {
  it('recovers expired profile display metadata from its own credentials after an older refresh erased it', async () => {
    const { store } = await setup(), dev = { ...identity('dev@example.test'), id: 'dev', plan: 'prolite' };
    const profile = await store.import('Codex', credential(dev.email, dev.id, dev.plan), dev);
    const saved = await store.read(); saved.profiles[0]!.identity = { signedIn: false, method: 'Not signed in' };
    await writeFile(path.join(store.root, 'accounts.json'), JSON.stringify(saved));
    expect((await store.get(profile.id)).identity).toEqual(dev);
    await expect(store.identify(profile.id, { signedIn: false, method: 'Not signed in' })).rejects.toThrow('expired');
    saved.profiles[0]!.label = 'other@example.test'; await writeFile(path.join(store.root, 'accounts.json'), JSON.stringify(saved));
    expect((await store.get(profile.id)).identity?.signedIn).toBe(false);
  });
  it('never labels a profile from a signed-out read and repairs labels saved that way', async () => {
    const { store } = await setup(), dev = { ...identity('dev@example.test'), id: 'dev' };
    const profile = await store.create('Codex');
    await store.identify(profile.id, { signedIn: false, method: 'Not signed in' });
    expect((await store.get(profile.id)).label).toBe('New account');
    await store.identify(profile.id, dev);
    expect((await store.get(profile.id)).label).toBe(dev.email);
    const saved = await store.read(); saved.profiles[0]!.label = 'Not signed in';
    await writeFile(path.join(store.root, 'accounts.json'), JSON.stringify(saved));
    expect((await store.get(profile.id)).label).toBe(dev.email);
    await store.rename(profile.id, 'Work'); await store.identify(profile.id, dev);
    expect((await store.get(profile.id)).label).toBe('Work');
  });
  it('rejects stale native identity before overwriting saved credentials after an external account switch', async () => {
    const { home, store } = await setup();
    const dev = { ...identity('dev@example.test'), id: 'dev', plan: 'prolite' };
    const original = credential(dev.email, dev.id, dev.plan);
    const profile = await store.import('Codex', original, dev);
    await writeFile(path.join(home, 'auth.json'), credential('personal@example.test', 'personal'));
    await expect(store.importCurrent('Codex', dev)).rejects.toThrow('different account');
    expect(await readFile(path.join(store.home(profile.id), 'auth.json'), 'utf8')).toBe(original);
    expect((await store.get(profile.id)).identity).toEqual(dev);
    await expect(store.identify(profile.id, identity('personal@example.test'))).rejects.toThrow('different account');
    await expect(store.identify(profile.id, { signedIn: false, method: 'Not signed in' })).rejects.toThrow('expired');
    expect((await store.get(profile.id)).identity).toEqual(dev);
  });
  it('reads Pro Lite from credential metadata and fills a native id without duplicating the saved email identity', async () => {
    const { store } = await setup(); const dev = { ...identity('dev@example.test'), plan: 'prolite' };
    const profile = await store.import('Codex', codex('old'), dev);
    const updated = await store.import('Codex', credential(dev.email, 'dev', 'prolite'));
    expect(updated.id).toBe(profile.id); expect((await store.read()).profiles).toHaveLength(1);
    expect((await store.get(profile.id)).identity).toMatchObject({ email: dev.email, id: 'dev', plan: 'prolite' });
    await expect(store.import('Codex', credential('personal@example.test', 'personal'), dev)).rejects.toThrow('different account');
  });
  it('imports without switching, refreshes an existing identity, and exposes no credentials in its registry', async () => {
    const { home, store } = await setup(); await writeFile(path.join(home, 'auth.json'), codex('first-secret'));
    const profile = await store.importCurrent('Codex', identity('one@example.test'));
    expect(await readFile(path.join(home, 'auth.json'), 'utf8')).toBe(codex('first-secret'));
    await writeFile(path.join(home, 'auth.json'), codex('rotated-secret'));
    const updated = await store.importCurrent('Codex', identity('one@example.test'));
    expect(updated.id).toBe(profile.id); expect((await store.read()).profiles).toHaveLength(1);
    expect(await readFile(path.join(store.home(profile.id), 'auth.json'), 'utf8')).toBe(codex('rotated-secret'));
    expect(await readFile(path.join(store.root, 'accounts.json'), 'utf8')).not.toContain('secret');
  });
  it('switches native auth and preserves configuration and conversation history, with complete rollback', async () => {
    const { home, store } = await setup();
    await mkdir(path.join(home, 'sessions')); await writeFile(path.join(home, 'sessions', 'history.jsonl'), 'keep history');
    await writeFile(path.join(home, 'auth.json'), codex('original'));
    const config = 'model = "test-model"\ncli_auth_credentials_store = "keyring"\n[model_providers.test]\nbase_url = "https://example.test"\n';
    await writeFile(path.join(home, 'config.toml'), config);
    const profile = await store.import('Codex', codex('selected'), identity('two@example.test'));
    const rollback = await store.apply(profile.id);
    expect(await readFile(path.join(home, 'auth.json'), 'utf8')).toBe(codex('selected'));
    expect(await readFile(path.join(home, 'config.toml'), 'utf8')).toContain('cli_auth_credentials_store = "file"');
    expect(await readFile(path.join(home, 'config.toml'), 'utf8')).toContain('[model_providers.test]');
    expect(await readFile(path.join(home, 'sessions', 'history.jsonl'), 'utf8')).toBe('keep history');
    await rollback(); expect(await readFile(path.join(home, 'auth.json'), 'utf8')).toBe(codex('original'));
    expect(await readFile(path.join(home, 'config.toml'), 'utf8')).toBe(config);
  });
  it('switches Claude credentials and only login metadata, preserving native preferences and projects', async () => {
    const { home, store } = await setup();
    const original = JSON.stringify({ claudeAiOauth: { accessToken: 'old-secret' } });
    await writeFile(path.join(home, '.credentials.json'), original);
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'old@test' }, theme: 'dark', projects: { workspace: { trusted: true } } }));
    const profile = await store.import('Claude', JSON.stringify({ claudeAiOauth: { accessToken: 'new-secret' } }),
      { signedIn: true, method: 'Claude account', email: 'new@test' }, JSON.stringify({ oauthAccount: { emailAddress: 'new@test' }, projects: { unwanted: {} }, theme: 'light' }));
    const rollback = await store.apply(profile.id), config = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8'));
    expect(config).toMatchObject({ oauthAccount: { emailAddress: 'new@test' }, theme: 'dark', projects: { workspace: { trusted: true } } });
    expect(config.projects).not.toHaveProperty('unwanted');
    expect(JSON.stringify(await store.read())).not.toContain('secret');
    await rollback(); expect(await readFile(path.join(home, '.credentials.json'), 'utf8')).toBe(original);
  });
  it('uses the macOS Keychain item ahead of the plaintext file, like the Claude CLI', async () => {
    const { root, home } = await setup(), items = new Map<string, { account: string; content: string }>();
    const keychain = { read: async (service: string) => items.get(service), write: async (service: string, account: string, content: string) => { items.set(service, { account, content }); }, remove: async (service: string) => { items.delete(service); } };
    const store = new AccountProfiles(path.join(root, 'accounts'), () => home, undefined, keychain);
    const native = claudeKeychainService(home), original = JSON.stringify({ claudeAiOauth: { accessToken: 'native-secret' } });
    await expect(store.importCurrent('Claude')).rejects.toThrow('No native sign-in found');
    items.set(native, { account: 'claude-code-user', content: original });
    const saved = await store.importCurrent('Claude', { signedIn: true, method: 'Claude account', email: 'old@test' });
    expect(await readFile(path.join(store.home(saved.id), '.credentials.json'), 'utf8')).toBe(original);
    // A profile added with `claude auth login` on macOS only exists in its hashed Keychain item.
    const added = await store.create('Claude'), selected = JSON.stringify({ claudeAiOauth: { accessToken: 'selected-secret' } });
    items.set(claudeKeychainService(store.home(added.id)), { account: 'me', content: selected });
    const rollback = await store.apply(added.id);
    expect(items.get(native)).toEqual({ account: 'claude-code-user', content: selected });
    await expect(access(path.join(home, '.credentials.json'))).rejects.toThrow();
    await rollback(); expect(items.get(native)?.content).toBe(original);
    await store.import('Claude', JSON.stringify({ claudeAiOauth: { accessToken: 'rotated-secret' } }), { signedIn: true, method: 'Claude account', email: 'old@test' });
    expect(items.get(claudeKeychainService(store.home(added.id)))?.content).toBe(selected);
    await store.identify(added.id, { signedIn: true, method: 'Claude account', email: 'new@test' });
    await store.import('Claude', JSON.stringify({ claudeAiOauth: { accessToken: 'rotated-secret' } }), { signedIn: true, method: 'Claude account', email: 'new@test' });
    expect(items.get(claudeKeychainService(store.home(added.id)))).toEqual({ account: 'me', content: JSON.stringify({ claudeAiOauth: { accessToken: 'rotated-secret' } }) });
    await store.remove(added.id); expect(items.has(claudeKeychainService(store.home(added.id)))).toBe(false);
  });
  it('names Claude Keychain items the way the CLI does', () => {
    expect(claudeKeychainService()).toBe('Claude Code-credentials');
    expect(claudeKeychainService('/Users/me/profile')).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
  });
  it('clears environment auth overrides for isolated quota reads and validates profile IDs', async () => {
    const { store } = await setup(); vi.stubEnv('OPENAI_API_KEY', 'secret'); vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'secret'); vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR', '/elsewhere');
    const a = await store.create('Codex'), b = await store.create('Claude');
    expect(store.environment(a).OPENAI_API_KEY).toBeUndefined(); expect(store.environment(a).CODEX_HOME).toBe(store.home(a.id));
    expect(store.environment(b).ANTHROPIC_AUTH_TOKEN).toBeUndefined(); expect(store.environment(b).CLAUDE_CONFIG_DIR).toBe(store.home(b.id));
    expect(store.environment(b).CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    expect(() => store.home('../../native')).toThrow('Invalid account profile');
    await expect(store.import('Codex', '"credential-private-text')).rejects.toThrow('Invalid native account JSON');
  });
  it('removes profile credentials without deleting native sign-in or saved profile history', async () => {
    const { home, store } = await setup(); await writeFile(path.join(home, 'auth.json'), codex('native'));
    const a = await store.import('Codex', codex('profile'));
    await mkdir(path.join(store.home(a.id), 'sessions')); await writeFile(path.join(store.home(a.id), 'sessions', 'kept'), 'history');
    await store.remove(a.id);
    expect((await store.read()).profiles).toEqual([]);
    await expect(access(path.join(store.home(a.id), 'auth.json'))).rejects.toThrow();
    expect(await readFile(path.join(home, 'auth.json'), 'utf8')).toBe(codex('native'));
    expect(await readFile(path.join(store.home(a.id), 'sessions', 'kept'), 'utf8')).toBe('history');
  });
});
