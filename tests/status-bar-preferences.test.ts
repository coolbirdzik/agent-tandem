import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { QUOTA_GLYPHS, compactCountdown, quotaGlyphCharacter, quotaStatuses } from '../src/core/quota-status';
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
  expect(statuses[1]!.text).toBe('$(agent-tandem-claude) 5h 10%');
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
  expect(status.text).toContain('$(agent-tandem-codex) codex@test · plus · 5h 75% $(watch)'); expect(status.text).not.toContain('reset'); expect(status.text).not.toContain('Reserve'); expect(status.text).not.toContain('banked');
  expect(status.tooltip).toContain('Reserve: 100% remaining'); expect(status.tooltip).toContain('Banked resets: 2 available');
  expect(quotaStatuses(state, statusBarPreferences({ fields: [] }))[1]!.text).toBe('$(agent-tandem-claude)');
});
it('keeps unknown provider quota visible without inventing a percentage', () => {
  expect(quotaStatuses({}, statusBarPreferences()).map(value => value.text)).toEqual(['$(agent-tandem-codex) Quota —', '$(agent-tandem-claude) Quota —']);
});
it('puts each reset countdown on its own quota window in compact styles and keeps spelled-out text mode', () => {
  const now = Date.now(), windows = [{ id: '5h', label: '5h', usedPercent: 25, resetsAt: now + 134 * 60000 + 30000 }, { id: '7d', label: '7d', usedPercent: 60, resetsAt: now + (3 * 1440 + 240) * 60000 + 30000 }];
  const accounts = { Codex: { status: 'ready' as const, quota: { status: 'available' as const, windows } } };
  const show = (style: 'compact' | 'minimal' | 'text', fields: ('quota' | 'reset')[] = ['quota', 'reset']) => quotaStatuses({ accounts }, statusBarPreferences({ providers: 'codex', style, fields }))[0]!.label;
  expect(show('compact')).toBe('5h 75% $(watch)2h14m · 7d 40% $(watch)3d4h');
  expect(show('minimal')).toBe('$(agent-tandem-quota-level-6)$(agent-tandem-quota-level-3) 40% $(watch)3d4h');
  expect(show('compact', ['reset'])).toBe('5h $(watch)2h14m · 7d $(watch)3d4h');
  expect(show('text')).toBe('5h 75% · 7d 40% · 5h reset 2h 14m · 7d reset 3d 4h');
});
it.each([[0, 'now'], [30000, '<1m'], [5 * 60000, '5m'], [60 * 60000, '1h'], [61 * 60000, '1h1m'], [25 * 3600000, '1d1h'], [2 * 86400000, '2d']] as const)('shortens a reset %s ms away to %s', (ms, text) => {
  expect(compactCountdown(1000 + ms, 1000)).toBe(text);
});
it('accepts empty, theme and hex agent colors and drops anything else', () => {
  expect(statusBarPreferences({ codexColor: 'charts.blue', claudeColor: '#A1b2C3' })).toMatchObject({ codexColor: 'charts.blue', claudeColor: '#A1b2C3' });
  expect(statusBarPreferences({ codexColor: 'red', claudeColor: 'url(x)' })).toMatchObject({ codexColor: '', claudeColor: '' });
  expect(statusBarPreferenceChanges({ codexColor: '', claudeColor: 'charts.orange' })).toEqual([{ key: 'statusBarCodexColor', value: '' }, { key: 'statusBarClaudeColor', value: 'charts.orange' }]);
  for (const color of ['blue', '#fff', 'charts.pink', 3]) expect(() => statusBarPreferenceChanges({ codexColor: color })).toThrow('Invalid status bar');
});
it('validates all custom settings before persistence and rejects unknown fields', () => {
  expect(statusBarPreferenceChanges({ fields: ['quota', 'quota', 'account'], alignment: 'left' })).toEqual([{ key: 'statusBarFields', value: ['quota', 'account'] }, { key: 'statusBarAlignment', value: 'left' }]);
  for (const value of [null, [], { providers: 'unknown' }, { fields: ['token'] }, { fields: 'quota' }, { alignment: 'middle' }, { quotaWindows: 'none' }, { style: 'bad' }, { unknown: true }, { providers: 'both', alignment: false }]) {
    expect(() => statusBarPreferenceChanges(value)).toThrow('Invalid status bar');
  }
});
it('supports icons only with full hover data and verbose detail labels without agent names in text mode', () => {
  const icons = quotaStatuses(state, statusBarPreferences({ style: 'icons' }));
  expect(icons.map(value => value.text)).toEqual(['$(agent-tandem-codex)', '$(agent-tandem-claude)']);
  expect(icons[0]!.tooltip).toContain('Codex · codex@test · plus'); expect(icons[0]!.tooltip).toContain('Banked resets: 2 available');
  expect(icons[1]!.tooltip).toContain('Claude Code'); expect(icons[1]!.tooltip).toContain('5h: 10% remaining');
  const full = quotaStatuses(state, statusBarPreferences({ style: 'text' }));
  expect(full[0]!.text).toContain('$(agent-tandem-codex) 5h 75%'); expect(full[0]!.text).toContain('2 banked resets');
  expect(full[0]!.label).not.toContain('Codex'); expect(full[1]!.label).not.toContain('Claude Code');
});
it('persists progress mode and shows each remaining quota window with compact banked resets', () => {
  expect(statusBarPreferenceChanges({ style: 'progress' })).toEqual([{ key: 'statusBarStyle', value: 'progress' }]);
  const status = quotaStatuses(state, statusBarPreferences({ style: 'progress', providers: 'codex', quotaWindows: 'main' }))[0]!;
  expect(status.text).toBe('$(agent-tandem-codex) 5h ███▊░ 75% · 7d ████▌ 90% · ↻ 2');
  expect(status.tooltip).toContain('5h: 75% remaining'); expect(status.tooltip).toContain('Reserve: 100% remaining');
});
it.each([[0, '█████ 100%'], [0.1, '████▉ 99.9%'], [27.5, '███▋░ 72.5%'], [99.9, '▏░░░░ 0.1%'], [100, '░░░░░ 0%']] as const)('shows fractional progress and percentages while reserving endpoints (used %s%%)', (usedPercent, bar) => {
  const [status] = quotaStatuses({ accounts: { Codex: { status: 'ready', quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent }] } } } }, statusBarPreferences({ providers: 'codex', style: 'progress' }));
  expect(status!.text).toBe(`$(agent-tandem-codex) 5h ${bar}`);
});
it('shows a quota ring per window and a minimal column meter with only the lowest percentage', () => {
  expect(statusBarPreferenceChanges({ style: 'rings' })).toEqual([{ key: 'statusBarStyle', value: 'rings' }]);
  expect(statusBarPreferenceChanges({ style: 'minimal' })).toEqual([{ key: 'statusBarStyle', value: 'minimal' }]);
  const [rings] = quotaStatuses(state, statusBarPreferences({ style: 'rings', providers: 'codex', quotaWindows: 'main' }));
  expect(rings!.text).toBe('$(agent-tandem-codex) 5h $(agent-tandem-quota-ring-6) 75% · 7d $(agent-tandem-quota-ring-7) 90% · ↻ 2');
  const [minimal] = quotaStatuses(state, statusBarPreferences({ style: 'minimal', providers: 'codex' }));
  expect(minimal!.text).toBe('$(agent-tandem-codex) $(agent-tandem-quota-level-6)$(agent-tandem-quota-level-7)$(agent-tandem-quota-level-8) 75% · ↻ 2');
  expect(minimal!.tooltip).toContain('7d: 90% remaining'); expect(minimal!.tooltip).toContain('Reserve: 100% remaining');
});
it.each([[0, 8], [0.1, 7], [50, 4], [99.9, 1], [100, 0]] as const)('reserves empty and full quota glyphs for the exact endpoints (used %s%%)', (usedPercent, eighths) => {
  const [status] = quotaStatuses({ accounts: { Codex: { status: 'ready', quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent }] } } } }, statusBarPreferences({ providers: 'codex', style: 'minimal' }));
  expect(status!.label).toBe(`$(agent-tandem-quota-level-${eighths}) ${Math.round(100 - usedPercent)}%`);
});
it('contributes every quota glyph as a product icon at the character the settings preview renders', () => {
  const icons = JSON.parse(readFileSync('package.json', 'utf8')).contributes.icons as Record<string, { default: { fontPath: string; fontCharacter: string } }>;
  for (const kind of Object.keys(QUOTA_GLYPHS)) for (let eighths = 0; eighths <= 8; eighths++) {
    const reference = `$(agent-tandem-quota-${kind}-${eighths})`, icon = icons[reference.slice(2, -1)]!;
    expect(icon.default.fontPath).toBe('./media/provider-icons.ttf');
    expect(String.fromCodePoint(parseInt(icon.default.fontCharacter.slice(1), 16))).toBe(quotaGlyphCharacter(reference));
  }
  expect(quotaGlyphCharacter('$(agent-tandem-codex)')).toBeUndefined();
});
it('does not invent progress bars when quota is loading, unavailable or credit based', () => {
  const preferences = statusBarPreferences({ style: 'progress' });
  expect(quotaStatuses({}, preferences)[0]!.label).toBe('Quota —');
  expect(quotaStatuses({ accounts: { Codex: { status: 'loading' }, Claude: { status: 'ready', quota: { status: 'available', windows: [], credits: '$5' } } } }, preferences).map(status => status.label)).toEqual(['…', '$5']);
});
