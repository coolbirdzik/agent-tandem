import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { it, expect } from 'vitest';
import { providerTestHomes } from '../scripts/provider-test-homes.mjs';
it('isolates histories, seeds only login/config and keeps test writes independent from real homes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdock-isolation-')), home = path.join(root, 'user'), runtime = path.join(root, '.test-runtime', 'models-live-123');
  await mkdir(path.join(home, '.codex', 'sessions'), { recursive: true }); await mkdir(path.join(home, '.claude', 'projects'), { recursive: true });
  await writeFile(path.join(home, '.codex/auth.json'), 'fake-codex-token');
  await writeFile(path.join(home, '.claude/.credentials.json'), 'fake-claude-token');
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'fixture' }, projects: { private: 'history' } }));
  const env = await providerTestHomes(runtime, { root, home, sources: {} });
  expect(env.CODEX_HOME).toContain(runtime); expect(env.CLAUDE_CONFIG_DIR).toContain(runtime);
  expect(await readdir(env.CODEX_HOME)).not.toContain('sessions'); expect(await readdir(env.CLAUDE_CONFIG_DIR)).not.toContain('projects');
  expect(JSON.parse(await readFile(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8'))).toEqual({ oauthAccount: { accountUuid: 'fixture' } });
  await writeFile(path.join(env.CODEX_HOME, 'auth.json'), 'refreshed-test-token');
  expect(await readFile(path.join(home, '.codex/auth.json'), 'utf8')).toBe('fake-codex-token');
  expect(await providerTestHomes(runtime, { root, home, sources: {}, reopen: true })).toEqual(env);
  expect(await readFile(path.join(env.CODEX_HOME, 'auth.json'), 'utf8')).toBe('refreshed-test-token');
});
it('refuses legacy shared-home reopen and paths outside the test runtime', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdock-isolation-'));
  await expect(providerTestHomes(path.join(root, '.test-runtime', 'models-live-123'), { root, reopen: true })).rejects.toThrow('old test runtime');
  await expect(providerTestHomes(path.join(root, 'user'), { root })).rejects.toThrow('dedicated .test-runtime');
});
it('every live Extension Host launcher supplies both isolated provider homes', async () => {
  for (const name of ['models', 'access', 'stop', 'edit', 'review', 'cli-manager']) {
    const text = await readFile(path.resolve(`scripts/test-${name}-live.mjs`), 'utf8');
    expect(text).toContain('await providerTestHomes(runtime'); expect(text).toContain('extensionTestsEnv: { ...providerHomes,');
  }
});
