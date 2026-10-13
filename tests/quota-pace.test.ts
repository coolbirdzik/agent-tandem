import { describe, it, expect } from 'vitest';
import { quotaPace, quotaTicks, type QuotaTick } from '../src/core/quota-pace';
import { QuotaPaceStore } from '../src/core/quota-pace-store';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const now = Date.parse('2026-10-13T06:00:00Z'), hour = 3600000;
const sample = (at: number, usedPercent: number): QuotaTick => ({ provider: 'Claude', accountId: 'one', plan: 'pro', windowId: 'five_hour', label: '5h', resetsAt: now + 5 * hour, at, usedPercent });
describe('Observed quota burn rate', () => {
  it('measures percent per hour and estimates exhaustion before reset without token counters', () => {
    const current = sample(now, 50), pace = quotaPace([sample(now - hour, 25), sample(now - hour / 2, 37)], current, now);
    expect(pace.percentPerHour).toBe(25); expect(pace.exhaustsAt).toBe(now + 2 * hour); expect(pace.beforeReset).toBe(true);
    expect(quotaPace([sample(now - hour, 50)], current, now).percentPerHour).toBe(0);
    expect(quotaPace([], current, now).percentPerHour).toBeUndefined();
  });
  it('separates reset cycles/accounts and restarts after a correction instead of showing negative burn', () => {
    const current = sample(now, 10);
    expect(quotaPace([{ ...sample(now - hour, 9), accountId: 'two' }, { ...sample(now - hour, 9), resetsAt: now + hour }], current, now).percentPerHour).toBeUndefined();
    expect(quotaPace([sample(now - hour, 20), sample(now - hour / 2, 30)], current, now).percentPerHour).toBeUndefined();
    expect(quotaPace([sample(now - hour, 20), sample(now - hour / 2, 5)], current, now).percentPerHour).toBe(10);
    expect(quotaPace([sample(now - 2 * hour, 1)], current, now).percentPerHour).toBeUndefined();
  });
  it('collects Claude quota without a token API and excludes stale or unidentified accounts', () => {
    const status = { status: 'ready' as const, account: { signedIn: true, email: 'claude@test', method: 'Claude account' }, updatedAt: now,
      quota: { status: 'available' as const, windows: [{ id: 'five_hour', label: '5h', resetsAt: now + hour, usedPercent: 0 }] } };
    expect(quotaTicks('Claude', status, now)).toHaveLength(1);
    expect(quotaTicks('Claude', { ...status, updatedAt: now - 6 * 60000 }, now)).toEqual([]);
    expect(quotaTicks('Claude', { ...status, account: undefined }, now)).toEqual([]);
  });
  it('persists independent samples across reloads without duplicating polls or retaining unknown fields', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-pace-'));
    try {
      const first = sample(now - hour, 10), next = sample(now, 20);
      await new QuotaPaceStore(root).record([{ ...first, secret: 'private' } as QuotaTick], now);
      const store = new QuotaPaceStore(root); expect(await store.record([next, next], now)).toEqual([first, next]);
      expect(await readFile(path.join(root, 'quota-pace.json'), 'utf8')).not.toContain('private');
      expect(quotaPace(await store.record([], now), next, now).percentPerHour).toBe(10);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
