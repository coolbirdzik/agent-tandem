import type { UsageDashboardState } from './usage-dashboard';
import type { ConversationProvider } from '../providers/conversations';
import { profileIdentityKey } from './account-identity';
import { bankedResetCountdown } from './banked-resets';
import { quotaWindowIconLabel, resetSummary, quotaUsageTone } from './quota-status';
import { uniqueQuotaWindows } from './quota-windows';
import { uniqueAccountProfiles, accountProfileStatus } from './account-display';

/** The hover is raw HTML blocks, so user text is entity-encoded: no tags, no markdown links, no `$(icon)` syntax, no blank lines. */
const escape = (value: string) => value.replace(/[&<>"'$\\`*_{}\[\]()#!|]/g, char => `&#${char.charCodeAt(0)};`).replace(/[\r\n]+/g, ' ');
const colors = { blue: 'charts-blue', orange: 'charts-orange', green: 'charts-green', yellow: 'editorWarning-foreground', red: 'errorForeground', muted: 'descriptionForeground' };
const quotaTone = (used: number) => ({ exhausted: 'red', warning: 'yellow', healthy: 'green' } as const)[quotaUsageTone(used)];
const remainingOf = (used: number) => Math.round(Math.max(0, 100 - used) * 10) / 10;
const block = (html: string) => `${html}\n\n`;
const row = (...cells: string[]) => `<tr height="24">${cells.join('')}</tr>`;
// The first table pins a stable content width; later tables stretch to match it.
const table = (...rows: string[]) => block(`<table width="100%">${rows.join('')}</table>`);
const headerTable = (...rows: string[]) => block(`<table width="380">${rows.join('')}</table>`);
/** Sanitized spans cannot be sized, so the meter is a theme-neutral SVG; the colored percentage beside it carries the value. */
const meterFill = { green: '#2ea043', yellow: '#d29922', red: '#e5534b' } as const;
const meter = (remaining: number, tone: keyof typeof meterFill, webview: boolean) => {
  const width = 132, filled = Math.round(width * Math.max(0, Math.min(100, remaining)) / 100);
  const attributes = webview ? ` aria-hidden="true" viewBox="0 0 ${width} 6"` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6"${attributes}><rect width="${width}" height="6" rx="3" fill="#888" fill-opacity=".28"/>${filled ? `<rect width="${Math.max(6, filled)}" height="6" rx="3" fill="${meterFill[tone]}"/>` : ''}</svg>`;
  if (webview) return svg;
  return `<img src="data:image/svg+xml;base64,${btoa(svg)}" width="${width}" height="6" align="middle" alt="">`;
};

export type QuotaAccountHoverState = Pick<UsageDashboardState, 'accounts' | 'managedAccounts' | 'accountsRefreshing' | 'accountsError' | 'accountsNotice' | 'accountSwitch'>;

export function quotaAccountHoverHtml(provider: ConversationProvider, state: QuotaAccountHoverState, surface: 'native' | 'webview') {
  const status = state.accounts?.[provider], account = status?.account, now = Date.now();
  const webview = surface === 'webview';
  const color = (text: string, tone: keyof typeof colors) => {
    const attributes = webview ? `data-tone="${tone}"` : `style="color:var(--vscode-${colors[tone]});"`;
    return `<span ${attributes}>${text}</span>`;
  };
  const chip = (text: string) => {
    const attributes = webview ? 'class="quota-hover-plan"' : 'style="color:var(--vscode-descriptionForeground);background-color:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px;"';
    return `<span ${attributes}>&nbsp;${text}&nbsp;</span>`;
  };
  const blocks: string[] = [];
  const providerIcon = color(`$(${provider === 'Codex' ? 'agent-tandem-codex' : 'agent-tandem-claude'})`, provider === 'Codex' ? 'blue' : 'orange');
  const signedIn = account ? account.signedIn ? color('$(pass-filled) Active', 'green') : color('$(circle-slash) Signed out', 'muted') : '';
  blocks.push(headerTable(
    row(`<td>${providerIcon} <strong>${provider === 'Claude' ? 'Claude Code' : provider}</strong>${account?.plan ? ` &nbsp;${chip(escape(account.plan.replace(/_/g, ' ')))}` : ''}</td>`, `<td align="right">${signedIn}</td>`),
    account ? row(`<td colspan="2">${color(escape(account.email || account.method), 'muted')}</td>`) : ''));
  const windows = uniqueQuotaWindows(status?.quota?.windows);
  if (windows.length) blocks.push(table(...windows.map(window => {
    const remaining = remainingOf(window.usedPercent), tone = quotaTone(window.usedPercent);
    return row(`<td width="28"><strong>${quotaWindowIconLabel(window.label, escape)}</strong></td>`, `<td>${meter(remaining, tone, webview)}</td>`,
      `<td align="right">${color(`<strong>${remaining}%</strong>`, tone)} ${color('left', 'muted')}</td>`,
      `<td align="right">${window.resetsAt ? color(`$(clock) ${escape(resetSummary(window.resetsAt, now))}`, 'muted') : color('—', 'muted')}</td>`);
  })));
  if (!status?.quota?.windows.length) blocks.push(block(`<div>${color(escape(status?.quota?.detail || status?.error || 'Quota unavailable'), 'muted')}</div>`));
  if (status?.quotaCached) blocks.push(block(`<div>${color(`$(history) Cached quota${status.updatedAt ? ` · ${escape(new Date(status.updatedAt).toLocaleString())}` : ''}${status.error ? ` · ${escape(status.error)}` : ''}`, 'muted')}</div>`));
  if (provider === 'Codex' && account?.signedIn && account.method === 'ChatGPT') {
    const count = status?.quota?.bankedResets?.availableCount;
    const credits = (status?.quota?.bankedResets?.credits ?? []).slice().sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
    const expires = credits[0]?.expiresAt;
    const reset = color(`$(gift) ${count === undefined ? 'Earned resets unavailable' : count === 0 ? 'No earned resets available' : `${count} earned reset${count === 1 ? '' : 's'} available`}`, 'muted');
    blocks.push(table(row(`<td>${reset}</td>`, `<td align="right">${count && expires ? color(escape(bankedResetCountdown(expires, now)), 'muted') : ''}</td>`)));
    // One line per earned reset, soonest expiry first, so each expiry stays readable.
    if (count && credits.length) {
      blocks.push(table(...credits.slice(0, 5).map(credit => row(`<td>${color(`${escape(credit.title || 'Banked reset')} · ${credit.expiresAt ? escape(bankedResetCountdown(credit.expiresAt, now)) : 'Expiry unavailable'}`, 'muted')}</td>`))));
      if (credits.length > 5 || credits.length < count) blocks.push(block(`<div>${color(credits.length > 5 ? `+${credits.length - 5} more earned resets` : 'Expiry details shown for some resets', 'muted')}</div>`));
    }
  }
  const currentId = profileIdentityKey(provider, account);
  const profiles = uniqueAccountProfiles((state.managedAccounts ?? []).filter(row => row.provider === provider)
    .filter(row => !row.active && (!currentId || currentId !== profileIdentityKey(provider, row.identity || row.status?.account))))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (profiles.length) {
    // h5 + muted caps mirrors VS Code's own view section headers.
    blocks.push(`<hr>\n\n<h5>${color('SAVED ACCOUNTS', 'muted')}</h5>\n\n`);
    blocks.push(table(...profiles.slice(0, 3).map(profile => {
      const saved = accountProfileStatus(profile), identity = saved?.account || profile.identity, quota = uniqueQuotaWindows(saved?.quota?.windows);
      const email = identity?.email && profile.label.trim().toLowerCase() !== identity.email.trim().toLowerCase() ? escape(identity.email) : '';
      // One line per window keeps each countdown readable.
      const quotaLines = quota.slice(0, 2).map(window => `${color(`${quotaWindowIconLabel(window.label, escape)} ${remainingOf(window.usedPercent)}% left`, quotaTone(window.usedPercent))}${window.resetsAt ? color(` · $(clock) ${escape(resetSummary(window.resetsAt, now))}`, 'muted') : ''}`);
      const detail = [email, saved?.quotaCached ? '$(history) cached' : '', saved?.error ? escape(saved.error) : ''].filter(Boolean).join(color(' · ', 'muted'));
      const lines = [...(quotaLines.length ? quotaLines : [color('Quota unavailable', 'muted')]), ...(detail ? [color(detail, 'muted')] : [])].join('<br>');
      return row(`<td>$(account) <strong>${escape(profile.label)}</strong>${identity?.plan ? ` &nbsp;${chip(escape(identity.plan))}` : ''}<br>${lines}</td>`);
    })));
    if (profiles.length > 3) blocks.push(block(`<div>${color(`+${profiles.length - 3} more`, 'muted')}</div>`));
  }
  const notes = [
    state.accountSwitch?.status === 'running' ? `$(loading~spin) ${escape(state.accountSwitch.logs.at(-1)?.message || 'Switching account…')}` : '',
    state.accountsError ? color(`$(error) ${escape(state.accountsError)}`, 'red') : state.accountsNotice ? color(`$(check) ${escape(state.accountsNotice)}`, 'green') : '',
    state.accountsRefreshing ? color('$(loading~spin) Refreshing…', 'muted') : '',
  ].filter(Boolean);
  if (notes.length) blocks.push(block(`<div>${notes.join('<br>')}</div>`));
  return blocks.join('');
}
