import * as vscode from 'vscode';
import type { UsageDashboardState } from '../core/usage-dashboard';
import type { ConversationProvider } from '../providers/conversations';
import { profileIdentityKey } from '../core/account-profiles';
import { compactCountdown } from '../core/quota-status';
import { storageSize, storageUsageLevel } from '../core/storage-usage';
import { uniqueQuotaWindows } from '../core/quota-windows';
import { uniqueAccountProfiles, accountProfileStatus } from '../core/account-display';

const commands = ['agentTandem.quickAccounts', 'agentTandem.quickSwitchAccount', 'agentTandem.resetCodexUsage', 'agentTandem.openSettings', 'agentTandem.manageAccounts', 'agentTandem.refreshQuotaAccounts', 'agentTandem.openExtensionStorage', 'agentTandem.previewReviewCleanup'];
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#!|$]/g, '\\$&').replace(/[\r\n]+/g, ' ');
const link = (label: string, command: string, args: unknown[] = []) => `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
const colors = { blue: 'charts-blue', orange: 'charts-orange', green: 'charts-green', yellow: 'editorWarning-foreground', red: 'errorForeground', muted: 'descriptionForeground' };
/** Only static theme color tokens enter HTML; all account/user text is escaped. */
const color = (text: string, tone: keyof typeof colors) => `<span style="color:var(--vscode-${colors[tone]});">${text}</span>`;
const quotaTone = (used: number) => used >= 100 ? 'red' : used >= 75 ? 'yellow' : 'green';

/** VS Code's native sticky hover supports keyboard-focusable command links. */
export function quotaAccountHover(provider: ConversationProvider, state: Pick<UsageDashboardState, 'accounts' | 'managedAccounts' | 'accountsBusy' | 'accountsError' | 'accountsNotice' | 'accountSwitch' | 'accountSwitchBlocked' | 'extensionStorage'>): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true), status = state.accounts?.[provider], account = status?.account;
  md.isTrusted = { enabledCommands: commands }; md.supportHtml = true;
  const providerIcon = color(`$(${provider === 'Codex' ? 'agent-tandem-codex' : 'agent-tandem-claude'})`, provider === 'Codex' ? 'blue' : 'orange');
  md.appendMarkdown(`### ${providerIcon} ${provider === 'Claude' ? 'Claude Code' : provider}${account?.plan ? ` · ${escape(account.plan.replace(/_/g, ' '))}` : ''}\n\n`);
  if (account) md.appendMarkdown(`$(account) **${escape(account.email || account.method)}** · ${color(account.signedIn ? '$(pass-filled) Active' : '$(circle-slash) Signed out', account.signedIn ? 'green' : 'muted')}\n\n`);
  for (const window of uniqueQuotaWindows(status?.quota?.windows)) {
    const remaining = Math.round(Math.max(0, 100 - window.usedPercent) * 10) / 10;
    const filled = Math.max(0, Math.min(8, Math.round(remaining / 100 * 8)));
    md.appendMarkdown(`**${escape(window.label)}** · ${color(`$(circle-filled) ${remaining}% remaining`, quotaTone(window.usedPercent))}  \n`);
    md.appendMarkdown(`${color('━'.repeat(filled) + '─'.repeat(8 - filled), quotaTone(window.usedPercent))}${window.resetsAt ? ` &nbsp; $(clock) ${compactCountdown(window.resetsAt)}` : ''}  \n\n`);
  }
  if (!status?.quota?.windows.length) md.appendMarkdown(`${escape(status?.quota?.detail || status?.error || 'Quota unavailable')}\n\n`);
  if (status?.quotaCached) md.appendMarkdown(`\nCached quota${status.updatedAt ? ` · ${escape(new Date(status.updatedAt).toLocaleString())}` : ''}${status.error ? ` · ${escape(status.error)}` : ''}  \n`);
  const busy = !!state.accountsBusy || !!state.accountSwitchBlocked;
  if (provider === 'Codex' && account?.signedIn && account.method === 'ChatGPT') {
    const count = status?.quota?.bankedResets?.availableCount;
    md.appendMarkdown('\n');
    if (count && !busy && status.status === 'ready' && !status.quotaCached) md.appendMarkdown(`${color('$(gift)', 'blue')} ${link('Reset usage', 'agentTandem.resetCodexUsage')} · uses 1 of ${count} earned resets\n\n`);
    else md.appendMarkdown(`${color('$(gift)', 'muted')} Reset usage · ${count === undefined ? 'refresh to check earned resets' : count ? `${count} earned resets available` : 'no earned resets available'}\n\n`);
    const expires = status?.quota?.bankedResets?.credits?.flatMap(credit => credit.expiresAt ? [credit.expiresAt] : []).sort((a, b) => a - b)[0];
    if (count && expires) md.appendMarkdown(`${color(`$(history) Next earned reset expires in ${compactCountdown(expires)}`, 'muted')}\n\n`);
  }
  const currentId = profileIdentityKey(provider, account);
  const profiles = uniqueAccountProfiles((state.managedAccounts ?? []).filter(row => row.provider === provider)
    .filter(row => !row.active && (!currentId || currentId !== profileIdentityKey(provider, row.identity || row.status?.account))))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (profiles.length) {
    md.appendMarkdown(`---\n\n${color('$(arrow-swap)', 'blue')} **Switch account**\n\n`);
    for (const profile of profiles.slice(0, 3)) {
      const saved = accountProfileStatus(profile), identity = saved?.account || profile.identity, name = escape(profile.label), quota = uniqueQuotaWindows(saved?.quota?.windows);
      md.appendMarkdown(`${color('$(account)', 'muted')} ${busy ? name : link(name, 'agentTandem.quickSwitchAccount', [profile.id])}${identity?.plan ? ` · ${escape(identity.plan)}` : ''}  \n`);
      const details = [identity?.email && profile.label.trim().toLowerCase() !== identity.email.trim().toLowerCase() ? escape(identity.email) : '',
        quota.slice(0, 2).map(window => color(`${escape(window.label)} ${Math.round(Math.max(0, 100 - window.usedPercent) * 10) / 10}% remaining`, quotaTone(window.usedPercent))).join(' · '),
        saved?.quotaCached ? color('Cached quota', 'muted') : '', saved?.error ? escape(saved.error) : ''].filter(Boolean).join(' · ');
      if (details) md.appendMarkdown(`${details}\n\n`);
    }
    if (profiles.length > 3) md.appendMarkdown(`${link(`Show ${profiles.length - 3} more accounts…`, 'agentTandem.quickAccounts', [provider])}\n\n`);
  }
  const usage = state.extensionStorage, level = storageUsageLevel(usage);
  md.appendMarkdown(`---\n\n${color('$(database)', level === 'critical' ? 'red' : level === 'warning' ? 'yellow' : 'blue')} **Extension storage**`);
  md.appendMarkdown(usage?.total === undefined ? ` · ${usage?.status === 'error' ? 'unavailable' : 'measuring…'}\n\n` : ` · **${storageSize(usage.total)}**\n\n`);
  if (usage?.status === 'error') md.appendMarkdown(`${color('$(warning)', 'yellow')} ${escape(usage.error || 'Refresh to check storage.')}\n\n`);
  else if (level === 'warning' || level === 'critical') md.appendMarkdown(`${color(`$(${level === 'critical' ? 'error' : 'warning'}) Above ${storageSize(usage!.warningBytes)} alert threshold`, level === 'critical' ? 'red' : 'yellow')}\n\n`);
  const largest = usage?.categories?.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 2);
  if (largest?.length) md.appendMarkdown(`${largest.map(row => `${escape(row.label)} · ${storageSize(row.bytes)}`).join('  \n')}\n\n`);
  if (usage?.categories?.some(row => row.label === 'Review snapshots & tracking' && row.files)) {
    md.appendMarkdown(`${color('$(clear-all)', 'blue')} ${link('Clean accepted', 'agentTandem.previewReviewCleanup', [{ scope: 'accepted' }])} · ${link('Clean all', 'agentTandem.previewReviewCleanup', [{ scope: 'all' }])}  \n`);
    md.appendMarkdown(`${color('Review snapshots · preview before deleting', 'muted')}\n\n`);
  }
  md.appendMarkdown(`${link('$(folder-opened) Manage storage', 'agentTandem.openExtensionStorage')}${usage?.checkedAt ? ` · ${color(`checked ${Date.now() - usage.checkedAt < 60000 ? 'just now' : `${Math.floor((Date.now() - usage.checkedAt) / 60000)}m ago`}`, 'muted')}` : ''}\n\n`);
  if (state.accountSwitchBlocked) md.appendMarkdown(`${escape(state.accountSwitchBlocked)}\n\n`);
  if (state.accountSwitch?.status === 'running') md.appendMarkdown(`$(loading~spin) ${escape(state.accountSwitch.logs.at(-1)?.message || 'Switching account…')}\n\n`);
  if (state.accountsError || state.accountsNotice) md.appendMarkdown(`${state.accountsError ? '$(error)' : '$(check)'} ${escape(state.accountsError || state.accountsNotice!)}\n\n`);
  md.appendMarkdown(`---\n\n${link('$(dashboard) Open dashboard', 'agentTandem.openSettings')} · ${link('$(refresh) Refresh', 'agentTandem.refreshQuotaAccounts')}\n\n${link('$(settings-gear) Manage accounts', 'agentTandem.manageAccounts')} · ${link('$(search) Search / switch accounts', 'agentTandem.quickAccounts', [provider])}`);
  return md;
}
