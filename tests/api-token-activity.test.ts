import { describe, it, expect } from 'vitest';
import { apiActivityBreakdown, codexTokenActivity } from '../src/core/api-token-activity';
import { usageAccount } from '../src/core/usage-account';
import type { ProviderAccountStatus } from '../src/providers/account-status';

const identity = { signedIn: true, id: 'workspace-one', email: 'one@test.invalid', method: 'ChatGPT' }, accountId = usageAccount('Codex', identity)!.id;
const raw = { summary: { lifetimeTokens: 1000, peakDailyTokens: 600, currentStreakDays: 0 }, dailyUsageBuckets: [{ startDate: '2026-10-08', tokens: 100 }, { startDate: '2026-10-09', tokens: 200 }, { startDate: '2026-10-09', tokens: 200 }, { startDate: '2026-10-10', tokens: 0 }] };
describe('Account API token activity', () => {
  it('whitelists reported numbers and keeps null metrics distinct from zero', () => {
    const result = codexTokenActivity({ ...raw, accessToken: 'secret', summary: { ...raw.summary, longestStreakDays: null, longestRunningTurnSec: Number.MAX_SAFE_INTEGER + 1 } }, accountId, 1);
    expect(result.summary).toEqual({ lifetimeTokens: 1000, peakDailyTokens: 600, currentStreakDays: 0 });
    expect(result.daily).toHaveLength(3); expect(JSON.stringify(result)).not.toContain('secret');
    expect(codexTokenActivity({ summary: { lifetimeTokens: null }, dailyUsageBuckets: null }).status).toBe('unavailable');
    expect(codexTokenActivity({ summary: { lifetimeTokens: 0 }, dailyUsageBuckets: null }).summary?.lifetimeTokens).toBe(0);
  });
  it('does not expose partial/conflicting daily totals or fabricate missing days', () => {
    for (const row of [{ startDate: '2026-02-30', tokens: 2 }, { startDate: '9999-99-99', tokens: 2 }, { startDate: '2026-10-11', tokens: -2 }, { startDate: '2026-10-09', tokens: 999 }]) {
      expect(codexTokenActivity({ ...raw, dailyUsageBuckets: [...raw.dailyUsageBuckets, row] }).daily).toBeUndefined();
    }
    const status: ProviderAccountStatus = { status: 'ready', account: identity, usage: codexTokenActivity(raw, accountId) };
    expect(apiActivityBreakdown(status, { grouping: 'day', from: '2026-10-10', to: '2026-10-10' }).total).toBe(0);
    expect(apiActivityBreakdown(status, { grouping: 'day', from: '2026-10-11', to: '2026-10-11' }).total).toBeUndefined();
  });
  it('groups API dates independently of Local model counts and matches the selected native account', () => {
    const status: ProviderAccountStatus = { status: 'ready', account: identity, usage: codexTokenActivity(raw, accountId) };
    const result = apiActivityBreakdown(status, { grouping: 'week', from: '2026-10-09', to: '2026-10-10', accountId, model: 'local-model' });
    expect(result.total).toBe(200); expect(result.periods).toEqual([{ key: '2026-10-05', tokens: 200, days: 2 }]);
    expect(result.usage?.summary?.lifetimeTokens).toBe(1000);
    expect(apiActivityBreakdown(status, { grouping: 'day', accountId: 'another' }).total).toBeUndefined();
    expect(apiActivityBreakdown(status, { grouping: 'day', provider: 'Claude' }).total).toBeUndefined();
    expect(apiActivityBreakdown({ ...status, account: { ...identity, id: 'workspace-two' } }, { grouping: 'day' }).total).toBeUndefined();
    expect(usageAccount('Codex', { ...identity, email: 'renamed@test.invalid' })?.id).toBe(accountId);
  });
});
