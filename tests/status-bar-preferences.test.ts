import { expect, it } from 'vitest';
import { quotaStatuses } from '../src/core/quota-status';
import { statusBarPreferences, statusBarPreferenceChanges } from '../src/core/status-bar-preferences';

const state = { composeProvider: 'Claude' as const, accounts: {
  Codex: { status: 'ready' as const, account: { signedIn: true, email: 'codex@test', plan: 'plus', method: 'ChatGPT' }, quota: { status: 'available' as const,
    windows: [{ id: '5h', label: '5h', usedPercent: 25, resetsAt: Date.now() + 86400000 }, { id: '7d', label: '7d', usedPercent: 10 }, { id: 'reserve', label: 'Reserve', usedPercent: 0 }], bankedResets: { availableCount: 2 } } },
  Claude: { status: 'ready' as const, quota: { status: 'available' as const, windows: [{ id: '5h', label: '5h', usedPercent: 90 }] } },
} };
it('shows both agents and all quota windows by default, independent of the selected chat agent', () => {
  const statuses = quotaStatuses(state, statusBarPreferences());
  expect(statuses.map(value => value.provider)).toEqual(['Codex', 'Claude']);
  expect(statuses[0]!.text).toContain('Reserve 100%'); expect(statuses[0]!.text).toContain('↻ 2');
  expect(statuses[1]!.text).toBe('$(sparkle) Claude Code · 5h 10%');
});
it.each([['active', 'Claude'], ['codex', 'Codex'], ['claude', 'Claude']] as const)('supports %s visibility', (mode, provider) => {
  expect(quotaStatuses(state, statusBarPreferences({ providers: mode })).map(value => value.provider)).toEqual([provider]);
});
it('follows the conversation provider in active mode', () => {
  const statuses = quotaStatuses({ ...state, conversation: { conversation: { provider: 'Codex' } } as any }, statusBarPreferences({ providers: 'active' }));
  expect(statuses.map(value => value.provider)).toEqual(['Codex']);
});
it('customizes text and field order while retaining all quota and banked reset details on hover', () => {
  const status = quotaStatuses(state, statusBarPreferences({ providers: 'codex', fields: ['account', 'plan', 'reset', 'quota'], quotaWindows: 'main' }))[0]!;
  expect(status.text).toContain('Codex · codex@test · plus · 5h reset');
  expect(status.text).toContain('5h 75%'); expect(status.text).not.toContain('Reserve'); expect(status.text).not.toContain('banked');
  expect(status.tooltip).toContain('Reserve: 100% remaining'); expect(status.tooltip).toContain('Banked resets: 2 available');
  expect(quotaStatuses(state, statusBarPreferences({ fields: [] }))[1]!.text).toBe('$(sparkle) Claude Code');
});
it('keeps unknown provider quota visible without inventing a percentage', () => {
  expect(quotaStatuses({}, statusBarPreferences()).map(value => value.text)).toEqual(['$(terminal) Codex · Quota —', '$(sparkle) Claude Code · Quota —']);
});
it('validates all custom settings before persistence and rejects unknown fields', () => {
  expect(statusBarPreferenceChanges({ fields: ['quota', 'quota', 'account'], alignment: 'left' })).toEqual([{ key: 'statusBarFields', value: ['quota', 'account'] }, { key: 'statusBarAlignment', value: 'left' }]);
  for (const value of [null, [], { providers: 'unknown' }, { fields: ['token'] }, { fields: 'quota' }, { alignment: 'middle' }, { quotaWindows: 'none' }, { style: 'bad' }, { unknown: true }, { providers: 'both', alignment: false }]) {
    expect(() => statusBarPreferenceChanges(value)).toThrow('Invalid status bar');
  }
});
it('supports icons only with full hover data and restores verbose labels in text mode', () => {
  const icons = quotaStatuses(state, statusBarPreferences({ style: 'icons' }));
  expect(icons.map(value => value.text)).toEqual(['$(terminal)', '$(sparkle)']);
  expect(icons[0]!.tooltip).toContain('Codex · codex@test · plus'); expect(icons[0]!.tooltip).toContain('Banked resets: 2 available');
  expect(icons[1]!.tooltip).toContain('Claude Code'); expect(icons[1]!.tooltip).toContain('5h: 10% remaining');
  const full = quotaStatuses(state, statusBarPreferences({ style: 'text' }));
  expect(full[0]!.text).toContain('$(dashboard) Codex'); expect(full[0]!.text).toContain('2 banked resets');
});
