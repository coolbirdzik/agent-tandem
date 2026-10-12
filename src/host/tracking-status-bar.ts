import * as vscode from 'vscode';
import type { ViewState } from '../core/types';
import { trackingStatus } from '../core/tracking-status';

export class TrackingStatusBar implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem('agentTandem.tracking', vscode.StatusBarAlignment.Right, 26);
  constructor() { this.item.name = 'AgentTandem change tracking'; this.item.command = 'agentTandem.trackingControls'; }
  update(state: ViewState) {
    const value = trackingStatus(state.project, vscode.workspace.isTrusted, state.review, state.reviewBusy);
    this.item.text = value.text; this.item.tooltip = value.tooltip;
    this.item.command = state.review?.files.length ? 'agentTandem.reviewLatest' : state.review?.undo ? 'agentTandem.open' : 'agentTandem.trackingControls';
    this.item.color = new vscode.ThemeColor(value.active ? 'charts.blue' : 'statusBar.foreground');
    this.item.accessibilityInformation = { label: `AgentTandem. ${value.tooltip}` }; this.item.show();
  }
  dispose() { this.item.dispose(); }
}
