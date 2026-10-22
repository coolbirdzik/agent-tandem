import * as vscode from 'vscode';
import type { UsageDashboardState } from '../core/usage-dashboard';
import type { ConversationProvider } from '../providers/conversations';
import { profileIdentityKey } from '../core/account-profiles';
import { compactCountdown } from '../core/quota-status';
import { storageSize, storageUsageLevel } from '../core/storage-usage';
import { uniqueQuotaWindows } from '../core/quota-windows';
import { uniqueAccountProfiles, accountProfileStatus } from '../core/account-display';

const commands = ['agentTandem.quickAccounts', 'agentTandem.quickSwitchAccount', 'agentTandem.resetCodexUsage', 'agentTandem.openSettings', 'agentTandem.manageAccounts', 'agentTandem.refreshQuotaAccounts', 'agentTandem.openExtensionStorage', 'agentTandem.previewReviewCleanup'];
/** The hover is raw HTML blocks, so user text is entity-encoded: no tags, no markdown links, no `$(icon)` syntax, no blank lines. */
const escape = (value: string) => value.replace(/[&<>"'$\\`*_{}\[\]()#!|]/g, char => `&#${char.charCodeAt(0)};`).replace(/[\r\n]+/g, ' ');
const link = (label: string, command: string, args: unknown[] = [], title = '') => `<a href="command:${command}?${encodeURIComponent(JSON.stringify(args))}"${title ? ` title="${title}"` : ''}>${label}</a>`;
const colors = { blue: 'charts-blue', orange: 'charts-orange', green: 'charts-green', yellow: 'editorWarning-foreground', red: 'errorForeground', muted: 'descriptionForeground' };
/** Only static theme color tokens enter HTML; all account/user text is escaped. */
const color = (text: string, tone: keyof typeof colors) => `<span style="color:var(--vscode-${colors[tone]});">${text}</span>`;
const quotaTone = (used: number) => used >= 100 ? 'red' : used >= 75 ? 'yellow' : 'green';
const remainingOf = (used: number) => Math.round(Math.max(0, 100 - used) * 10) / 10;
const chip = (text: string) => `<span style="color:var(--vscode-descriptionForeground);background-color:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px;">&nbsp;${text}&nbsp;</span>`;
// Native hover CSS cannot be overridden; h5 + muted caps mirrors VS Code's own view section headers.
const section = (title: string) => `<hr>\n\n<h5>${color(title.toUpperCase(), 'muted')}</h5>\n\n`;
const block = (html: string) => `${html}\n\n`;
const row = (...cells: string[]) => `<tr height="24">${cells.join('')}</tr>`;
// The first table pins a stable content width; later tables stretch to match it.
const table = (...rows: string[]) => block(`<table width="100%">${rows.join('')}</table>`);
const headerTable = (...rows: string[]) => block(`<table width="380">${rows.join('')}</table>`);
/** Sanitized spans cannot be sized, so the meter is a theme-neutral SVG; the colored percentage beside it carries the value. */
const meterFill = { green: '#2ea043', yellow: '#d29922', red: '#e5534b' } as const;
const meter = (remaining: number, tone: keyof typeof meterFill) => {
  const width = 132, filled = Math.round(width * Math.max(0, Math.min(100, remaining)) / 100);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6"><rect width="${width}" height="6" rx="3" fill="#888" fill-opacity=".28"/>${filled ? `<rect width="${Math.max(6, filled)}" height="6" rx="3" fill="${meterFill[tone]}"/>` : ''}</svg>`;
  return `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${width}" height="6" align="middle" alt="">`;
};

/** VS Code's native sticky hover supports keyboard-focusable command links. */
export function quotaAccountHover(provider: ConversationProvider, state: Pick<UsageDashboardState, 'accounts' | 'managedAccounts' | 'accountsBusy' | 'accountsError' | 'accountsNotice' | 'accountSwitch' | 'accountSwitchBlocked' | 'extensionStorage'>): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true), status = state.accounts?.[provider], account = status?.account;
  md.isTrusted = { enabledCommands: commands }; md.supportHtml = true;
  const providerIcon = color(`$(${provider === 'Codex' ? 'agent-tandem-codex' : 'agent-tandem-claude'})`, provider === 'Codex' ? 'blue' : 'orange');
  const signedIn = account ? account.signedIn ? color('$(pass-filled) Active', 'green') : color('$(circle-slash) Signed out', 'muted') : '';
  md.appendMarkdown(headerTable(
    row(`<td>${providerIcon} <strong>${provider === 'Claude' ? 'Claude Code' : provider}</strong>${account?.plan ? ` &nbsp;${chip(escape(account.plan.replace(/_/g, ' ')))}` : ''}</td>`, `<td align="right">${signedIn}</td>`),
    account ? row(`<td colspan="2">${color(escape(account.email || account.method), 'muted')}</td>`) : ''));
  const windows = uniqueQuotaWindows(status?.quota?.windows);
  if (windows.length) md.appendMarkdown(table(...windows.map(window => {
    const remaining = remainingOf(window.usedPercent), tone = quotaTone(window.usedPercent);
    return row(`<td width="28"><strong>${escape(window.label)}</strong></td>`, `<td>${meter(remaining, tone)}</td>`,
      `<td align="right">${color(`<strong>${remaining}%</strong>`, tone)} ${color('left', 'muted')}</td>`,
      `<td align="right">${window.resetsAt ? color(`$(clock) ${compactCountdown(window.resetsAt)}`, 'muted') : color('—', 'muted')}</td>`);
  })));
  if (!status?.quota?.windows.length) md.appendMarkdown(block(`<div>${color(escape(status?.quota?.detail || status?.error || 'Quota unavailable'), 'muted')}</div>`));
  if (status?.quotaCached) md.appendMarkdown(block(`<div>${color(`$(history) Cached quota${status.updatedAt ? ` · ${escape(new Date(status.updatedAt).toLocaleString())}` : ''}${status.error ? ` · ${escape(status.error)}` : ''}`, 'muted')}</div>`));
  const busy = !!state.accountsBusy || !!state.accountSwitchBlocked;
  if (provider === 'Codex' && account?.signedIn && account.method === 'ChatGPT') {
    const count = status?.quota?.bankedResets?.availableCount;
    const expires = status?.quota?.bankedResets?.credits?.flatMap(credit => credit.expiresAt ? [credit.expiresAt] : []).sort((a, b) => a - b)[0];
    const reset = count && !busy && status.status === 'ready' && !status.quotaCached
      ? `${color('$(gift)', 'blue')} ${link('Reset usage', 'agentTandem.resetCodexUsage')} ${color(`· uses 1 of ${count} earned resets`, 'muted')}`
      : color(`$(gift) Reset usage · ${count === undefined ? 'refresh to check earned resets' : count ? `${count} earned resets available` : 'no earned resets available'}`, 'muted');
    md.appendMarkdown(table(row(`<td>${reset}</td>`, `<td align="right">${count && expires ? color(`expires ${compactCountdown(expires)}`, 'muted') : ''}</td>`)));
  }
  const currentId = profileIdentityKey(provider, account);
  const profiles = uniqueAccountProfiles((state.managedAccounts ?? []).filter(row => row.provider === provider)
    .filter(row => !row.active && (!currentId || currentId !== profileIdentityKey(provider, row.identity || row.status?.account))))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (profiles.length) {
    md.appendMarkdown(section('Switch account'));
    md.appendMarkdown(table(...profiles.slice(0, 3).map(profile => {
      const saved = accountProfileStatus(profile), identity = saved?.account || profile.identity, quota = uniqueQuotaWindows(saved?.quota?.windows);
      const email = identity?.email && profile.label.trim().toLowerCase() !== identity.email.trim().toLowerCase() ? escape(identity.email) : '';
      const quotaSummary = quota.slice(0, 2).map(window => color(`${escape(window.label)} ${remainingOf(window.usedPercent)}% left`, quotaTone(window.usedPercent))).join(color(' · ', 'muted')) || 'Quota unavailable';
      // Identity and quota share one muted detail line; the action keeps its own right-aligned column.
      const detail = [email, quotaSummary, saved?.quotaCached ? '$(history) cached' : '', saved?.error ? escape(saved.error) : ''].filter(Boolean).join(color(' · ', 'muted'));
      const action = busy ? color('$(lock) Unavailable', 'muted') : link('<span style="color:var(--vscode-button-foreground);background-color:var(--vscode-button-background);border-radius:4px;">&nbsp;&nbsp;Switch&nbsp;&nbsp;</span>', 'agentTandem.quickSwitchAccount', [profile.id]);
      return row(`<td>$(account) <strong>${escape(profile.label)}</strong>${identity?.plan ? ` &nbsp;${chip(escape(identity.plan))}` : ''}<br>${color(detail, 'muted')}</td>`, `<td align="right">${action}</td>`);
    })));
    if (profiles.length > 3) md.appendMarkdown(block(`<div>${link(`Show ${profiles.length - 3} more accounts…`, 'agentTandem.quickAccounts', [provider])}</div>`));
  }
  const usage = state.extensionStorage, level = storageUsageLevel(usage);
  const storageSummary = usage?.total === undefined ? usage?.status === 'error' ? 'Unavailable' : 'Measuring…' : storageSize(usage.total);
  const checked = usage?.checkedAt ? color(`checked ${Date.now() - usage.checkedAt < 60000 ? 'just now' : `${Math.floor((Date.now() - usage.checkedAt) / 60000)}m ago`}`, 'muted') : '';
  md.appendMarkdown(section('Extension storage'));
  const alert = usage?.status === 'error' ? color(`$(warning) ${escape(usage.error || 'Refresh to check storage.')}`, 'yellow')
    : level === 'warning' || level === 'critical' ? color(`$(${level === 'critical' ? 'error' : 'warning'}) Above ${storageSize(usage!.warningBytes)} alert threshold`, level === 'critical' ? 'red' : 'yellow') : '';
  const largest = usage?.categories?.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 2) ?? [];
  md.appendMarkdown(table(row(`<td><strong>${storageSummary}</strong> ${color('total', 'muted')}</td>`, `<td align="right">${checked}</td>`),
    alert ? row(`<td colspan="2">${alert}</td>`) : '',
    ...largest.map(category => row(`<td>${color(escape(category.label), 'muted')}</td>`, `<td align="right">${storageSize(category.bytes)}</td>`))));
  const cleanup = usage?.categories?.some(row => row.label === 'Review snapshots & tracking' && row.files)
    ? `$(clear-all) ${['accepted', 'all'].map(scope => link(`Clean ${scope}…`, 'agentTandem.previewReviewCleanup', [{ scope }], 'Review snapshots: preview before deleting')).join(color(' · ', 'muted'))}` : '';
  md.appendMarkdown(table(row(`<td>${cleanup || link('$(folder-opened) Manage storage', 'agentTandem.openExtensionStorage')}</td>`, `<td align="right">${cleanup ? link('$(folder-opened) Manage storage', 'agentTandem.openExtensionStorage') : ''}</td>`)));
  const notes = [
    state.accountSwitchBlocked ? color(`$(lock) ${escape(state.accountSwitchBlocked)}`, 'yellow') : '',
    state.accountSwitch?.status === 'running' ? `$(loading~spin) ${escape(state.accountSwitch.logs.at(-1)?.message || 'Switching account…')}` : '',
    state.accountsError ? color(`$(error) ${escape(state.accountsError)}`, 'red') : state.accountsNotice ? color(`$(check) ${escape(state.accountsNotice)}`, 'green') : '',
  ].filter(Boolean);
  if (notes.length) md.appendMarkdown(block(`<div>${notes.join('<br>')}</div>`));
  md.appendMarkdown('<hr>\n\n');
  md.appendMarkdown(table(row(`<td>${link('$(dashboard) <strong>Open dashboard</strong>', 'agentTandem.openSettings')}</td>`, `<td align="right">${[
    link('$(refresh) Refresh', 'agentTandem.refreshQuotaAccounts'), link('$(settings-gear) Accounts', 'agentTandem.manageAccounts', [], 'Manage accounts'),
    link('$(search) Search', 'agentTandem.quickAccounts', [provider], 'Search / switch accounts')].join(' &nbsp;&nbsp; ')}</td>`)).trimEnd());
  return md;
}
