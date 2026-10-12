import { describe, it, expect } from 'vitest';
import { quotaEstimates } from '../src/core/quota-estimate';
import type { ProviderAccountStatus } from '../src/providers/account-status';
import type { UsageHistoryData } from '../src/core/usage-dashboard';
import { usageAccount } from '../src/core/usage-account';

const now = Date.parse('2026-10-10T08:00:00Z'), hour = 3600000, day = 24 * hour;
const identity = { signedIn: true, email: 'one@example.test', method: 'ChatGPT' };
const codexId = usageAccount('Codex', identity)!.id;
const claudeIdentity = { ...identity, method: 'Claude account', organization: 'org-one' };
const claudeId = usageAccount('Claude', claudeIdentity)!.id;
const account: ProviderAccountStatus = { status: 'ready', account: identity, updatedAt: now, quota: { status: 'available', windows: [
  { id: 'primary', label: '5h', usedPercent: 25, resetsAt: now + hour },
  { id: 'secondary', label: '7d', usedPercent: 50, resetsAt: now + 3 * day },
  { id: 'opus', label: 'Opus · 7d', usedPercent: 99, resetsAt: now + 3 * day },
] } };
const data: UsageHistoryData = { days: [], updatedAt: now, files: 1, unreadableFiles: 0, malformedLines: 0, oversizedLines: 0, undatedRecords: 0, duplicates: 0, timezone: 'UTC', recent: [
  { provider: 'Codex', accountId: codexId, timestamp: now - 4 * day - 1, total: 9e6 },
  { provider: 'Codex', accountId: codexId, timestamp: now - 4 * day, total: 1e6 },
  { provider: 'Codex', accountId: codexId, timestamp: now - 4 * hour - 1, total: 2e6 },
  { provider: 'Codex', accountId: codexId, timestamp: now - 4 * hour, total: 1e6 },
  { provider: 'Codex', accountId: codexId, timestamp: now + 1, total: 9e6 },
  { provider: 'Claude', accountId: claudeId, timestamp: now - hour, total: 5e6 },
] };
describe('Observed tokens per quota percentage point', () => {
  it('matches the current account exactly and never mixes another login or unknown history', () => {
    const other = usageAccount('Codex', { ...identity, email: 'two@example.test' })!;
    const mixed = { ...data, recent: [...data.recent!,
      { provider: 'Codex' as const, accountId: other.id, timestamp: now - hour, total: 9e6 },
      { provider: 'Codex' as const, timestamp: now - hour, total: 99e6 },
    ] };
    expect(quotaEstimates('Codex', account, mixed, now)[0]?.tokensPerPercent).toBe(40000);
    expect(quotaEstimates('Codex', { ...account, account: { ...identity, email: other.email } }, mixed, now)[0]?.tokensPerPercent).toBe(360000);
    expect(quotaEstimates('Codex', { ...account, account: undefined }, mixed, now)[0]?.reason).toBe('Account identity unavailable');
    expect(quotaEstimates('Codex', account, { ...mixed, recent: mixed.recent.filter(row => row.accountId !== codexId) }, now)[0]?.tokensPerPercent).toBeUndefined();
  });
  it('separates Claude organizations even when they share an email', () => {
    const anotherOrg = usageAccount('Claude', { ...claudeIdentity, organization: 'org-two' })!;
    const mixed = { ...data, recent: [...data.recent!, { provider: 'Claude' as const, accountId: anotherOrg.id, timestamp: now - hour, total: 99e6 }] };
    expect(quotaEstimates('Claude', { ...account, account: claudeIdentity }, mixed, now)[0]?.tokensPerPercent).toBe(200000);
  });
  it('anchors both windows to native resets, isolates providers and excludes future records', () => {
    const [five, weekly] = quotaEstimates('Codex', account, data, now);
    expect(five).toMatchObject({ label: '5h', observedTokens: 1e6, tokensPerPercent: 40000, capacityTokens: 4e6, remainingTokens: 3e6, from: now - 4 * hour, to: now });
    expect(weekly).toMatchObject({ label: 'Weekly', observedTokens: 4e6, tokensPerPercent: 80000, capacityTokens: 8e6, remainingTokens: 4e6, from: now - 4 * day });
    expect(quotaEstimates('Claude', { ...account, account: claudeIdentity }, data, now)[0]?.tokensPerPercent).toBe(200000);
  });
  it('uses the matched usage/quota snapshot and never reads tokens after that snapshot', () => {
    const earlier = { ...account, updatedAt: now - 1000 };
    const withNew = { ...data, recent: [...data.recent!, { provider: 'Codex' as const, timestamp: now, total: 9e6 }] };
    expect(quotaEstimates('Codex', earlier, withNew, now)[0]?.observedTokens).toBe(1e6);
  });
  it('does not invent estimates for missing/stale quota, unmatched history or zero usage', () => {
    const windows = account.quota!.windows;
    const cases = [undefined, { ...account, updatedAt: now - 6 * 60000 },
      { ...account, quota: { ...account.quota!, windows: [{ ...windows[0]!, resetsAt: now }] } },
      { ...account, quota: { ...account.quota!, windows: [{ ...windows[0]!, usedPercent: 0 }] } },
      { ...account, quota: { ...account.quota!, windows: [{ ...windows[0]!, usedPercent: NaN }] } },
      { ...account, quota: { ...account.quota!, windows: [windows[2]!] } },
    ];
    for (const value of cases) {
      const estimate = quotaEstimates('Codex', value, data, now)[0];
      expect(estimate?.reason).toEqual(expect.any(String)); expect(estimate?.tokensPerPercent).toBeUndefined();
    }
    for (const value of [undefined, { ...data, recent: undefined }, { ...data, updatedAt: now - 3 * 60000 }, { ...data, recent: [] }]) {
      expect(quotaEstimates('Codex', account, value, now)[0]?.tokensPerPercent).toBeUndefined();
    }
  });
  it('shows zero estimated tokens remaining when the native quota is fully used', () => {
    const full = { ...account, quota: { ...account.quota!, windows: [{ ...account.quota!.windows[0]!, usedPercent: 100 }] } };
    expect(quotaEstimates('Codex', full, data, now)[0]).toMatchObject({ tokensPerPercent: 10000, capacityTokens: 1e6, remainingTokens: 0 });
  });
});
