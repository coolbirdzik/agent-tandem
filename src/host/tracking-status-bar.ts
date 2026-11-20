import * as vscode from 'vscode';
import type { ViewState } from '../core/types';
import { trackingStatus } from '../core/tracking-status';

// Keep paths and notices literal while allowing their text to wrap in the native hover.
const hoverText = (value: string) => value.replace(/[&<>$\\`*_{}\[\]()#!|+~.\-]/g, char => `&#${char.charCodeAt(0)};`).replace(/[\r\n]+/g, ' ');

export class TrackingStatusBar implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem('agentTandem.tracking', vscode.StatusBarAlignment.Right, 26);
  constructor() { this.item.name = 'AgentTandem change tracking'; this.item.command = 'agentTandem.trackingControls'; }
  update(state: ViewState) {
    const value = trackingStatus(state.project, vscode.workspace.isTrusted, state.review, state.reviewBusy);
    const { title, action, workspace, scope, notice, controls } = value.hover;
    const hover = new vscode.MarkdownString(`$(diff) **${title}**\n\n${action}\n\n---\n\n`, true);
    if (workspace) hover.appendMarkdown(`**Workspace**  \n${hoverText(workspace)}\n\n`);
    hover.appendMarkdown(`**Change tracking**  \n${scope}`);
    if (notice) hover.appendMarkdown(`\n\n${hoverText(notice)}`);
    if (controls) hover.appendMarkdown(`\n\n${controls}`);
    this.item.text = value.text; this.item.tooltip = hover;
    this.item.command = state.review?.files.length ? 'agentTandem.reviewLatest' : state.review?.undo ? 'agentTandem.open' : 'agentTandem.trackingControls';
    this.item.color = new vscode.ThemeColor(value.active ? 'charts.blue' : 'statusBar.foreground');
    this.item.accessibilityInformation = { label: ['AgentTandem', title, action, workspace && `Workspace: ${workspace}`, scope, notice, controls].filter(Boolean).join('\n') }; this.item.show();
  }
  dispose() { this.item.dispose(); }
}
