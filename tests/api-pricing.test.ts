import { describe, it, expect } from 'vitest';
import { apiCost, modelApiRate } from '../src/core/api-pricing';
import { emptyTotals, usageBreakdown, type UsageDay } from '../src/core/usage-dashboard';

const usage = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({ ...emptyTotals(), input, output, cacheRead, cacheWrite, reasoning: output, total: input + output, requests: 1 });
describe('API equivalent pricing', () => {
  it('prices cache-inclusive input once and does not add reasoning to output again', () => {
    const cost = apiCost('Codex', 'gpt-5.3-codex', usage(1e6, 1e5, 8e5));
    expect(cost).toMatchObject({ inputUsd: .35, cacheReadUsd: .14, outputUsd: 1.4, pricedTokens: 1.1e6, unpricedTokens: 0 });
    expect(cost.usd).toBeCloseTo(1.89);
  });
  it('separates Claude uncached input, cache reads, five-minute and one-hour writes', () => {
    const cost = apiCost('Claude', 'claude-sonnet-4-6', { ...usage(1e6, 1e5, 5e5, 3e5), cacheWrite1h: 1e5 });
    expect(cost).toMatchObject({ inputUsd: .6, cacheReadUsd: .15, cacheWriteUsd: 1.35, outputUsd: 1.5 });
    expect(cost.usd).toBeCloseTo(3.6);
    expect(apiCost('Claude', 'claude-opus-5-5', usage(1e6, 0, 1e6)).usd).toBe(.2);
  });
  it('applies prompt-length premiums per response, including cache tokens', () => {
    expect(apiCost('Codex', 'gpt-5.6-sol', usage(272000, 1000)).usd).toBeCloseTo(1.108);
    expect(apiCost('Codex', 'gpt-5.6-sol', usage(300000, 1000, 200000)).usd).toBeCloseTo(.99);
    expect(apiCost('Claude', 'claude-haiku-5-5', usage(100000, 1000)).usd).toBeCloseTo(.0105);
    expect(apiCost('Claude', 'claude-haiku-5-5', usage(100001, 1000)).usd).toBeCloseTo(.0525005);
  });
  it('accepts dated exact model IDs and leaves unknown models explicitly unpriced', () => {
    expect(modelApiRate('Claude', 'claude-sonnet-4-5-20250929')).toEqual(modelApiRate('Claude', 'claude-sonnet-4-5'));
    expect(modelApiRate('Codex', 'gpt-5-2025-08-07')).toEqual(modelApiRate('Codex', 'gpt-5'));
    for (const model of ['gpt-5.3-codex-spark', 'gpt-6-new', 'constructor', 'Unknown model']) {
      expect(apiCost('Codex', model, usage(100, 20))).toMatchObject({ usd: 0, pricedTokens: 0, unpricedTokens: 120 });
    }
  });
  it('keeps provider/model/period/filter costs consistent without repricing daily aggregates', () => {
    const days: UsageDay[] = [
      { ...usage(200000), day: '2026-10-01', provider: 'Codex', model: 'gpt-5.6-sol', cost: apiCost('Codex', 'gpt-5.6-sol', usage(200000)) },
      { ...usage(200000), day: '2026-10-02', provider: 'Codex', model: 'gpt-5.6-sol', cost: apiCost('Codex', 'gpt-5.6-sol', usage(200000)) },
      { ...usage(100000), day: '2026-10-02', provider: 'Claude', model: 'unknown' },
    ];
    for (const grouping of ['day', 'week', 'month'] as const) {
      const result = usageBreakdown(days, { grouping });
      expect(result.cost).toMatchObject({ usd: 1.6, pricedTokens: 400000, unpricedTokens: 100000 });
      expect(result.periods.reduce((sum, row) => sum + row.cost.usd, 0)).toBeCloseTo(1.6);
      expect(result.models.reduce((sum, row) => sum + row.cost.usd, 0)).toBeCloseTo(1.6);
      expect(result.providers.reduce((sum, row) => sum + row.cost.unpricedTokens, 0)).toBe(100000);
    }
    expect(usageBreakdown(days, { grouping: 'day', provider: 'Codex', from: '2026-10-02' }).cost.usd).toBe(.8);
    expect(usageBreakdown(days, { grouping: 'day', model: 'unknown' }).cost).toMatchObject({ usd: 0, unpricedTokens: 100000 });
  });
});
