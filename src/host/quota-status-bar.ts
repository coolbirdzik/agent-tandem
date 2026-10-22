import * as vscode from 'vscode';
import type { ViewState } from '../core/types';
import { quotaStatuses } from '../core/quota-status';
import { STATUS_BAR_CONFIGURATION, statusBarPreferences, type StatusBarPreferences } from '../core/status-bar-preferences';
import type { ConversationProvider } from '../providers/conversations';
import type { UsageDashboardState } from '../core/usage-dashboard';
import { quotaAccountHover } from './quota-account-hover';

export function readStatusBarPreferences(config: vscode.WorkspaceConfiguration): StatusBarPreferences {
  return statusBarPreferences(Object.fromEntries(Object.entries(STATUS_BAR_CONFIGURATION).map(([key, setting]) => [key, config.get(setting)])));
}

export class QuotaStatusBar implements vscode.Disposable {
  private items = new Map<ConversationProvider, vscode.StatusBarItem>();
  private rendered = new Map<ConversationProvider, string>();
  private visible = new Set<ConversationProvider>();
  private hide(provider: ConversationProvider, item: vscode.StatusBarItem) {
    if (this.visible.delete(provider)) item.hide();
  }
  private alignment?: StatusBarPreferences['alignment'];
  update(state: ViewState, dashboard?: UsageDashboardState) {
    const config = vscode.workspace.getConfiguration('agentTandem'), preferences = readStatusBarPreferences(config);
    if (!config.get('showQuotaInStatusBar', true)) { for (const [provider, item] of this.items) this.hide(provider, item); return; }
    if (this.alignment !== preferences.alignment) {
      this.dispose(); this.alignment = preferences.alignment;
      for (const [index, provider] of (['Codex', 'Claude'] as const).entries()) {
        const item = vscode.window.createStatusBarItem(`agentTandem.quota.${provider.toLowerCase()}`, preferences.alignment === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right, 25 - index);
        item.name = `AgentTandem ${provider === 'Claude' ? 'Claude Code' : provider} quota`;
        item.command = { command: 'agentTandem.quickAccounts', title: 'Quota & quick account switch', arguments: [provider] }; this.items.set(provider, item);
      }
    }
    const values = quotaStatuses(state, preferences);
    for (const [provider, item] of this.items) if (!values.some(value => value.provider === provider)) this.hide(provider, item);
    for (const value of values) {
      const item = this.items.get(value.provider)!;
      const hover = quotaAccountHover(value.provider, { ...dashboard, accounts: state.accounts });
      const signature = JSON.stringify([value, hover.value, preferences.codexColor, preferences.claudeColor]);
      const show = !this.visible.has(value.provider);
      if (this.rendered.get(value.provider) === signature) {
        if (show) { item.show(); this.visible.add(value.provider); }
        continue;
      }
      this.rendered.set(value.provider, signature);
      if (item.text !== value.text) item.text = value.text;
      if ((item.tooltip as vscode.MarkdownString | undefined)?.value !== hover.value) item.tooltip = hover;
      const alert = value.tone === 'exhausted' ? 'error' : value.tone === 'warning' ? 'warning' : undefined;
      const background = alert ? `statusBarItem.${alert}Background` : undefined;
      if (item.backgroundColor?.id !== background) item.backgroundColor = background ? new vscode.ThemeColor(background) : undefined;
      // A chosen agent color replaces the quota-status color; low quota alerts still win so they stay readable.
      const custom = value.provider === 'Claude' ? preferences.claudeColor : preferences.codexColor;
      const color = !alert && custom ? custom : alert ? `statusBarItem.${alert}Foreground` : value.tone === 'healthy' ? 'charts.green' : value.tone === 'loading' ? value.provider === 'Claude' ? 'charts.orange' : 'charts.blue' : 'statusBar.foreground';
      if ((typeof item.color === 'string' ? item.color : item.color?.id) !== color) item.color = color.startsWith('#') ? color : new vscode.ThemeColor(color);
      if (item.accessibilityInformation?.label !== value.tooltip) item.accessibilityInformation = { label: value.tooltip };
      if (show) { item.show(); this.visible.add(value.provider); }
    }
  }
  dispose() { for (const item of this.items.values()) item.dispose(); this.items.clear(); this.rendered.clear(); this.visible.clear(); this.alignment = undefined; }
}
