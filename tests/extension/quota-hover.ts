import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import { QuotaStatusBar } from '../../src/host/quota-status-bar';
import { QuickAccounts } from '../../src/host/quick-accounts';
import type { UsageDashboardState } from '../../src/core/usage-dashboard';

/** Synthetic sign-ins and callbacks; this UI fixture never touches native credentials. */
export async function activate(context: vscode.ExtensionContext) {
  const now = Date.now(), identity = { signedIn: true, email: 'personal@example.test', method: 'ChatGPT', plan: 'plus' };
  const status = { status: 'ready' as const, account: identity, updatedAt: now, quota: { status: 'available' as const, windows: [
    { id: '5h', label: '5h', usedPercent: 76, resetsAt: now + 94 * 60000 }, { id: '7d', label: '7d', usedPercent: 38, resetsAt: now + 3 * 86400000 }],
    bankedResets: { availableCount: 2, credits: [{ title: 'Earned reset', expiresAt: now + 14 * 86400000 }] } } };
  const state: UsageDashboardState = { status: 'ready', preferences: { grouping: 'day', showQuotaInStatusBar: true }, accounts: { Codex: status }, managedAccounts: [
    { id: 'one', provider: 'Codex', label: 'Personal', identity, status, active: true, createdAt: 1 },
    { id: 'two', provider: 'Codex', label: 'Work', identity: { ...identity, email: 'work@example.test', plan: 'team' }, status: { ...status, account: { ...identity, email: 'work@example.test', plan: 'team' }, quota: { ...status.quota, windows: [{ id: '5h', label: '5h', usedPercent: 15, resetsAt: now + 2 * 3600000 }] } }, createdAt: 1 },
  ] };
  state.extensionStorage = { status: 'ready', total: 1.4 * 1024 ** 3, files: 2400, checkedAt: now, warningBytes: 1024 ** 3,
    categories: [{ label: 'Review snapshots & tracking', bytes: 1.2 * 1024 ** 3, files: 2100 }, { label: 'Chat attachments', bytes: 204.8 * 1024 ** 2, files: 300 }] };
  const actions: string[] = [], bar = new QuotaStatusBar();
  // Regression input: an old summary window and a second saved copy of Work.
  // Neither may survive as a duplicate or override the current quota in the native hover.
  status.quota.windows.unshift({ ...status.quota.windows[0]!, usedPercent: 100 });
  const work = state.managedAccounts![1]!;
  state.managedAccounts!.push({ ...work, id: 'two-old', label: 'Work old copy', status: { ...work.status!, quotaCached: true, updatedAt: now - 3600000, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 100 }] } } });
  const save = () => writeFile(process.env.AGENT_TANDEM_HOVER_REPORT!, JSON.stringify({ ready: true, actions }));
  const update = () => { bar.update({ sessions: [], providers: [], running: false, composeProvider: 'Codex', accounts: state.accounts }, state); popup.update(); };
  const record = async (action: string) => { actions.push(action); await save(); };
  const reset = async () => { status.quota.bankedResets.availableCount--; state.accountsNotice = 'Codex usage reset. One earned reset was used.'; update(); await record('reset'); };
  const popup = new QuickAccounts({ state: () => state, publish: async () => {}, refresh: async () => {}, switch: id => record(`switch:${id}`), resetUsage: reset, open: page => record(page), report: error => { void record(`error:${String(error)}`); } });
  for (const [id, callback] of Object.entries({
    'agentTandem.quickAccounts': () => popup.show('Codex'), 'agentTandem.quickSwitchAccount': (id: string) => record(`switch:${id}`),
    'agentTandem.resetCodexUsage': reset, 'agentTandem.openSettings': () => record('dashboard'),
    'agentTandem.manageAccounts': () => record('accounts'), 'agentTandem.refreshQuotaAccounts': () => record('refresh'),
    'agentTandem.openExtensionStorage': () => record('storage'),
    'agentTandem.previewReviewCleanup': (value: { scope: string }) => record(`review-preview:${value.scope}`),
  })) context.subscriptions.push(vscode.commands.registerCommand(id, callback));
  context.subscriptions.push(bar, popup); update(); await save();
}
