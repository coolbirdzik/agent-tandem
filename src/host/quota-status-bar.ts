import * as vscode from 'vscode';
import type { ViewState } from '../core/types';
import { quotaStatuses } from '../core/quota-status';
import { STATUS_BAR_CONFIGURATION, statusBarPreferences, type StatusBarPreferences } from '../core/status-bar-preferences';
import type { ConversationProvider } from '../providers/conversations';

export function readStatusBarPreferences(config: vscode.WorkspaceConfiguration): StatusBarPreferences {
  return statusBarPreferences(Object.fromEntries(Object.entries(STATUS_BAR_CONFIGURATION).map(([key, setting]) => [key, config.get(setting)])));
}

export class QuotaStatusBar implements vscode.Disposable {
  private items = new Map<ConversationProvider, vscode.StatusBarItem>();
  private alignment?: StatusBarPreferences['alignment'];
  update(state: ViewState) {
    const config = vscode.workspace.getConfiguration('agentTandem'), preferences = readStatusBarPreferences(config);
    if (!config.get('showQuotaInStatusBar', true)) { for (const item of this.items.values()) item.hide(); return; }
    if (this.alignment !== preferences.alignment) {
      this.dispose(); this.alignment = preferences.alignment;
      for (const [index, provider] of (['Codex', 'Claude'] as const).entries()) {
        const item = vscode.window.createStatusBarItem(`agentTandem.quota.${provider.toLowerCase()}`, preferences.alignment === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right, 25 - index);
        item.name = `AgentTandem ${provider === 'Claude' ? 'Claude Code' : provider} quota`;
        item.command = { command: 'agentTandem.quickAccounts', title: 'Quota & quick account switch', arguments: [provider] }; this.items.set(provider, item);
      }
    }
    const values = quotaStatuses(state, preferences);
    for (const [provider, item] of this.items) if (!values.some(value => value.provider === provider)) item.hide();
    for (const value of values) {
      const item = this.items.get(value.provider)!; item.text = value.text; item.tooltip = value.tooltip;
      const alert = value.tone === 'exhausted' ? 'error' : value.tone === 'warning' ? 'warning' : undefined;
      item.backgroundColor = alert ? new vscode.ThemeColor(`statusBarItem.${alert}Background`) : undefined;
      // A chosen agent color replaces the quota-status color; low quota alerts still win so they stay readable.
      const custom = value.provider === 'Claude' ? preferences.claudeColor : preferences.codexColor;
      item.color = !alert && custom ? custom.startsWith('#') ? custom : new vscode.ThemeColor(custom)
        : new vscode.ThemeColor(alert ? `statusBarItem.${alert}Foreground` : value.tone === 'healthy' ? 'charts.green' : value.tone === 'loading' ? value.provider === 'Claude' ? 'charts.orange' : 'charts.blue' : 'statusBar.foreground');
      item.accessibilityInformation = { label: value.tooltip }; item.show();
    }
  }
  dispose() { for (const item of this.items.values()) item.dispose(); this.items.clear(); this.alignment = undefined; }
}
