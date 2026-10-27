import { describe, expect, it } from 'vitest';
import { observeQuotaCycleStarts } from '../src/core/quota-cycle-start';
import type { QuotaTick } from '../src/core/quota-pace';

const now = Date.parse('2026-10-27T10:00:00Z');
const tick = (minute: number, usedPercent: number, extra: Partial<QuotaTick> = {}): QuotaTick => ({
  provider: 'Codex', accountId: 'one', plan: 'plus', label: '7d', windowId: 'weekly', at: now + minute * 60000,
  resetsAt: now + 7 * 86400000, usedPercent, ...extra,
});

describe('Cycles from the last observed 100% quota', () => {
  it('starts at the last full reading and ignores changes in the forecast reset', () => {
    const starts = observeQuotaCycleStarts([], [tick(0, 0), tick(1, 0), tick(2, 20, { resetsAt: now + 8 * 86400000 }), tick(3, 30)]);
    expect(starts).toMatchObject([{ from: now + 60000, startUsedPercent: 0, usedPercent: 30, to: now + 180000 }]);
  });
  it('starts a new cycle only on another full reading, retaining the cycle through partial quota recovery', () => {
    const previous = observeQuotaCycleStarts([], [tick(0, 0), tick(1, 50)]);
    const recovered = observeQuotaCycleStarts(previous, [tick(2, 30)]);
    expect(recovered[0]?.from).toBe(now);
    expect(previous[0]?.usedPercent).toBe(50);
    const next = observeQuotaCycleStarts(recovered, [tick(3, 0), tick(4, 0), tick(5, 10)]);
    expect(next[0]).toMatchObject({ from: now + 240000, startUsedPercent: 0, usedPercent: 10 });
    expect(observeQuotaCycleStarts(next, [tick(1, 0)])).toEqual(next);
  });
  it('records an honest partial start when full quota was never observed', () => {
    const partial = observeQuotaCycleStarts([], [tick(0, 20), tick(1, 40)]);
    expect(partial[0]).toMatchObject({ from: now, startUsedPercent: 20, usedPercent: 40 });
    expect(observeQuotaCycleStarts(partial, [tick(2, 10)])[0]).toMatchObject({ from: now + 120000, startUsedPercent: 10 });
    expect(observeQuotaCycleStarts(partial, [tick(3, 0)])[0]).toMatchObject({ from: now + 180000, startUsedPercent: 0 });
  });
  it('isolates accounts, providers, plans and windows, excluding model-specific limits', () => {
    const starts = observeQuotaCycleStarts([], [tick(0, 0), tick(1, 0, { accountId: 'two' }), tick(2, 0, { provider: 'Claude' }),
      tick(3, 0, { plan: 'pro' }), tick(4, 0, { label: '5h', windowId: 'primary' }), tick(5, 0, { label: 'Opus · 7d', windowId: 'opus' })]);
    expect(starts).toHaveLength(5);
    expect(starts[0]?.from).toBe(now);
  });
});
