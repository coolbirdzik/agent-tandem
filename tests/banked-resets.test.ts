import { expect, it } from 'vitest';
import { bankedResetCountdown, bankedResetDetails } from '../src/core/banked-resets';
import { quotaStatus } from '../src/core/quota-status';

it('shows the authoritative count and expiry dates in the status text and hover tooltip', () => {
  const expiresAt = Date.parse('2026-11-01T00:00:00Z');
  const status = quotaStatus({ composeProvider: 'Codex', accounts: { Codex: { status: 'ready', quota: { status: 'available', windows: [],
    bankedResets: { availableCount: 3, credits: [{ title: 'Full reset', expiresAt }, {}] } } } } });
  expect(status.text).toContain('3 banked resets');
  expect(status.tooltip).toContain('Banked resets: 3 available');
  expect(status.tooltip).toContain(`Full reset · Expires ${new Date(expiresAt).toLocaleString()}`);
  expect(status.tooltip).toContain('Expiry unavailable');
  expect(status.tooltip).toContain('Expiry details shown for some resets');
});

it('distinguishes zero, count-only and unknown reset data', () => {
  expect(bankedResetDetails(undefined)).toEqual([]);
  expect(bankedResetDetails({ availableCount: 0, credits: [] })).toEqual(['Banked resets: 0 available']);
  expect(bankedResetDetails({ availableCount: 2 })).toEqual(['Banked resets: 2 available', 'Expiry details unavailable']);
  expect(bankedResetDetails({ availableCount: 2, credits: [] })).toEqual(['Banked resets: 2 available', 'Expiry details unavailable']);
  expect(quotaStatus({ composeProvider: 'Claude', accounts: { Codex: { status: 'ready', quota: { status: 'available', windows: [], bankedResets: { availableCount: 2 } } } } }).tooltip).not.toContain('Banked resets');
});

it.each([
  [8 * 86400000 + 15 * 3600000, '8d 15h left'],
  [86400000, '1d left'],
  [23 * 3600000 + 59 * 60000, '23h 59m left'],
  [3600000, '1h left'],
  [60000, '1m left'],
  [30000, '<1m left'],
  [0, 'Expired'],
  [-60000, 'Expired'],
])('counts down %i milliseconds as %s', (remaining, expected) => {
  const now = Date.parse('2026-10-14T05:00:00Z');
  expect(bankedResetCountdown(now + remaining, now)).toBe(expected);
});

it('adds the countdown next to each expiry and recomputes it without changing quota data', () => {
  const now = Date.parse('2026-10-14T05:00:00Z');
  const resets = { availableCount: 1, credits: [{ title: 'Full reset', expiresAt: now + 2 * 86400000 }] };
  expect(bankedResetDetails(resets, now)[1]).toContain('2d left');
  expect(bankedResetDetails(resets, now + 86400000)[1]).toContain('1d left');
  expect(bankedResetDetails(resets, now + 2 * 86400000)[1]).toContain('Expired');
  expect(resets.availableCount).toBe(1);
});
