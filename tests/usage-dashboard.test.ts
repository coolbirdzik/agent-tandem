import { describe, expect, it } from 'vitest';
import { emptyTotals, periodKey, usageBreakdown, type UsageDay } from '../src/core/usage-dashboard';
import { quotaStatus } from '../src/core/quota-status';
import { usageAccount, UNKNOWN_ACCOUNT } from '../src/core/usage-account';
import { apiCost } from '../src/core/api-pricing';
it('uses the lowest remaining quota window for status colors and resets color when switching providers', () => {
  const quota = (usedPercent: number) => ({ status: 'ready' as const, quota: { status: 'available' as const, windows: [{ id: '5h', label: '5h', usedPercent: 5 }, { id: '7d', label: '7d', usedPercent }] } });
  const accounts = { Codex: quota(25), Claude: quota(95) };
  expect(quotaStatus({ composeProvider: 'Codex', accounts }).tone).toBe('healthy');
  expect(quotaStatus({ composeProvider: 'Claude', accounts }).tone).toBe('warning');
  expect(quotaStatus({ composeProvider: 'Claude', accounts: { Claude: quota(100) } }).tone).toBe('exhausted');
  expect(quotaStatus({ composeProvider: 'Codex', accounts: { Codex: { status: 'loading' } } }).tone).toBe('loading');
  expect(quotaStatus({ composeProvider: 'Claude' }).tone).toBe('unavailable');
});
const row = (day: string, provider: 'Codex' | 'Claude', model: string, total: number): UsageDay => ({ ...emptyTotals(), day, provider, model, input: total - 10, output: 10, total, requests: 1 });
describe('Dashboard grouping and quota presentation', () => {
  it('filters tokens, requests, costs and calendar breakdowns by account together with provider/model/date', () => {
    const one = usageAccount('Codex', { signedIn: true, email: 'one@test.invalid', method: 'ChatGPT' })!;
    const two = usageAccount('Codex', { signedIn: true, email: 'two@test.invalid', method: 'ChatGPT' })!;
    const days = [
      { ...row('2026-10-09', 'Codex', 'gpt-5.3-codex', 100), account: one },
      { ...row('2026-10-09', 'Codex', 'gpt-5.3-codex', 200), account: two },
      { ...row('2026-10-08', 'Codex', 'gpt-5.3-codex', 400), account: one },
      row('2026-10-09', 'Claude', 'claude-sonnet-4-6', 300),
    ].map(row => ({ ...row, cost: apiCost(row.provider, row.model, row) }));
    for (const grouping of ['day', 'week', 'month'] as const) {
      const result = usageBreakdown(days, { grouping, accountId: one.id, provider: 'Codex', model: 'gpt-5.3-codex', from: '2026-10-09', to: '2026-10-09' });
      expect(result.totals.total).toBe(100); expect(result.totals.requests).toBe(1);
      expect(result.accounts).toHaveLength(1); expect(result.accounts[0]?.account?.id).toBe(one.id);
      expect(result.cost.usd).toBeCloseTo(days[0]!.cost.usd);
      expect(result.periods[0]?.totals.total).toBe(100); expect(result.models[0]?.totals.total).toBe(100);
    }
    expect(usageBreakdown(days, { grouping: 'day', accountId: UNKNOWN_ACCOUNT }).totals.total).toBe(300);
    expect(usageBreakdown(days, { grouping: 'day' }).accounts).toHaveLength(3);
  });
  it('uses Monday calendar weeks across month/year boundaries', () => {
    expect(periodKey('2026-01-01', 'week')).toBe('2025-12-29');
    expect(periodKey('2026-10-11', 'week')).toBe('2026-10-05');
    expect(periodKey('2026-10-12', 'week')).toBe('2026-10-12');
    expect(periodKey('2026-10-12', 'month')).toBe('2026-10');
  });
  it('preserves totals through day/week/month regrouping and applies provider/model/date filters together', () => {
    const days = [row('2026-09-30', 'Codex', 'a', 100), row('2026-10-01', 'Claude', 'b', 200), row('2026-10-09', 'Codex', 'a', 300), row('2026-10-09', 'Codex', 'c', 400)];
    for (const grouping of ['day', 'week', 'month'] as const) {
      const value = usageBreakdown(days, { grouping }); expect(value.totals.total).toBe(1000);
      expect(value.periods.reduce((sum, row) => sum + row.totals.total, 0)).toBe(1000);
      expect(value.models[0]).toMatchObject({ model: 'a', totals: { total: 400 } });
    }
    expect(usageBreakdown(days, { grouping: 'month', provider: 'Codex', model: 'a', from: '2026-10-01', to: '2026-10-31' }).totals.total).toBe(300);
    expect(usageBreakdown([], { grouping: 'day' }).totals).toEqual(emptyTotals());
  });
  it('shows only the active provider with remaining quota and an account/dashboard tooltip', () => {
    const accounts = { Codex: { status: 'ready' as const, account: { signedIn: true, email: 'codex@test.invalid', method: 'ChatGPT' }, quota: { status: 'available' as const, windows: [{ id: '5h', label: '5h', usedPercent: 25 }] } },
      Claude: { status: 'ready' as const, quota: { status: 'available' as const, windows: [{ id: '5h', label: '5h', usedPercent: 100 }] } } };
    const value = quotaStatus({ composeProvider: 'Codex', accounts });
    expect(value.text).toBe('$(dashboard) Codex · 5h 75%'); expect(value.tooltip).toContain('codex@test.invalid'); expect(value.tooltip).toContain('usage dashboard');
    expect(quotaStatus({ conversation: { conversation: { provider: 'Claude' } } as any, accounts }).text).toBe('$(dashboard) Claude · 5h 0%');
    expect(quotaStatus({ composeProvider: 'Claude', accounts: { Claude: { status: 'loading' } } }).text).toContain('Claude · …');
    expect(quotaStatus({}).text).toContain('Quota —');
  });
});
