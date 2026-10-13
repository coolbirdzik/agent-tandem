import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountProfiles } from '../src/core/account-profiles';

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-profiles-')); roots.push(root);
  const home = path.join(root, 'native'); await mkdir(home);
  return { root, home, store: new AccountProfiles(path.join(root, 'accounts'), () => home) };
}
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const identity = (email: string) => ({ signedIn: true, method: 'ChatGPT', email, plan: 'plus' });
const codex = (secret: string) => JSON.stringify({ tokens: { access_token: secret, refresh_token: `${secret}-refresh` } });

describe('Native account profiles', () => {
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
  it('clears environment auth overrides for isolated quota reads and validates profile IDs', async () => {
    const { store } = await setup(); vi.stubEnv('OPENAI_API_KEY', 'secret'); vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'secret');
    const a = await store.create('Codex'), b = await store.create('Claude');
    expect(store.environment(a).OPENAI_API_KEY).toBeUndefined(); expect(store.environment(a).CODEX_HOME).toBe(store.home(a.id));
    expect(store.environment(b).ANTHROPIC_AUTH_TOKEN).toBeUndefined(); expect(store.environment(b).CLAUDE_CONFIG_DIR).toBe(store.home(b.id));
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
