import { describe, expect, it } from 'vitest';
import { dashboardAccountGroups, emptyTotals, modelColorSlots, periodKey, usageBreakdown, type UsageDay } from '../src/core/usage-dashboard';
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
  it('groups exact account identities and unknown providers without adding live quota to local totals', () => {
    const identity = { signedIn: true, email: 'one@test', method: 'ChatGPT' }, account = usageAccount('Codex', identity)!;
    const rows = [{ ...row('2026-10-13', 'Codex', 'model', 100), account }, row('2026-10-13', 'Codex', 'model', 200), row('2026-10-13', 'Claude', 'model', 300)];
    const groups = dashboardAccountGroups(rows, { grouping: 'day' }, [
      { provider: 'Codex', status: { status: 'ready', account: identity }, active: true },
      { provider: 'Codex', status: { status: 'ready', account: { ...identity, email: 'two@test' } }, label: 'Work' },
    ]);
    expect(groups).toHaveLength(4); expect(groups.reduce((sum, row) => sum + row.totals.total, 0)).toBe(600);
    expect(groups.filter(row => !row.account)).toHaveLength(2);
    expect(groups.find(row => row.label === 'Work')?.totals.total).toBe(0);
    expect(dashboardAccountGroups(rows, { grouping: 'day', accountId: account.id }).map(row => row.totals.total)).toEqual([100]);
  });
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
    expect(value.text).toBe('$(terminal) Codex · 5h 75%'); expect(value.tooltip).toContain('codex@test.invalid'); expect(value.tooltip).toContain('usage dashboard');
    expect(quotaStatus({ conversation: { conversation: { provider: 'Claude' } } as any, accounts }).text).toBe('$(sparkle) Claude Code · 5h 0%');
    expect(quotaStatus({ composeProvider: 'Claude', accounts: { Claude: { status: 'loading' } } }).text).toContain('Claude Code · …');
    expect(quotaStatus({}).text).toContain('Quota —');
  });
});
describe('Daily model breakdown', () => {
  const day = (date: string, provider: 'Codex' | 'Claude', model: string, total: number): UsageDay => ({ ...emptyTotals(), day: date, provider, model, input: total, total, requests: 1 });
  it('groups each period by provider model, largest first, without changing period totals', () => {
    const result = usageBreakdown([day('2026-10-14', 'Claude', 'opus', 100), day('2026-10-14', 'Claude', 'opus', 50), day('2026-10-14', 'Codex', 'gpt', 300), day('2026-10-15', 'Claude', 'opus', 10)], { grouping: 'day' });
    expect(result.periods[0]!.models.map(row => [row.provider, row.model, row.totals.total])).toEqual([['Codex', 'gpt', 300], ['Claude', 'opus', 150]]);
    expect(result.periods[0]!.models.reduce((sum, row) => sum + row.totals.total, 0)).toBe(result.periods[0]!.totals.total);
    expect(result.periods[1]!.models).toHaveLength(1);
  });
  it('keeps model colors stable across filters and folds models beyond the palette into Other', () => {
    const days = Array.from({ length: 10 }, (_, index) => day('2026-10-14', 'Claude', `model-${index}`, 1000 - index));
    const slots = modelColorSlots(days);
    expect(slots.get('Claude\0model-0')).toBe(0); expect(slots.get('Claude\0model-6')).toBe(6);
    expect(slots.get('Claude\0model-7')).toBe(-1); expect(slots.get('Claude\0model-9')).toBe(-1);
    expect(modelColorSlots(days.slice(0, 8)).get('Claude\0model-7')).toBe(7);
    expect(modelColorSlots([day('2026-10-14', 'Codex', 'same', 1), day('2026-10-14', 'Claude', 'same', 2)]).size).toBe(2);
  });
});
