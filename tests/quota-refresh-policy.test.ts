import { describe, it, expect, vi } from 'vitest';
import { QuotaRefreshPolicy, quotaRetryAfter } from '../src/core/quota-refresh-policy';

describe('Quota request pacing', () => {
  it('uses ten-minute automatic and one-minute manual cooldowns, independently per account', () => {
    const policy = new QuotaRefreshPolicy(), now = 1_000_000;
    policy.complete('one', false, undefined, now);
    expect(policy.due('one', true, undefined, now + 599999)).toBe(false);
    expect(policy.due('one', true, undefined, now + 600000)).toBe(true);
    expect(policy.due('one', false, undefined, now + 59999)).toBe(false);
    expect(policy.due('one', false, undefined, now + 60000)).toBe(true);
    expect(policy.due('two', true, undefined, now)).toBe(true);
  });
  it('backs off consecutive failures, respects longer server deadlines and recovers on success', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0), policy = new QuotaRefreshPolicy();
    try {
      policy.complete('one', true, undefined, 1000000);
      expect(policy.due('one', false, undefined, 1599999)).toBe(false);
      policy.complete('one', true, undefined, 1600000);
      expect(policy.due('one', false, undefined, 2799999)).toBe(false);
      expect(policy.due('one', true, undefined, 2800000)).toBe(true);
      policy.complete('one', true, 20_000_000, 2800000);
      expect(policy.due('one', false, undefined, 19_999_999)).toBe(false);
      policy.complete('one', false, undefined, 20_000_000);
      expect(policy.due('one', true, undefined, 20_600_000)).toBe(true);
    } finally { random.mockRestore(); }
  });
  it('parses Retry-After seconds and HTTP dates without retaining error payloads', () => {
    const now = Date.UTC(2026, 9, 30);
    expect(quotaRetryAfter({ headers: { 'retry-after': '1200' } }, now)).toBe(now + 1200000);
    expect(quotaRetryAfter({ headers: new Headers({ 'Retry-After': new Date(now + 3600000).toUTCString() }) }, now)).toBe(now + 3600000);
    for (const value of ['', '-1', 'invalid', 'Infinity']) expect(quotaRetryAfter({ headers: { 'retry-after': value } }, now)).toBeUndefined();
  });
});
