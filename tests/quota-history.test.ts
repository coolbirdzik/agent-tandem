import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mergeQuotaObservations, quotaCycles, quotaTrends, quotaObservations, quotaMeters, observeQuotaMeters, type QuotaObservation } from '../src/core/quota-estimate';
import { QuotaHistoryStore } from '../src/core/quota-history-store';
import { usageAccount } from '../src/core/usage-account';
import type { ProviderAccountStatus } from '../src/providers/account-status';

const now = Date.parse('2026-10-11T06:00:00Z'), hour = 3600000;
const identity = { signedIn: true, email: 'one@example.test', method: 'ChatGPT', plan: 'plus' };
const account: ProviderAccountStatus = { status: 'ready', account: identity };
const accountId = usageAccount('Codex', identity)!.id;
const sample = (cycle: number, observedTokens = 100, usedPercent = 10): QuotaObservation => ({
  provider: 'Codex', accountId, plan: 'plus', label: '5h', from: now + cycle * 5 * hour,
  resetsAt: now + (cycle + 1) * 5 * hour, to: now + cycle * 5 * hour + hour, observedTokens, usedPercent,
});

describe('Quota history and capacity trends', () => {
  it('loads saved quota during activation even when another process holds the write lock', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-quota-read-'));
    await new QuotaHistoryStore(directory).record([sample(0)]);
    const lock = path.join(directory, '.snapshot-lock'), ownerFile = path.join(lock, 'owner.json');
    await mkdir(lock); const owner = JSON.stringify({ pid: process.pid, token: 'live-quota-write' }); await writeFile(ownerFile, owner);
    expect(await new QuotaHistoryStore(directory).read()).toHaveLength(1);
    expect(await readFile(ownerFile, 'utf8')).toBe(owner);
  });
  const apiStatus = (time: number, total: number, used: number): ProviderAccountStatus => ({ ...account, updatedAt: time,
    quota: { status: 'available', windows: [{ id: 'weekly', label: '7d', usedPercent: used, resetsAt: now + 3 * 86400000 }] },
    usage: { source: 'API', status: 'available', accountId, updatedAt: time, summary: { lifetimeTokens: total } } });
  it('uses paired API increases without local account attribution and persists its baseline across reloads', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-quota-api-'));
    const first = new QuotaHistoryStore(directory);
    expect(await first.record([], quotaMeters('Codex', apiStatus(now, 10000000, 16), now))).toEqual([]);
    expect(first.baselines).toHaveLength(1);
    const reopened = new QuotaHistoryStore(directory), time = now + 60000;
    const rows = await reopened.record([], quotaMeters('Codex', apiStatus(time, 10200000, 18), time));
    expect(rows).toMatchObject([{ source: 'API', label: 'Weekly', observedTokens: 200000, usedPercent: 2, from: now }]);
    expect(quotaTrends('Codex', account, rows)[1]).toMatchObject({ source: 'API', tokensPerPercent: 100000 });
    const updated = await reopened.record([], quotaMeters('Codex', apiStatus(time + 60000, 10600000, 20), time + 60000));
    expect(updated).toHaveLength(1); expect(updated[0]).toMatchObject({ observedTokens: 600000, usedPercent: 4 });
    expect(await reopened.record([], quotaMeters('Codex', apiStatus(time, 10200000, 18), time))).toEqual(updated);
  });
  it('records zero-quota baselines, waits for both meters, and resets after a counter or quota correction', () => {
    const first = quotaMeters('Codex', apiStatus(now, 1000, 0), now)[0]!;
    const start = observeQuotaMeters([], [first]);
    expect(start.baselines).toHaveLength(1);
    expect(observeQuotaMeters(start.baselines, [{ ...first, to: now + 1, totalTokens: 2000 }]).observations).toEqual([]);
    expect(observeQuotaMeters(start.baselines, [{ ...first, to: now + 1, usedPercent: 2 }]).observations).toEqual([]);
    const next = { ...first, to: now + 2, totalTokens: 2000, usedPercent: 2 };
    const captured = observeQuotaMeters(start.baselines, [next]); expect(captured.observations[0]?.observedTokens).toBe(1000);
    expect(observeQuotaMeters(captured.baselines, []).observations).toEqual(captured.observations);
    expect(observeQuotaMeters(captured.baselines, [next]).observations).toEqual(captured.observations);
    for (const reset of [{ ...next, totalTokens: 500 }, { ...next, usedPercent: 1 }]) {
      const result = observeQuotaMeters(captured.baselines, [{ ...reset, to: now + 3 }]);
      expect(result.observations).toEqual([]); expect(result.baselines[0]?.start.to).toBe(now + 3);
    }
  });
  it('never mixes account-wide API ratios with local subsets, other accounts or quota cycles', () => {
    const local = sample(0), api = { ...local, source: 'API' as const, observedTokens: 900, usedPercent: 3 };
    const rows = mergeQuotaObservations([local], [api]); expect(rows).toHaveLength(2);
    expect(quotaTrends('Codex', account, rows)[0]).toMatchObject({ source: 'API', tokensPerPercent: 300, observations: [api] });
    const first = quotaMeters('Codex', apiStatus(now, 1000, 16), now)[0]!;
    const start = observeQuotaMeters([], [first]);
    for (const changed of [{ ...first, accountId: 'other' }, { ...first, plan: 'pro' }, { ...first, resetsAt: first.resetsAt + 7 * 86400000 }]) {
      expect(observeQuotaMeters(start.baselines, [{ ...changed, to: now + 1, totalTokens: 2000, usedPercent: 18 }]).observations).toEqual([]);
    }
    const mismatch = apiStatus(now, 1000, 16); mismatch.usage!.accountId = 'other';
    expect(quotaMeters('Codex', mismatch, now)).toEqual([]);
    const stale = apiStatus(now - 6 * 60000, 1000, 16); expect(quotaMeters('Codex', stale, now)).toEqual([]);
    const cached = { ...apiStatus(now, 1000, 16), quotaCached: true }; expect(quotaMeters('Codex', cached, now)).toEqual([]);
  });
  it('weights all cycles by used quota and compares the latest cycle with earlier history', () => {
    const [trend] = quotaTrends('Codex', account, [sample(0), sample(1, 900, 30), sample(2, 800, 20)]);
    expect(trend).toMatchObject({ tokensPerPercent: 30, baselineTokensPerPercent: 25, latestTokensPerPercent: 40 });
    expect(trend?.changePercent).toBeCloseTo(60);
    expect(quotaTrends('Codex', account, [sample(0), sample(1, 50, 10)])[0]?.changePercent).toBe(-50);
    expect(quotaTrends('Codex', account, [sample(0)])[0]?.changePercent).toBeUndefined();
  });
  it('replaces cumulative refreshes of a cycle and ignores repeated or older snapshots', () => {
    const first = sample(0), updated = { ...first, to: first.to + hour, observedTokens: 1000, usedPercent: 20 };
    const rows = mergeQuotaObservations([first], [updated, updated, first]);
    expect(rows).toEqual([updated]);
    expect(quotaTrends('Codex', account, rows)[0]?.tokensPerPercent).toBe(50);
  });
  it('keeps providers, accounts, plans and window lengths separate even after sign-in changes', () => {
    const first = sample(0);
    const history = [first, { ...sample(1), provider: 'Claude' as const }, { ...sample(2), accountId: 'other' },
      { ...sample(3), plan: 'pro' }, { ...sample(4), label: 'Weekly' as const }];
    expect(quotaTrends('Codex', account, history)[0]?.observations).toEqual([first]);
    expect(quotaTrends('Codex', account, history)[1]?.observations).toHaveLength(1);
    expect(quotaTrends('Codex', undefined, history)[0]?.observations).toEqual([]);
  });
  it('records only fresh matched usage/quota across projects and never fabricates prior percentages', () => {
    const status: ProviderAccountStatus = { ...account, updatedAt: now, quota: { status: 'available', windows: [{ id: 'primary', label: '5h', usedPercent: 20, resetsAt: now + hour }] } };
    const data = { days: [], updatedAt: now, files: 2, unreadableFiles: 0, malformedLines: 0, undatedRecords: 0, duplicates: 0, oversizedLines: 0, timezone: 'UTC', recent: [
      { provider: 'Codex' as const, accountId, timestamp: now - hour, total: 100 },
      { provider: 'Codex' as const, accountId, timestamp: now - 2 * hour, total: 200 },
      { provider: 'Codex' as const, timestamp: now - hour, total: 9999 },
    ] };
    const samples = quotaObservations('Codex', status, data, now);
    expect(samples).toMatchObject([{ provider: 'Codex', accountId, plan: 'plus', label: '5h',
      from: now - 4 * hour, resetsAt: now + hour, to: now, observedTokens: 300, usedPercent: 20 },
      { source: 'Device', observedTokens: 10299, usedPercent: 20 }]);
    expect(quotaTrends('Codex', status, samples)[0]?.observations).toEqual([samples[0]]);
    expect(quotaObservations('Codex', { ...status, status: 'loading' }, data, now)).toEqual([]);
    expect(quotaObservations('Codex', status, { ...data, updatedAt: now - 3 * 60000 }, now)).toEqual([]);
  });
  it('compares reset capacities without treating partial recorded tokens as full-cycle usage', () => {
    const cycles = quotaCycles([sample(1, 1500, 30), sample(0, 1000, 25), { ...sample(0, 500, 10), accountId: 'other' },
      { ...sample(0, 3000, 20), source: 'API' }], now + 7 * hour);
    const local = cycles.filter(row => row.accountId === accountId && !row.source);
    expect(local).toMatchObject([{ capacityTokens: 4000, active: false, partial: true },
      { capacityTokens: 5000, active: true, partial: true, changePercent: 25 }]);
    expect(cycles.filter(row => row.accountId === 'other' || row.source === 'API').every(row => row.changePercent === undefined)).toBe(true);
    expect(quotaCycles([sample(0, 1000, 100)], now + 7 * hour)[0]?.partial).toBe(false);
  });
  it('persists Device estimates independently and prefers valid API samples within the latest cycle', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-quota-device-'));
    const device = { ...sample(1, 2000, 25), source: 'Device' as const };
    const rows = await new QuotaHistoryStore(directory).record([{ ...sample(0), source: 'API' }, device]);
    expect(await new QuotaHistoryStore(directory).record()).toEqual(rows);
    expect(quotaTrends('Codex', account, rows)[0]).toMatchObject({ source: 'Device', tokensPerPercent: 80, observations: [device] });
    const api = { ...device, source: 'API' as const, observedTokens: 3000 };
    expect(quotaTrends('Codex', account, [...rows, api])[0]).toMatchObject({ source: 'API', latestTokensPerPercent: 120 });
  });
  it('persists cycles across reloads and concurrent stores without losing or doubling samples', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-quota-history-'));
    const a = new QuotaHistoryStore(directory), b = new QuotaHistoryStore(directory);
    await Promise.all([a.record([sample(0)]), b.record([sample(1)])]);
    await a.record([sample(0)]);
    expect(await new QuotaHistoryStore(directory).record()).toEqual([sample(0), sample(1)]);
    const improved = { ...sample(0), to: sample(0).to + hour, observedTokens: 400, usedPercent: 20 };
    await b.record([improved]);
    expect(await a.record()).toEqual([improved, sample(1)]);
  });
  it('filters invalid persisted rows and only exposes meter fields', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-quota-history-'));
    await writeFile(path.join(directory, 'quota-history.json'), JSON.stringify({ version: 1, observations: [
      { ...sample(0), accessToken: 'secret' }, { ...sample(1), usedPercent: 0 }, { ...sample(2), observedTokens: -1 },
    ] }));
    expect(await new QuotaHistoryStore(directory).record()).toEqual([sample(0)]);
    const extra = { ...sample(3), accessToken: 'secret' };
    await new QuotaHistoryStore(directory).record([extra]);
    expect(await readFile(path.join(directory, 'quota-history.json'), 'utf8')).not.toContain('secret');
  });
  it('surfaces corrupt history without overwriting prior evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-quota-history-')), file = path.join(directory, 'quota-history.json');
    await writeFile(file, 'corrupt');
    await expect(new QuotaHistoryStore(directory).record([sample(0)])).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('corrupt');
  });
});
