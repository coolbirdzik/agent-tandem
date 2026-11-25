import { afterEach, describe, it, expect, vi } from 'vitest';
import type { UsageDashboardState } from '../src/core/usage-dashboard';
vi.mock('vscode', () => ({ MarkdownString: class { value: string; isTrusted = false; supportHtml?: boolean; constructor(value = '') { this.value = value; } appendMarkdown(text: string) { this.value += text; return this; } } }));
import { quotaAccountHover } from '../src/host/quota-account-hover';
import { quotaAccountHoverHtml, quotaHoverCommands } from '../src/core/quota-account-hover';
const identity = { signedIn: true, email: 'one@example.test', method: 'ChatGPT' };
function fixture(): UsageDashboardState {
  return { status: 'ready', preferences: { showQuotaInStatusBar: true, grouping: 'day' }, accounts: { Codex: { status: 'ready', account: identity,
    quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 90 }], bankedResets: { availableCount: 2 } } } }, managedAccounts: [
    { id: 'one', provider: 'Codex', label: 'Personal', identity, active: true, createdAt: 1 },
    { id: 'two', provider: 'Codex', label: 'Work', identity: { ...identity, email: 'two@example.test' }, createdAt: 1 },
  ] };
}
describe('Account status hover', () => {
  afterEach(() => vi.restoreAllMocks());
  it('uses badges inside model-specific quota labels while escaping the surrounding provider text', () => {
    const state = fixture();
    state.accounts!.Codex!.quota!.windows.push({ id: 'model', label: 'Sonnet <model> $(zap) · 7d', usedPercent: 50 });
    const text = quotaAccountHover('Codex', state).value;
    expect(text).toContain('Sonnet &#60;model&#62; &#36;&#40;zap&#41; · <span');
    expect(text).toContain('&nbsp;7d&nbsp;');
    expect(text).not.toContain('$(zap)');
  });
  it('never puts a personal Plus plan or cached quota under a saved Pro Lite account label', () => {
    const state = fixture(), profile = state.managedAccounts![1]!;
    profile.label = 'dev@example.test'; profile.identity = { signedIn: true, method: 'ChatGPT', email: profile.label, id: 'dev', plan: 'prolite' };
    profile.status = { status: 'error', account: { signedIn: true, method: 'ChatGPT', email: 'personal@example.test', id: 'personal', plan: 'plus' }, quotaCached: true,
      quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 100 }, { id: '7d', label: '7d', usedPercent: 16 }] } };
    const text = quotaAccountHover('Codex', state).value;
    expect(text).toContain('prolite'); expect(text).toContain('identity mismatch');
    expect(text).not.toContain('personal@example.test'); expect(text).not.toContain('<strong>84%</strong>');
  });
  it('renders each quota window and saved account once, using the freshest profile quota', () => {
    const state = fixture();
    state.accounts!.Codex!.quota!.windows.push({ id: '5h', label: '5h', usedPercent: 46 });
    const identity = state.managedAccounts![1]!.identity!;
    state.managedAccounts![1]!.status = { status: 'error', account: identity, quotaCached: true, updatedAt: 1, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 100 }] } };
    state.managedAccounts!.push({ ...state.managedAccounts![1]!, id: 'two-current', label: 'Work updated', status: { status: 'ready', account: identity, updatedAt: 2, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 20 }] } } });
    const menu = quotaAccountHover('Codex', state);
    expect(menu.value.match(/&nbsp;5h&nbsp;/g)).toHaveLength(2); expect(menu.value).toContain('<strong>54%</strong>'); expect(menu.value).not.toContain('<strong>10%</strong>');
    expect(menu.value.match(/Work updated/g)).toHaveLength(1);
    expect(menu.value).toContain('Work updated'); expect(menu.value).toContain('<strong>80%</strong> left'); expect(menu.value).not.toContain('<strong>0%</strong> left');
  });
  it('shows direct account switching, earned-reset redemption and the provider picker', () => {
    const menu = quotaAccountHover('Codex', fixture());
    expect(menu.value).toContain('<strong>10%</strong>'); expect(menu.value).toContain('pass-filled) Active');
    expect(menu.value).toContain('SWITCH ACCOUNT'); expect(menu.value).toContain('Work');
    expect(menu.value).toContain('2 earned resets available');
    expect(menu.value).toContain('command:agentTandem.quickSwitchAccount?%5B%22two%22%5D');
    expect(menu.value).toContain('command:agentTandem.resetCodexUsage?');
    expect(menu.value).toContain('Use 1 reset');
    expect(menu.value).toContain('command:agentTandem.quickAccounts?%5B%22Codex%22%5D');
    expect(menu.isTrusted).toEqual({ enabledCommands: quotaHoverCommands });
    expect(menu.supportHtml).toBe(true);
    expect(menu.value).toContain('color:var(--vscode-editorWarning-foreground)');
  });
  it('escapes account content and does not trust arbitrary command links', () => {
    const state = fixture(); state.managedAccounts![1]!.label = '[bad](command:evil) $(zap)';
    const menu = quotaAccountHover('Codex', state);
    expect(menu.value).not.toContain('[bad](command:evil)');
    expect(menu.isTrusted).toEqual({ enabledCommands: quotaHoverCommands });
    expect(menu.value).toContain('&#91;bad&#93;&#40;command:evil&#41; &#36;&#40;zap&#41;'); expect(menu.value).not.toContain('$(zap)');
    state.managedAccounts![1]!.label = '<span style="color:red">bad</span>';
    expect(quotaAccountHover('Codex', state).value).toContain('&#60;span');
  });
  it('keeps the Preferences preview free of executable command links', () => {
    const preview = quotaAccountHoverHtml('Codex', fixture(), 'webview');
    expect(preview).toContain('Use 1 reset'); expect(preview).toContain('Quick Accounts');
    expect(preview).not.toMatch(/<a\b|command:/);
  });
  it('hides mutation links during an account operation or active agent turn', () => {
    for (const flags of [{ accountsBusy: true }, { accountSwitchBlocked: 'Finish the active turn.' }]) {
      const menu = quotaAccountHover('Codex', { ...fixture(), ...flags }).value;
      expect(menu).not.toMatch(/command:agentTandem\.(quickSwitchAccount|resetCodexUsage)/);
      expect(menu).toContain('command:agentTandem.quickAccounts?');
    }
  });
  it('offers the provider-specific picker for additional saved accounts', () => {
    const state = fixture();
    for (let i = 0; i < 4; i++) state.managedAccounts!.push({ id: `extra-${i}`, provider: 'Codex', label: `Extra ${i}`, createdAt: 1 });
    const menu = quotaAccountHover('Codex', state).value;
    expect(menu.match(/command:agentTandem.quickSwitchAccount/g)).toHaveLength(3);
    expect(menu).toContain('Show 2 more accounts…');
  });
  it('offers Claude switching without exposing the Codex reset or other provider profiles', () => {
    const state = fixture();
    state.managedAccounts!.push({ id: 'claude-work', provider: 'Claude', label: 'Claude Work', createdAt: 1 });
    const menu = quotaAccountHover('Claude', state).value;
    expect(menu).toContain('command:agentTandem.quickSwitchAccount?%5B%22claude-work%22%5D');
    expect(menu).toContain('command:agentTandem.quickAccounts?%5B%22Claude%22%5D');
    expect(menu).not.toContain('command:agentTandem.resetCodexUsage');
    expect(menu).not.toContain('%5B%22two%22%5D');
  });
  it('does not repeat an email used as the saved profile name and labels cached quota', () => {
    const state = fixture(), profile = state.managedAccounts![1]!;
    profile.label = profile.identity!.email!;
    profile.status = { status: 'error', account: profile.identity, quotaCached: true, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 40 }] } };
    const menu = quotaAccountHover('Codex', state);
    expect(menu.value.match(/two@example.test/g)).toHaveLength(1);
    expect(menu.value).toContain('<strong>60%</strong> left'); expect(menu.value).toContain('$(history) cached');
  });
  it('shows relative quota resets for active and saved accounts and when quota is refreshing', () => {
    const now = Date.UTC(2026, 10, 19, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const state = fixture(), resetsAt = now + 2 * 3600000 + 10 * 60000;
    state.accounts!.Codex!.quota!.windows[0]!.resetsAt = now + 30000;
    state.managedAccounts![1]!.status = { status: 'ready', account: state.managedAccounts![1]!.identity, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 40, resetsAt }, { id: '7d', label: '7d', usedPercent: 10, resetsAt: now - 60000 }] } };
    const menu = quotaAccountHover('Codex', state).value;
    expect(menu).toContain('$(clock) resets in &#60;1m</span>');
    expect(menu).toContain('<strong>60%</strong> left');
    expect(menu).toContain('$(clock) resets in 2h10m</span>');
    expect(menu).toContain('$(clock) reset</span>');
    expect(menu).not.toContain('Refreshing…');
    state.accountsRefreshing = true;
    const busy = quotaAccountHover('Codex', state).value;
    expect(busy).toContain('Refreshing…');
  });
  it('shows only the time left for each earned reset expiry', () => {
    const now = Date.UTC(2026, 10, 19, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const state = fixture();
    state.accounts!.Codex!.quota!.bankedResets = { availableCount: 3, credits: [
      { title: 'Full reset', expiresAt: now + 2 * 86400000 },
      { title: 'Weekly reset', expiresAt: now + 30000 },
      { title: 'Another reset' },
    ] };
    const hover = quotaAccountHover('Codex', state).value;
    expect(hover).toContain('Weekly reset · &#60;1m left</span>');
    expect(hover).toContain('Full reset · 2d left</span>');
    expect(hover).toContain('Another reset · Expiry unavailable</span>');
    expect(hover.indexOf('Weekly reset')).toBeLessThan(hover.indexOf('Full reset'));
    expect(hover).not.toContain('Expires');
  });
  it.each(['Codex', 'Claude'] as const)('omits extension storage from the %s hover', provider => {
    const state = fixture(); state.extensionStorage = { status: 'ready', total: 2 * 1024 ** 3, files: 1500, warningBytes: 1024 ** 3,
      categories: [{ label: 'Review snapshots & tracking', bytes: 1.8 * 1024 ** 3, files: 1400 }] };
    const hover = quotaAccountHover(provider, fixture()).value;
    expect(hover).not.toContain('EXTENSION STORAGE');
    expect(quotaAccountHover(provider, state).value).toBe(hover);
    state.extensionStorage.status = 'error'; state.extensionStorage.error = 'Could not measure extension data.';
    expect(quotaAccountHover(provider, state).value).toBe(hover);
  });
  it('distinguishes zero, unknown and cached earned-reset counts', () => {
    for (const [count, label] of [[0, 'No earned resets available'], [undefined, 'Earned resets unavailable']] as const) {
      const state = fixture(); state.accounts!.Codex!.quota!.bankedResets = count === undefined ? undefined : { availableCount: count };
      expect(quotaAccountHover('Codex', state).value).toContain(label);
      expect(quotaAccountHover('Codex', state).value).not.toContain('command:agentTandem.resetCodexUsage');
    }
    const state = fixture(); state.accounts!.Codex!.quotaCached = true;
    expect(quotaAccountHover('Codex', state).value).toContain('2 earned resets available');
    expect(quotaAccountHover('Codex', state).value).not.toContain('command:agentTandem.resetCodexUsage');
    expect(quotaAccountHover('Claude', fixture()).value).not.toMatch(/earned resets/i);
  });
});
