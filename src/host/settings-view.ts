import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { UsageDashboardState } from '../core/usage-dashboard';
import { settingsHtml } from './settings-html';
import { webviewResource } from './webview-resource';

export class SettingsView implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private subscriptions: vscode.Disposable[] = [];
  private lastUpdate = '';
  private lastData?: UsageDashboardState['data'];
  private page: 'dashboard' | 'storage' | 'accounts' = 'dashboard';
  constructor(private extensionUri: vscode.Uri, private state: () => UsageDashboardState,
    private invoke: (command: string, value?: unknown) => Promise<unknown>, private report: (error: unknown) => void) {}
  get visible() { return !!this.panel?.visible; }
  open(page: 'dashboard' | 'storage' | 'accounts' = 'dashboard') {
    this.page = page;
    if (this.panel) { this.panel.reveal(); void this.panel.webview.postMessage(page !== 'dashboard' ? { type: 'page', page } : { type: 'dashboard' }); this.update(true); return; }
    const panel = vscode.window.createWebviewPanel('agentTandem.settings', 'AgentTandem Settings', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    this.panel = panel;
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')] };
    const resource = (folder: string, file: string) => webviewResource(webview, this.extensionUri, folder, file);
    webview.html = settingsHtml({ script: resource('dist', 'settings.js'), style: resource('media', 'settings.css'), icons: resource('media', 'codicons/codicon.css'),
      claude: resource('media', 'claude.svg'), codex: resource('media', 'codex.svg'), cspSource: webview.cspSource, nonce: randomBytes(18).toString('base64') });
    const bridge = webview.onDidReceiveMessage(async data => {
      try {
        if (!data || typeof data !== 'object') throw new Error('Invalid settings request.');
        if (data.type === 'ready') { this.update(true); if (this.page !== 'dashboard') await webview.postMessage({ type: 'page', page: this.page }); return; }
        const commands: Record<string, string> = { usageAttribution: 'agentTandem.usageAttribution', accountAction: 'agentTandem.accountAction', refresh: 'agentTandem.refreshUsageDashboard', preferences: 'agentTandem.setDashboardPreferences', chat: 'agentTandem.open', clis: 'agentTandem.manageCLIs', vscodeSettings: 'agentTandem.openVSCodeSettings', storage: 'agentTandem.refreshStorage', previewCleanup: 'agentTandem.previewStorageCleanup', cleanup: 'agentTandem.cleanupStorage', revealStorage: 'agentTandem.revealStorage', previewHistoryDeletion: 'agentTandem.previewHistoryDeletion', previewCleanAll: 'agentTandem.previewCleanAll', scanConversations: 'agentTandem.scanConversationCleanup', previewConversationCleanup: 'agentTandem.previewConversationCleanup', deleteConversations: 'agentTandem.deleteConversations', deleteHistory: 'agentTandem.deleteHistory' };
        if (!Object.hasOwn(commands, data.type)) throw new Error('Unsupported settings request.');
        await this.invoke(commands[data.type]!, data.value);
      } catch (error) { this.report(error); }
    });
    const cleanup = panel.onDidDispose(() => { bridge.dispose(); cleanup.dispose(); this.panel = undefined; });
    this.subscriptions.push(bridge, cleanup);
    this.update(true);
  }
  update(force = false) {
    if (!this.panel) return;
    const state = this.state();
    const signature = JSON.stringify([state.status, state.data?.updatedAt, state.error, state.accounts, state.storage, state.conversationCleanup, state.storageFreed, state.preferences, state.activeProvider, state.quotaHistory, state.quotaHistoryError, state.quotaBaselines, state.quotaTicks, state.managedAccounts, state.accountsBusy, state.accountsError, state.accountsNotice, state.accountSwitch, state.accountSwitchBlocked, state.conversationTitles, state.attributionBusy, state.attributionError, state.attributionNotice]);
    // Chat streaming, conversation sync and review capture don't change usage.
    if (!force && signature === this.lastUpdate && state.data === this.lastData) return;
    this.lastUpdate = signature; this.lastData = state.data;
    void this.panel.webview.postMessage({ type: 'state', state });
  }
  dispose() { this.panel?.dispose(); for (const item of this.subscriptions.splice(0)) item.dispose(); }
}
