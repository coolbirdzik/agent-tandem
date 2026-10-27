import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mergeQuotaObservations, quotaCycles, quotaTrends, quotaObservations, quotaMeters, observeQuotaMeters, type QuotaObservation } from '../src/core/quota-estimate';
import { QuotaHistoryStore } from '../src/core/quota-history-store';
import { usageAccount } from '../src/core/usage-account';
import type { ProviderAccountStatus } from '../src/providers/account-status';
import { quotaTicks } from '../src/core/quota-pace';
import type { UsageHistoryData } from '../src/core/usage-dashboard';

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
    expect(rows).toMatchObject([{ source: 'API', label: 'Weekly', observedTokens: 200000, usedPercent: 2, startUsedPercent: 16, from: now }]);
    expect(await new QuotaHistoryStore(directory).read()).toEqual(rows);
    expect(quotaCycles(rows, time)[0]).toMatchObject({ remainingFrom: 84, remainingTo: 82, tokensPerPercent: 100000 });
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
  it('deduplicates reset jitter using the newest snapshot rather than summing cumulative tokens', async () => {
    const first = sample(0), updated = { ...first, resetsAt: first.resetsAt - 1000, to: first.to + hour, observedTokens: 1000, usedPercent: 20 };
    expect(mergeQuotaObservations([first], [updated, first])).toEqual([updated]);
    expect(mergeQuotaObservations([updated], [first])).toEqual([updated]);
    for (const changed of [{ accountId: 'other' }, { plan: 'pro' }, { label: 'Weekly' as const }, { source: 'API' as const }, { provider: 'Claude' as const }, { resetsAt: first.resetsAt + 120001 }]) {
      expect(mergeQuotaObservations([first], [{ ...updated, ...changed }])).toHaveLength(2);
    }
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-quota-jitter-'));
    await writeFile(path.join(directory, 'quota-history.json'), JSON.stringify({ version: 1, observations: [first, updated] }));
    expect(await new QuotaHistoryStore(directory).record()).toEqual([updated]);
    expect(await new QuotaHistoryStore(directory).read()).toEqual([updated]);
  });
  it('retains the API baseline across reset jitter and subsequent reloads', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-quota-api-jitter-'));
    const first = quotaMeters('Codex', apiStatus(now, 10000000, 16), now)[0]!;
    await new QuotaHistoryStore(directory).record([], [first]);
    const next = { ...first, resetsAt: first.resetsAt + 1000, to: now + 60000, totalTokens: 10200000, usedPercent: 18 };
    const rows = await new QuotaHistoryStore(directory).record([], [next]);
    expect(rows).toMatchObject([{ from: now, to: next.to, observedTokens: 200000, usedPercent: 2 }]);
    const reopened = new QuotaHistoryStore(directory); await reopened.read();
    expect(reopened.baselines).toEqual([{ start: first, latest: next }]);
    const final = { ...next, resetsAt: first.resetsAt - 1000, to: now + 120000, totalTokens: 10600000, usedPercent: 20 };
    expect(await reopened.record([], [final])).toMatchObject([{ from: now, to: final.to, observedTokens: 600000, usedPercent: 4 }]);
  });
  it('marks only the most recently observed cycle current, even when older reset estimates remain in the future', () => {
    const time = Date.parse('2026-10-27T23:30:00+07:00');
    const earlier = { ...sample(0), label: 'Weekly' as const, from: Date.parse('2026-10-25T16:45:25+07:00'),
      to: Date.parse('2026-10-26T11:57:31+07:00'), resetsAt: Date.parse('2026-11-01T16:45:25+07:00'), observedTokens: 41907611, usedPercent: 17 };
    const first = { ...earlier, from: Date.parse('2026-10-26T13:13:13+07:00'), to: Date.parse('2026-10-27T22:34:15+07:00'),
      resetsAt: Date.parse('2026-11-02T13:13:13+07:00'), observedTokens: 194911940, usedPercent: 35 };
    const latest = { ...first, from: first.from - 1000, resetsAt: first.resetsAt - 1000, to: Date.parse('2026-10-27T23:09:15+07:00'), observedTokens: 222856032, usedPercent: 39 };
    const cycles = quotaCycles([first, latest, earlier], time);
    expect(cycles).toHaveLength(2);
    expect(cycles.map(row => row.active)).toEqual([false, true]);
    expect(cycles[1]?.observedTokens).toBe(222856032);
    expect(cycles[1]?.changePercent).toBeCloseTo(131.8, 1);
    expect(quotaCycles([first, latest, earlier], time, latest.resetsAt + 86400000).some(row => row.active)).toBe(false);
    expect(quotaCycles([earlier, latest], latest.resetsAt).some(row => row.active)).toBe(false);
    // A corrected reset may move earlier; the most recent reading still identifies the current cycle.
    const corrected = { ...latest, resetsAt: latest.resetsAt - 86400000 };
    const correctedCycles = quotaCycles([first, corrected], time);
    expect(correctedCycles.map(row => row.active)).toEqual([false, true]);
    const trend = quotaTrends('Codex', account, [{ ...first, source: 'API' }, corrected])[1]!;
    expect(trend.source).toBe('Local');
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
  it('distinguishes observations starting at full quota, partial API intervals and legacy unknown endpoints', () => {
    const base = { ...sample(0, 200000, 2), source: 'API' as const };
    expect(quotaCycles([{ ...base, startUsedPercent: 0 }])[0]).toMatchObject({ remainingFrom: 100, remainingTo: 98, tokensPerPercent: 100000 });
    expect(quotaCycles([{ ...base, startUsedPercent: 16 }])[0]).toMatchObject({ remainingFrom: 84, remainingTo: 82, tokensPerPercent: 100000 });
    expect(quotaCycles([base])[0]?.remainingFrom).toBeUndefined();
    expect(quotaCycles([sample(0, 1000, 25)])[0]?.remainingFrom).toBeUndefined();
    expect(mergeQuotaObservations([base], [{ ...base, startUsedPercent: 16 }])[0]?.startUsedPercent).toBe(16);
    expect(mergeQuotaObservations([{ ...base, startUsedPercent: 16 }], [base])[0]?.startUsedPercent).toBe(16);
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
      { ...sample(4), startUsedPercent: -1 }, { ...sample(5), startUsedPercent: 95 }, { ...sample(6), startUsedPercent: '0' },
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
  it('counts local tokens from the last actual 100% reading, keeping the start across reloads and reset changes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-quota-full-local-'));
    const recent = [{ provider: 'Codex' as const, accountId, timestamp: now - 1, total: 9000 },
      { provider: 'Codex' as const, accountId, timestamp: now + 60000, total: 8000 },
      { provider: 'Codex' as const, accountId, timestamp: now + 90000, total: 100 },
      { provider: 'Codex' as const, accountId, timestamp: now + 120000, total: 200 }];
    const capture = async (time: number, used: number, reset: number) => {
      const store = new QuotaHistoryStore(directory), status = { ...apiStatus(time, 0, used), usage: undefined };
      status.quota!.windows[0]!.resetsAt = reset;
      const data: UsageHistoryData = { days: [], recent, updatedAt: time, files: 1, unreadableFiles: 0, malformedLines: 0, undatedRecords: 0, duplicates: 0, oversizedLines: 0, timezone: 'UTC' };
      return store.capture(quotaTicks('Codex', status, time), starts => ({ observations: quotaObservations('Codex', status, data, time, starts) }));
    };
    expect(await capture(now, 0, now + 3 * 86400000)).toEqual([]);
    expect(await capture(now + 60000, 0, now + 4 * 86400000)).toEqual([]);
    const rows = await capture(now + 120000, 20, now + 5 * 86400000);
    expect(rows).toMatchObject([{ from: now + 60000, cycleStartedAt: now + 60000, cycleStartKnown: true, startUsedPercent: 0, usedPercent: 20, observedTokens: 300 }]);
    const updated = await capture(now + 180000, 30, now + 6 * 86400000);
    expect(updated).toHaveLength(1); expect(updated[0]?.observedTokens).toBe(300);
    const reopened = new QuotaHistoryStore(directory); await reopened.read();
    expect(reopened.cycleStarts[0]?.from).toBe(now + 60000);
  });
  it('captures API cycles from full quota through changing forecasts and closes them on the next full reading', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-quota-full-api-'));
    const capture = async (minute: number, total: number, used: number) => {
      const time = now + minute * 60000, status = apiStatus(time, total, used), store = new QuotaHistoryStore(directory);
      status.quota!.windows[0]!.resetsAt = now + (3 + minute) * 86400000;
      const rows = await store.capture(quotaTicks('Codex', status, time), starts => ({ meters: quotaMeters('Codex', status, time, starts) }));
      return { store, rows };
    };
    await capture(0, 1000, 0); await capture(1, 1000, 0);
    const first = await capture(2, 1300, 20);
    expect(first.rows).toMatchObject([{ cycleStartedAt: now + 60000, cycleStartKnown: true, from: now + 60000, observedTokens: 300, usedPercent: 20 }]);
    const recovered = await capture(3, 1400, 15);
    expect(recovered.rows).toHaveLength(1); expect(recovered.rows[0]).toMatchObject({ observedTokens: 400, usedPercent: 15 });
    const reset = await capture(4, 1500, 0);
    expect(quotaCycles(reset.rows, now + 240000, undefined, reset.store.cycleStarts[0]!.from).some(row => row.active)).toBe(false);
    const next = await capture(5, 1700, 10);
    expect(next.rows).toHaveLength(2);
    expect(next.rows[1]).toMatchObject({ cycleStartedAt: now + 240000, observedTokens: 200, usedPercent: 10 });
    const cycles = quotaCycles(next.rows, now + 300000, undefined, next.store.cycleStarts[0]!.from);
    expect(cycles.map(row => row.active)).toEqual([false, true]);
    expect(quotaTrends('Codex', account, [...next.rows, { ...sample(0, 999999), source: 'API' }])[1]?.observations).toHaveLength(2);
    const idle = apiStatus(now, 1000, 0);
    idle.quota!.windows = [{ id: 'primary', label: '5h', usedPercent: 0, resetsAt: now + 5 * hour }];
    expect(quotaMeters('Codex', idle, now)).toHaveLength(1);
  });
  it('counts only the observed partial interval when the first sample is below 100%', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-quota-partial-'));
    const store = new QuotaHistoryStore(directory), status = { ...apiStatus(now, 0, 30), usage: undefined };
    await store.capture(quotaTicks('Codex', status, now), () => ({}));
    const later = { ...status, updatedAt: now + 60000, quota: { ...status.quota!, windows: [{ ...status.quota!.windows[0]!, usedPercent: 40 }] } };
    const data: UsageHistoryData = { days: [], updatedAt: now + 60000, files: 1, unreadableFiles: 0, malformedLines: 0, undatedRecords: 0, duplicates: 0, oversizedLines: 0, timezone: 'UTC',
      recent: [{ provider: 'Codex', accountId, timestamp: now - 60000, total: 9000 }, { provider: 'Codex', accountId, timestamp: now + 30000, total: 500 }] };
    const rows = await store.capture(quotaTicks('Codex', later, now + 60000), starts => ({ observations: quotaObservations('Codex', later, data, now + 60000, starts) }));
    expect(rows).toMatchObject([{ cycleStartedAt: now, cycleStartKnown: false, observedTokens: 500, usedPercent: 10, startUsedPercent: 30 }]);
    expect(quotaCycles(rows, now + 60000)[0]).toMatchObject({ remainingFrom: 70, remainingTo: 60, partial: true });
  });
});
