import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { UsageAccountStore } from '../src/core/usage-account-store';
import { usageAccount } from '../src/core/usage-account';

describe('Native usage account evidence', () => {
  it('normalizes emails and separates provider, authentication method and organization', () => {
    const identity = { signedIn: true, email: ' One@Example.Test ', method: 'Claude account' };
    const account = usageAccount('Claude', identity)!;
    expect(account.email).toBe('one@example.test');
    expect(usageAccount('Claude', { ...identity, email: 'one@example.test' })?.id).toBe(account.id);
    expect(usageAccount('Claude', { ...identity, organization: 'org' })?.id).not.toBe(account.id);
    expect(usageAccount('Codex', { ...identity, method: 'ChatGPT' })?.id).not.toBe(account.id);
    expect(usageAccount('Codex', { ...identity, method: 'API key' })).toBeUndefined();
    expect(usageAccount('Claude', { ...identity, signedIn: false })).toBeUndefined();
  });
  it('persists individual IDs across reload, drops credentials and quarantines conflicting evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-dock-accounts-'));
    try {
      const one = usageAccount('Claude', { signedIn: true, email: 'one@test.invalid', method: 'Claude account' })!;
      const two = usageAccount('Claude', { signedIn: true, email: 'two@test.invalid', method: 'Claude account' })!;
      const store = new UsageAccountStore(directory);
      await Promise.all([store.record('Claude:msg-one', { ...one, accessToken: 'secret' } as typeof one), store.record('Claude:msg-two', two)]);
      await store.record('Claude:msg-one', one);
      const file = await readFile(path.join(directory, 'accounts.jsonl'), 'utf8');
      expect(file).not.toContain('secret'); expect(file.trim().split('\n')).toHaveLength(2);
      const reloaded = new UsageAccountStore(directory);
      expect((await reloaded.read()).get('Claude:msg-one')).toEqual(one);
      await reloaded.record('Claude:msg-one', two); await reloaded.record('Claude:msg-one', one);
      expect((await new UsageAccountStore(directory).read()).get('Claude:msg-one')).toBeNull();
      await appendFile(path.join(directory, 'accounts.jsonl'), '{broken\n' + JSON.stringify({ key: 'Codex:bad', account: one }) + '\n');
      expect((await new UsageAccountStore(directory).read()).has('Codex:bad')).toBe(false);
      expect((await new UsageAccountStore(directory).read()).get('Claude:msg-two')).toEqual(two);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
