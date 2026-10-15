import { describe, it, expect } from 'vitest';
import { quotaBurnDown, quotaPace, quotaTicks, quotaWindowDuration, type QuotaTick } from '../src/core/quota-pace';
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
    expect(quotaTicks('Claude', { ...status, quotaCached: true }, now)).toEqual([]);
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
describe('Quota burn-down', () => {
  const tick = (at: number, usedPercent: number, jitter = 0): QuotaTick => ({ provider: 'Claude', accountId: 'one', plan: 'pro', windowId: 'five_hour', label: '5h', resetsAt: now + 3 * hour + jitter, at, usedPercent });
  it('reads window lengths from quota labels', () => {
    expect(quotaWindowDuration('5h')).toBe(5 * hour); expect(quotaWindowDuration('Opus · 7d')).toBe(7 * 24 * hour);
    expect(quotaWindowDuration('90m')).toBe(90 * 60000); expect(quotaWindowDuration('Primary')).toBeUndefined();
  });
  it('anchors the cycle at 0% used, joins jittered reset times and projects the cycle average to reset', () => {
    // Window: now - 2h .. now + 3h. 40% used in 2h = 20%/h, so 60% left runs out in 3h, exactly at reset.
    const burn = quotaBurnDown([tick(now - hour, 20, 15), tick(now - 3 * hour, 90)], tick(now, 40, -900), now);
    expect(burn.start).toBe(now - 2 * hour - 900); expect(burn.anchored).toBe(true);
    expect(burn.points.map(point => point.remaining)).toEqual([80, 60]);
    expect(burn.percentPerHour).toBeCloseTo(20, 2); expect(burn.remaining).toBe(60);
    expect(burn.idealRemaining).toBeCloseTo(60, 1); expect(burn.projectedAtReset).toBeCloseTo(0, 1);
    const fast = quotaBurnDown([], tick(now, 80), now);
    expect(fast.beforeReset).toBe(true); expect(fast.exhaustsAt).toBe(now + 0.5 * hour);
    expect(quotaPace([tick(now - hour / 2, 30, 40)], tick(now, 40), now).percentPerHour).toBe(20);
  });
  it('restarts from observed samples after a correction and bounds stored points', () => {
    const burn = quotaBurnDown([tick(now - 90 * 60000, 50), tick(now - hour, 10)], tick(now, 30), now);
    expect(burn.anchored).toBe(false); expect(burn.percentPerHour).toBe(20);
    const many = Array.from({ length: 2000 }, (_, index) => tick(now - 2 * hour + index * 3000, index / 100));
    expect(quotaBurnDown(many, tick(now, 25), now).points.length).toBeLessThanOrEqual(241);
  });
});
it('keeps the current sample when an idle rolling window starts just after it', () => {
  const current: QuotaTick = { provider: 'Codex', accountId: 'one', plan: 'plus', windowId: 'codex:primary', label: '5h', resetsAt: now + 5 * 3600000 + 500, at: now, usedPercent: 0 };
  const burn = quotaBurnDown([], current, now);
  expect(burn.start).toBe(now); expect(burn.points).toEqual([{ at: now, remaining: 100 }]); expect(burn.percentPerHour).toBeUndefined();
});
