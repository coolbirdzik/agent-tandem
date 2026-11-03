import { describe, expect, it } from 'vitest';
import { quotaCycleRanges } from '../src/core/quota-cycle-ranges';
import type { QuotaTick } from '../src/core/quota-pace';
import type { QuotaObservation } from '../src/core/quota-estimate';

const hour = 3600000, now = Date.parse('2026-10-20T12:00:00Z'), account = '["Codex","ChatGPT","id","one"]';
const tick = (resetsAt: number, at: number, usedPercent: number, extra: Partial<QuotaTick> = {}): QuotaTick => ({ provider: 'Codex', accountId: account, plan: 'plus', windowId: '5h', label: '5h', resetsAt, at, usedPercent, ...extra });
const observation = (resetsAt: number, label: QuotaObservation['label'] = 'Weekly'): QuotaObservation => ({ provider: 'Codex', accountId: account, plan: 'plus', label, from: resetsAt - 86400000, resetsAt, to: resetsAt - hour, observedTokens: 100, usedPercent: 10 });

describe('Quota cycle ranges', () => {
  it('lists cycles newest first, from reset minus the window to the reset, with the current one marked', () => {
    const ranges = quotaCycleRanges('Codex', account, '5h', [tick(now - 4 * hour, now - 5 * hour, 30), tick(now + hour, now - hour, 10), tick(now + hour, now, 20)], [], now);
    expect(ranges.map(row => [row.from, row.to, row.current, row.usedPercent])).toEqual([[now - 4 * hour, now + hour, true, 20], [now - 9 * hour, now - 4 * hour, false, 30]]);
  });
  it('merges reset jitter into one cycle and uses the latest reading\'s reset', () => {
    const ranges = quotaCycleRanges('Codex', account, '5h', [tick(now + hour - 30000, now - 2 * hour, 5), tick(now + hour + 90000, now - hour, 8), tick(now + hour, now, 9)], [], now);
    expect(ranges).toHaveLength(1); expect(ranges[0]).toMatchObject({ resetsAt: now + hour, to: now + hour, usedPercent: 9 });
  });
  it('ends a cycle where an early reset starts the next one and keeps the provider reset time', () => {
    // A banked reset at now - 2h started a fresh 5h window before the previous one ran out.
    const ranges = quotaCycleRanges('Codex', account, '5h', [tick(now + hour, now - 3 * hour, 70), tick(now + 3 * hour, now, 4)], [], now);
    expect(ranges[1]).toMatchObject({ from: now - 4 * hour, to: now - 2 * hour, resetsAt: now + hour, current: false });
    expect(ranges[0]).toMatchObject({ from: now - 2 * hour, to: now + 3 * hour, current: true });
  });
  it('ignores unused windows, other accounts, other windows and future cycles', () => {
    const idle = [tick(now + 5 * hour, now, 0), tick(now + 5 * hour + 60000, now + 60000, 0)];
    const other = [tick(now + hour, now, 10, { accountId: 'other' }), tick(now + hour, now, 10, { provider: 'Claude' }), tick(now + hour, now, 10, { label: '7d', windowId: '7d' })];
    expect(quotaCycleRanges('Codex', account, '5h', [...idle, ...other, tick(now + 6 * hour, now, 10)], [], now)).toEqual([]);
  });
  it('adds cycles known only from saved quota history, matching weekly windows by label', () => {
    const resetsAt = now + 86400000 - 7 * 86400000;
    const ranges = quotaCycleRanges('Codex', account, 'Weekly', [tick(now + 86400000, now, 30, { label: '7d', windowId: '7d' })], [observation(resetsAt), observation(now - 3 * hour, '5h')], now);
    expect(ranges.map(row => row.resetsAt)).toEqual([now + 86400000, resetsAt]);
    expect(ranges[1]).toMatchObject({ from: resetsAt - 7 * 86400000, to: resetsAt, estimated: true }); expect(ranges[1]!.usedPercent).toBeUndefined();
    expect(ranges[0]!.estimated).toBe(false);
  });
});
