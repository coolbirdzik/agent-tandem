import * as vscode from 'vscode';
import type { ViewState } from '../core/types';
import { quotaStatus } from '../core/quota-status';

export class QuotaStatusBar implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem('agentDock.quota', vscode.StatusBarAlignment.Right, 25);
  constructor() { this.item.name = 'AgentDock quota'; this.item.command = 'agentDock.openSettings'; }
  update(state: ViewState) {
    if (!vscode.workspace.getConfiguration('agentDock').get('showQuotaInStatusBar', true)) { this.item.hide(); return; }
    const value = quotaStatus(state); this.item.text = value.text; this.item.tooltip = value.tooltip;
    const alert = value.tone === 'exhausted' ? 'error' : value.tone === 'warning' ? 'warning' : undefined;
    this.item.backgroundColor = alert ? new vscode.ThemeColor(`statusBarItem.${alert}Background`) : undefined;
    this.item.color = new vscode.ThemeColor(alert ? `statusBarItem.${alert}Foreground` : value.tone === 'healthy' ? 'charts.green' : value.tone === 'loading' ? value.provider === 'Claude' ? 'charts.orange' : 'charts.blue' : 'statusBar.foreground');
    this.item.accessibilityInformation = { label: value.tooltip }; this.item.show();
  }
  dispose() { this.item.dispose(); }
}
