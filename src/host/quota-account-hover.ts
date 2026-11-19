import * as vscode from 'vscode';
import type { UsageDashboardState } from '../core/usage-dashboard';
import type { ConversationProvider } from '../providers/conversations';
import { profileIdentityKey } from '../core/account-profiles';
import { bankedResetCountdown } from '../core/banked-resets';
import { quotaWindowIconLabel, resetSummary, quotaUsageTone } from '../core/quota-status';
import { uniqueQuotaWindows } from '../core/quota-windows';
import { uniqueAccountProfiles, accountProfileStatus } from '../core/account-display';

/** The hover is raw HTML blocks, so user text is entity-encoded: no tags, no markdown links, no `$(icon)` syntax, no blank lines. */
const escape = (value: string) => value.replace(/[&<>"'$\\`*_{}\[\]()#!|]/g, char => `&#${char.charCodeAt(0)};`).replace(/[\r\n]+/g, ' ');
const colors = { blue: 'charts-blue', orange: 'charts-orange', green: 'charts-green', yellow: 'editorWarning-foreground', red: 'errorForeground', muted: 'descriptionForeground' };
/** Only static theme color tokens enter HTML; all account/user text is escaped. */
const color = (text: string, tone: keyof typeof colors) => `<span style="color:var(--vscode-${colors[tone]});">${text}</span>`;
const quotaTone = (used: number) => ({ exhausted: 'red', warning: 'yellow', healthy: 'green' } as const)[quotaUsageTone(used)];
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

export function quotaAccountHover(provider: ConversationProvider, state: Pick<UsageDashboardState, 'accounts' | 'managedAccounts' | 'accountsRefreshing' | 'accountsError' | 'accountsNotice' | 'accountSwitch'>): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true), status = state.accounts?.[provider], account = status?.account;
  const now = Date.now();
  md.supportHtml = true;
  const providerIcon = color(`$(${provider === 'Codex' ? 'agent-tandem-codex' : 'agent-tandem-claude'})`, provider === 'Codex' ? 'blue' : 'orange');
  const signedIn = account ? account.signedIn ? color('$(pass-filled) Active', 'green') : color('$(circle-slash) Signed out', 'muted') : '';
  md.appendMarkdown(headerTable(
    row(`<td>${providerIcon} <strong>${provider === 'Claude' ? 'Claude Code' : provider}</strong>${account?.plan ? ` &nbsp;${chip(escape(account.plan.replace(/_/g, ' ')))}` : ''}</td>`, `<td align="right">${signedIn}</td>`),
    account ? row(`<td colspan="2">${color(escape(account.email || account.method), 'muted')}</td>`) : ''));
  const windows = uniqueQuotaWindows(status?.quota?.windows);
  if (windows.length) md.appendMarkdown(table(...windows.map(window => {
    const remaining = remainingOf(window.usedPercent), tone = quotaTone(window.usedPercent);
    return row(`<td width="28"><strong>${quotaWindowIconLabel(window.label, escape)}</strong></td>`, `<td>${meter(remaining, tone)}</td>`,
      `<td align="right">${color(`<strong>${remaining}%</strong>`, tone)} ${color('left', 'muted')}</td>`,
      `<td align="right">${window.resetsAt ? color(`$(clock) ${escape(resetSummary(window.resetsAt, now))}`, 'muted') : color('—', 'muted')}</td>`);
  })));
  if (!status?.quota?.windows.length) md.appendMarkdown(block(`<div>${color(escape(status?.quota?.detail || status?.error || 'Quota unavailable'), 'muted')}</div>`));
  if (status?.quotaCached) md.appendMarkdown(block(`<div>${color(`$(history) Cached quota${status.updatedAt ? ` · ${escape(new Date(status.updatedAt).toLocaleString())}` : ''}${status.error ? ` · ${escape(status.error)}` : ''}`, 'muted')}</div>`));
  if (provider === 'Codex' && account?.signedIn && account.method === 'ChatGPT') {
    const count = status?.quota?.bankedResets?.availableCount;
    const credits = (status?.quota?.bankedResets?.credits ?? []).slice().sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
    const expires = credits[0]?.expiresAt;
    const reset = color(`$(gift) ${count === undefined ? 'Earned resets unavailable' : count === 0 ? 'No earned resets available' : `${count} earned reset${count === 1 ? '' : 's'} available`}`, 'muted');
    md.appendMarkdown(table(row(`<td>${reset}</td>`, `<td align="right">${count && expires ? color(escape(bankedResetCountdown(expires, now)), 'muted') : ''}</td>`)));
    // One line per earned reset, soonest expiry first, so each expiry stays readable.
    if (count && credits.length) {
      md.appendMarkdown(table(...credits.slice(0, 5).map(credit => row(`<td>${color(`${escape(credit.title || 'Banked reset')} · ${credit.expiresAt ? escape(bankedResetCountdown(credit.expiresAt, now)) : 'Expiry unavailable'}`, 'muted')}</td>`))));
      if (credits.length > 5 || credits.length < count) md.appendMarkdown(block(`<div>${color(credits.length > 5 ? `+${credits.length - 5} more earned resets` : 'Expiry details shown for some resets', 'muted')}</div>`));
    }
  }
  const currentId = profileIdentityKey(provider, account);
  const profiles = uniqueAccountProfiles((state.managedAccounts ?? []).filter(row => row.provider === provider)
    .filter(row => !row.active && (!currentId || currentId !== profileIdentityKey(provider, row.identity || row.status?.account))))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (profiles.length) {
    md.appendMarkdown(section('Saved accounts'));
    md.appendMarkdown(table(...profiles.slice(0, 3).map(profile => {
      const saved = accountProfileStatus(profile), identity = saved?.account || profile.identity, quota = uniqueQuotaWindows(saved?.quota?.windows);
      const email = identity?.email && profile.label.trim().toLowerCase() !== identity.email.trim().toLowerCase() ? escape(identity.email) : '';
      // One line per window keeps each countdown readable.
      const quotaLines = quota.slice(0, 2).map(window => `${color(`${quotaWindowIconLabel(window.label, escape)} ${remainingOf(window.usedPercent)}% left`, quotaTone(window.usedPercent))}${window.resetsAt ? color(` · $(clock) ${escape(resetSummary(window.resetsAt, now))}`, 'muted') : ''}`);
      const detail = [email, saved?.quotaCached ? '$(history) cached' : '', saved?.error ? escape(saved.error) : ''].filter(Boolean).join(color(' · ', 'muted'));
      const lines = [...(quotaLines.length ? quotaLines : [color('Quota unavailable', 'muted')]), ...(detail ? [color(detail, 'muted')] : [])].join('<br>');
      return row(`<td>$(account) <strong>${escape(profile.label)}</strong>${identity?.plan ? ` &nbsp;${chip(escape(identity.plan))}` : ''}<br>${lines}</td>`);
    })));
    if (profiles.length > 3) md.appendMarkdown(block(`<div>${color(`+${profiles.length - 3} more`, 'muted')}</div>`));
  }
  const notes = [
    state.accountSwitch?.status === 'running' ? `$(loading~spin) ${escape(state.accountSwitch.logs.at(-1)?.message || 'Switching account…')}` : '',
    state.accountsError ? color(`$(error) ${escape(state.accountsError)}`, 'red') : state.accountsNotice ? color(`$(check) ${escape(state.accountsNotice)}`, 'green') : '',
    state.accountsRefreshing ? color('$(loading~spin) Refreshing…', 'muted') : '',
  ].filter(Boolean);
  if (notes.length) md.appendMarkdown(block(`<div>${notes.join('<br>')}</div>`));
  return md;
}
