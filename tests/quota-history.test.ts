import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mergeQuotaObservations, quotaTrends, quotaObservations, type QuotaObservation } from '../src/core/quota-estimate';
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
    expect(quotaObservations('Codex', status, data, now)).toEqual([{ provider: 'Codex', accountId, plan: 'plus', label: '5h',
      from: now - 4 * hour, resetsAt: now + hour, to: now, observedTokens: 300, usedPercent: 20 }]);
    expect(quotaObservations('Codex', { ...status, status: 'loading' }, data, now)).toEqual([]);
    expect(quotaObservations('Codex', status, { ...data, updatedAt: now - 3 * 60000 }, now)).toEqual([]);
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
