import * as vscode from 'vscode';
import type { ViewState } from '../core/types';
import { trackingStatus } from '../core/tracking-status';

export class TrackingStatusBar implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem('agentDock.tracking', vscode.StatusBarAlignment.Right, 26);
  constructor() { this.item.name = 'AgentDock change tracking'; this.item.command = 'agentDock.trackingControls'; }
  update(state: ViewState) {
    const value = trackingStatus(state.project, vscode.workspace.isTrusted, state.review, state.reviewBusy);
    this.item.text = value.text; this.item.tooltip = value.tooltip;
    this.item.command = state.review?.files.length ? 'agentDock.reviewLatest' : state.review?.undo ? 'agentDock.open' : 'agentDock.trackingControls';
    this.item.color = new vscode.ThemeColor(value.active ? 'charts.blue' : 'statusBar.foreground');
    this.item.accessibilityInformation = { label: `AgentDock. ${value.tooltip}` }; this.item.show();
  }
  dispose() { this.item.dispose(); }
}
