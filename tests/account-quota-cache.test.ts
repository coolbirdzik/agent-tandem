import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AccountQuotaCache } from '../src/core/account-quota-cache';
import type { ProviderAccountStatus } from '../src/providers/account-status';
import { quotaTicks } from '../src/core/quota-pace';
import { quotaMeters } from '../src/core/quota-estimate';

const account = { signedIn: true, method: 'ChatGPT', email: 'one@test', id: 'workspace-one', plan: 'plus' };
const status: ProviderAccountStatus = { status: 'ready', account, updatedAt: Date.now(), quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 0, resetsAt: Date.now() + 3600000 }], bankedResets: { availableCount: 0 } } };
async function fixture(run: (root: string, cache: AccountQuotaCache) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-quota-cache-'));
  try { await run(root, new AccountQuotaCache(root)); } finally { await rm(root, { recursive: true, force: true }); }
}
describe('Account quota snapshots', () => {
  it('restores display meters after restart without persisting credentials or raw payloads', async () => fixture(async (root, cache) => {
    await cache.remember('Codex', { ...status, access_token: 'private-auth', quota: { ...status.quota!, access_token: 'private-quota', windows: [{ ...status.quota!.windows[0]!, refresh_token: 'private-window' }] } } as unknown as ProviderAccountStatus);
    const reopened = new AccountQuotaCache(root); await reopened.load();
    const restored = reopened.restore('Codex', { status: 'loading', account });
    expect(restored).toMatchObject({ status: 'loading', quotaCached: true, updatedAt: status.updatedAt, quota: status.quota });
    expect(await readFile(path.join(root, 'quota-cache.json'), 'utf8')).not.toContain('private-');
  }));
  it('isolates accounts, providers, workspaces and plans and does not guess a signed-out identity', async () => fixture(async (_root, cache) => {
    await cache.remember('Codex', status);
    for (const identity of [{ ...account, id: 'workspace-two' }, { ...account, plan: 'pro' }, { ...account, signedIn: false }, { ...account, id: undefined, email: 'two@test' }]) {
      expect(cache.restore('Codex', { status: 'loading', account: identity }).quota).toBeUndefined();
    }
    expect(cache.restore('Claude', { status: 'loading', account: { ...account, method: 'Claude account' } }).quota).toBeUndefined();
    expect(cache.restore('Codex', { status: 'loading' }).quota).toBeUndefined();
  }));
  it('retains the last success through query errors, keeps its original timestamp and replaces it on success', async () => fixture(async (_root, cache) => {
    await cache.remember('Codex', status);
    const error: ProviderAccountStatus = { status: 'ready', account, updatedAt: status.updatedAt! + 1000, quota: { status: 'error', windows: [], detail: 'Offline' } };
    await cache.remember('Codex', error);
    const restored = cache.restore('Codex', error);
    expect(restored.quota).toEqual(status.quota); expect(restored.updatedAt).toBe(status.updatedAt); expect(restored.quotaCached).toBe(true);
    expect(quotaTicks('Codex', restored)).toEqual([]); expect(quotaMeters('Codex', restored)).toEqual([]);
    const next = { ...status, updatedAt: status.updatedAt! + 2000, quota: { ...status.quota!, windows: [{ ...status.quota!.windows[0]!, usedPercent: 50 }] } };
    await cache.remember('Codex', next);
    expect(cache.restore('Codex', next).quotaCached).toBeUndefined();
    expect(cache.restore('Codex', { status: 'loading', account }).quota?.windows[0]?.usedPercent).toBe(50);
  }));
  it('clears an obsolete snapshot when the CLI confirms quota is unavailable', async () => fixture(async (root, cache) => {
    await cache.remember('Codex', status);
    await cache.remember('Codex', { ...status, quota: { status: 'unavailable', windows: [] } });
    const reopened = new AccountQuotaCache(root); await reopened.load();
    expect(reopened.restore('Codex', { status: 'loading', account }).quota).toBeUndefined();
  }));
  it('merges writes from multiple windows and ignores malformed cache files', async () => fixture(async (root, cache) => {
    await writeFile(path.join(root, 'quota-cache.json'), '{broken'); await cache.load();
    expect(cache.restore('Codex', { status: 'loading', account }).quota).toBeUndefined();
    const other = new AccountQuotaCache(root); await other.load();
    const second = { ...account, id: 'workspace-two' };
    await Promise.all([cache.remember('Codex', status), other.remember('Codex', { ...status, account: second })]);
    const reopened = new AccountQuotaCache(root); await reopened.load();
    for (const identity of [account, second]) expect(reopened.restore('Codex', { status: 'loading', account: identity }).quota).toEqual(status.quota);
  }));
});
