import { describe, it, expect, vi } from 'vitest';
import type { UsageDashboardState } from '../src/core/usage-dashboard';
vi.mock('vscode', () => ({ MarkdownString: class { value: string; isTrusted?: any; supportHtml?: boolean; constructor(value = '') { this.value = value; } appendMarkdown(text: string) { this.value += text; return this; } } }));
import { quotaAccountHover } from '../src/host/quota-account-hover';
const identity = { signedIn: true, email: 'one@example.test', method: 'ChatGPT' };
function fixture(): UsageDashboardState {
  return { status: 'ready', preferences: { showQuotaInStatusBar: true, grouping: 'day' }, accounts: { Codex: { status: 'ready', account: identity,
    quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 90 }], bankedResets: { availableCount: 2 } } } }, managedAccounts: [
    { id: 'one', provider: 'Codex', label: 'Personal', identity, active: true, createdAt: 1 },
    { id: 'two', provider: 'Codex', label: 'Work', identity: { ...identity, email: 'two@example.test' }, createdAt: 1 },
  ] };
}
describe('Account status hover menu', () => {
  it('never puts a personal Plus plan or cached quota under a saved Pro Lite account label', () => {
    const state = fixture(), profile = state.managedAccounts![1]!;
    profile.label = 'dev@example.test'; profile.identity = { signedIn: true, method: 'ChatGPT', email: profile.label, id: 'dev', plan: 'prolite' };
    profile.status = { status: 'error', account: { signedIn: true, method: 'ChatGPT', email: 'personal@example.test', id: 'personal', plan: 'plus' }, quotaCached: true,
      quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 100 }, { id: '7d', label: '7d', usedPercent: 16 }] } };
    const text = quotaAccountHover('Codex', state).value;
    expect(text).toContain('prolite'); expect(text).toContain('identity mismatch');
    expect(text).not.toContain('personal@example.test'); expect(text).not.toContain('7d 84%');
  });
  it('renders each quota window and saved account once, using the freshest profile quota', () => {
    const state = fixture();
    state.accounts!.Codex!.quota!.windows.push({ id: '5h', label: '5h', usedPercent: 46 });
    const identity = state.managedAccounts![1]!.identity!;
    state.managedAccounts![1]!.status = { status: 'error', account: identity, quotaCached: true, updatedAt: 1, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 100 }] } };
    state.managedAccounts!.push({ ...state.managedAccounts![1]!, id: 'two-current', label: 'Work updated', status: { status: 'ready', account: identity, updatedAt: 2, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 20 }] } } });
    const menu = quotaAccountHover('Codex', state);
    expect(menu.value.match(/<strong>5h<\/strong>/g)).toHaveLength(1); expect(menu.value).toContain('<strong>54%</strong>'); expect(menu.value).not.toContain('<strong>10%</strong>');
    expect(menu.value.match(/command:agentTandem.quickSwitchAccount/g)).toHaveLength(1);
    expect(menu.value).toContain('Work updated'); expect(menu.value).toContain('5h 80%'); expect(menu.value).not.toContain('5h 0%');
  });
  it('exposes dashboard, switch and earned-reset links without a click on the status item', () => {
    const menu = quotaAccountHover('Codex', fixture());
    expect(menu.value).toContain('<strong>10%</strong>'); expect(menu.value).toContain('pass-filled) Active');
    expect(menu.value).toContain('command:agentTandem.quickSwitchAccount?%5B%22two%22%5D');
    expect(menu.value).not.toContain('quickSwitchAccount?%5B%22one%22');
    expect(menu.value).toContain('command:agentTandem.resetCodexUsage'); expect(menu.value).toContain('>Reset usage</a>');
    expect(menu.value).toContain('uses 1 of 2'); expect(menu.value).toContain('Open dashboard');
    expect(menu.isTrusted).toEqual({ enabledCommands: expect.arrayContaining(['agentTandem.openSettings', 'agentTandem.resetCodexUsage']) });
    expect(menu.supportHtml).toBe(true);
    expect(menu.value).toContain('color:var(--vscode-editorWarning-foreground)');
  });
  it('escapes account content and does not trust arbitrary command links', () => {
    const state = fixture(); state.managedAccounts![1]!.label = '[bad](command:evil) $(zap)';
    const menu = quotaAccountHover('Codex', state);
    expect(menu.value).not.toContain('[bad](command:evil)');
    expect((menu.isTrusted as any).enabledCommands).not.toContain('evil');
    expect(menu.value).toContain('&#91;bad&#93;&#40;command:evil&#41; &#36;&#40;zap&#41;'); expect(menu.value).not.toContain('$(zap)');
    state.managedAccounts![1]!.label = '<span style="color:red">bad</span>';
    expect(quotaAccountHover('Codex', state).value).toContain('&#60;span');
  });
  it('does not repeat an email used as the saved profile name and labels cached quota', () => {
    const state = fixture(), profile = state.managedAccounts![1]!;
    profile.label = profile.identity!.email!;
    profile.status = { status: 'error', account: profile.identity, quotaCached: true, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 40 }] } };
    const menu = quotaAccountHover('Codex', state);
    expect(menu.value.match(/two@example.test/g)).toHaveLength(1);
    expect(menu.value).toContain('5h 60% left'); expect(menu.value).toContain('$(history) cached');
  });
  it('brings storage warnings and review cleanup previews into the hover, without direct deletion', () => {
    const state = fixture(); state.extensionStorage = { status: 'ready', total: 2 * 1024 ** 3, files: 1500, warningBytes: 1024 ** 3,
      categories: [{ label: 'Review snapshots & tracking', bytes: 1.8 * 1024 ** 3, files: 1400 }] };
    const menu = quotaAccountHover('Codex', state);
    expect(menu.value).toContain('2 GB'); expect(menu.value).toContain('Above 1 GB alert threshold');
    expect(menu.value).toContain('Review snapshots &#38; tracking');
    expect(menu.value).toContain('command:agentTandem.openExtensionStorage');
    for (const scope of ['accepted', 'all']) expect(menu.value).toContain(`command:agentTandem.previewReviewCleanup?${encodeURIComponent(JSON.stringify([{ scope }]))}`);
    expect((menu.isTrusted as any).enabledCommands).toContain('agentTandem.previewReviewCleanup');
    expect(menu.value).toContain('preview before deleting');
    expect(menu.value).not.toContain('command:agentTandem.cleanupStorage');
    state.extensionStorage.status = 'error'; state.extensionStorage.error = 'Could not measure extension data.';
    expect(quotaAccountHover('Codex', state).value).toContain('Could not measure extension data.');
  });
  it('disables switching and resets during work and keeps dashboard available', () => {
    const state = fixture(); state.accountSwitchBlocked = 'Finish the active turn.';
    const menu = quotaAccountHover('Codex', state);
    expect(menu.value).not.toContain('command:agentTandem.quickSwitchAccount');
    expect(menu.value).not.toContain('command:agentTandem.resetCodexUsage');
    expect(menu.value).toContain('command:agentTandem.openSettings');
    expect(menu.value).toContain('Finish the active turn');
  });
  it('does not enable resets from zero, unknown or cached reset counts, or for Claude', () => {
    for (const count of [0, undefined]) {
      const state = fixture(); state.accounts!.Codex!.quota!.bankedResets = count === undefined ? undefined : { availableCount: count };
      expect(quotaAccountHover('Codex', state).value).not.toContain('command:agentTandem.resetCodexUsage');
    }
    const state = fixture(); state.accounts!.Codex!.quotaCached = true;
    expect(quotaAccountHover('Codex', state).value).not.toContain('command:agentTandem.resetCodexUsage');
    expect(quotaAccountHover('Claude', fixture()).value).not.toContain('Reset usage');
  });
});
