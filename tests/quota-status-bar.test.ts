import { beforeEach, expect, it, vi } from 'vitest';
import type { ViewState } from '../src/core/types';
const host = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, items: [] as any[] }));
vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1, Right: 2 }, ThemeColor: class { constructor(public id: string) {} },
  MarkdownString: class { constructor(public value = '') {} appendMarkdown(text: string) { this.value += text; return this; } },
  workspace: { getConfiguration: () => ({ get: (key: string, fallback?: unknown) => host.settings[key] ?? fallback }) },
  window: { createStatusBarItem: (id: string, alignment: number, priority: number) => {
    const item = { id, alignment, priority, visible: false, disposed: false, show: vi.fn(() => { item.visible = true; }), hide: vi.fn(() => { item.visible = false; }), dispose: vi.fn(() => { item.disposed = true; item.visible = false; }) };
    host.items.push(item); return item;
  } },
}));
import { QuotaStatusBar } from '../src/host/quota-status-bar';
const state: ViewState = { sessions: [], running: false, providers: [], composeProvider: 'Claude', accounts: {
  Codex: { status: 'ready', quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 100 }] } },
  Claude: { status: 'ready', quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 20 }] } },
} };
beforeEach(() => { host.settings = {}; host.items = []; });
it('uses the status item quota snapshot for its hover even when dashboard data is older', () => {
  const bar = new QuotaStatusBar();
  const current = { ...state, accounts: { Codex: { status: 'ready' as const, account: { signedIn: true, email: 'current@test', method: 'ChatGPT' }, quota: { status: 'available' as const, windows: [{ id: '5h', label: '5h', usedPercent: 46 }] } } } };
  bar.update(current, { status: 'ready', preferences: { showQuotaInStatusBar: true, grouping: 'day' }, accounts: { Codex: { status: 'ready', account: { signedIn: true, email: 'previous@test', method: 'ChatGPT' }, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 100 }] } } } });
  const codex = host.items.find(item => item.id.endsWith('codex'));
  expect(codex.text).toContain('5h 54%'); expect(codex.tooltip.value).toContain('54% remaining');
  expect(codex.tooltip.value).toContain('current@test'); expect(codex.tooltip.value).not.toContain('previous@test');
  bar.dispose();
});
it('does not duplicate a window or retain its obsolete exhausted tone', () => {
  const bar = new QuotaStatusBar();
  bar.update({ ...state, accounts: { Codex: { status: 'ready', quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 100 }, { id: '5h', label: '5h', usedPercent: 46 }] } } } });
  const codex = host.items.find(item => item.id.endsWith('codex'));
  expect(codex.text).toBe('$(agent-tandem-codex) 5h 54%'); expect(codex.backgroundColor).toBeUndefined();
  expect(codex.tooltip.value.match(/\*\*5h\*\*/g)).toHaveLength(1); bar.dispose();
});
it('keeps cached quota visible and identifies its timestamp and refresh error in the tooltip', () => {
  const bar = new QuotaStatusBar();
  bar.update({ ...state, accounts: { ...state.accounts, Claude: { ...state.accounts!.Claude!, status: 'error', quotaCached: true, updatedAt: Date.now() - 3600000, error: 'Offline' } } });
  const claude = host.items.find(item => item.id.endsWith('claude'));
  expect(claude.text).toContain('5h 80%'); expect(claude.tooltip.value).toContain('Cached quota'); expect(claude.tooltip.value).toContain('Offline');
  bar.dispose();
});
it('keeps separate agent items with independent quota colors, commands and full accessible tooltips', () => {
  const bar = new QuotaStatusBar(); bar.update(state);
  expect(host.items).toHaveLength(2);
  const [codex, claude] = host.items;
  expect(codex.visible).toBe(true); expect(claude.visible).toBe(true);
  expect(codex.backgroundColor.id).toBe('statusBarItem.errorBackground'); expect(claude.backgroundColor).toBeUndefined();
  expect(claude.text).toBe('$(agent-tandem-claude) 5h 80%'); expect(claude.command).toEqual({ command: 'agentTandem.quickAccounts', title: 'Quota & quick account switch', arguments: ['Claude'] });
  expect(codex.accessibilityInformation.label).toContain('5h: 0% remaining');
  expect(codex.tooltip.value).toContain('Open dashboard');
  bar.dispose(); expect(host.items.every(item => item.disposed)).toBe(true);
});
it('applies provider selection and the master visibility switch immediately without leaving old items visible', () => {
  const bar = new QuotaStatusBar(); bar.update(state);
  host.settings.statusBarProviders = 'active'; bar.update(state);
  expect(host.items.map(item => item.visible)).toEqual([false, true]);
  bar.update({ ...state, composeProvider: 'Codex' }); expect(host.items.map(item => item.visible)).toEqual([true, false]);
  host.settings.showQuotaInStatusBar = false; bar.update(state); expect(host.items.every(item => !item.visible)).toBe(true);
  host.settings.showQuotaInStatusBar = true; host.settings.statusBarProviders = 'both'; bar.update(state);
  expect(host.items.map(item => item.visible)).toEqual([true, true]); expect(host.items).toHaveLength(2); bar.dispose();
});
it('moves both items to the configured side and disposes the old items', () => {
  const bar = new QuotaStatusBar(); bar.update(state);
  host.settings.statusBarAlignment = 'left'; bar.update(state);
  expect(host.items.slice(0, 2).every(item => item.disposed)).toBe(true);
  expect(host.items.slice(2).map(item => [item.alignment, item.visible])).toEqual([[1, true], [1, true]]);
  bar.update(state); expect(host.items).toHaveLength(4); bar.dispose();
});
it('switches to icons only while retaining accessible agent names and full hover details', () => {
  const bar = new QuotaStatusBar(); bar.update(state);
  host.settings.statusBarStyle = 'icons'; bar.update(state);
  expect(host.items.map(item => item.text)).toEqual(['$(agent-tandem-codex)', '$(agent-tandem-claude)']);
  expect(host.items[0].accessibilityInformation.label).toContain('Codex'); expect(host.items[1].accessibilityInformation.label).toContain('Claude Code');
  expect(host.items[0].tooltip.value).toContain('0% remaining'); expect(host.items).toHaveLength(2); bar.dispose();
});
it('switches existing items to progress bars while keeping quota alerts and accessible percentages', () => {
  const bar = new QuotaStatusBar(); bar.update(state);
  host.settings.statusBarStyle = 'progress'; bar.update(state);
  expect(host.items.map(item => item.text)).toEqual(['$(agent-tandem-codex) 5h ░░░░░ 0%', '$(agent-tandem-claude) 5h ████░ 80%']);
  expect(host.items[0].backgroundColor.id).toBe('statusBarItem.errorBackground');
  expect(host.items[1].accessibilityInformation.label).toContain('5h: 80% remaining');
  expect(host.items).toHaveLength(2); bar.dispose();
});
it('colors each agent with its own text color while low quota keeps its alert colors', () => {
  host.settings.statusBarCodexColor = '#ff8800'; host.settings.statusBarClaudeColor = 'charts.purple';
  const bar = new QuotaStatusBar(); bar.update(state);
  const [codex, claude] = host.items;
  expect(claude.color.id).toBe('charts.purple'); expect(codex.color.id).toBe('statusBarItem.errorForeground');
  bar.update({ ...state, accounts: { ...state.accounts, Codex: { status: 'ready', quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 30 }] } } } });
  expect(codex.color).toBe('#ff8800');
  host.settings.statusBarClaudeColor = 'not-a-color'; bar.update(state); expect(claude.color.id).toBe('charts.green'); bar.dispose();
});

it('does not rewrite or show quota items again for identical refresh data', () => {
  const bar = new QuotaStatusBar(); bar.update(state);
  const claude = host.items.find(item => item.id.endsWith('claude'));
  const write = vi.fn();
  let text = claude.text;
  Object.defineProperty(claude, 'text', { configurable: true, get: () => text, set: value => { text = value; write(value); } });
  bar.update(structuredClone(state));
  expect(write).not.toHaveBeenCalled(); expect(claude.show).toHaveBeenCalledTimes(1);
  bar.update({ ...state, accounts: { ...state.accounts, Claude: { ...state.accounts!.Claude!, status: 'loading', quotaCached: true } } });
  expect(write).not.toHaveBeenCalled();
  expect(claude.color.id).toBe('charts.green');
  bar.update({ ...state, accounts: { ...state.accounts, Claude: { ...state.accounts!.Claude!, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 25 }] } } } });
  expect(write).toHaveBeenLastCalledWith('$(agent-tandem-claude) 5h 75%');
  bar.dispose();
});
