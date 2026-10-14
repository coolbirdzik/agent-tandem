import type { ViewState } from './types';
import { bankedResetCountdown, bankedResetDetails } from './banked-resets';
import { statusBarPreferences, type StatusBarPreferences } from './status-bar-preferences';
type QuotaState = Pick<ViewState, 'conversation' | 'composeProvider' | 'accounts'>;
export function quotaStatus(state: QuotaState, options: Partial<StatusBarPreferences> = {}) {
  const preferences = statusBarPreferences(options);
  const provider = state.conversation?.conversation.provider ?? state.composeProvider ?? 'Codex';
  const status = state.accounts?.[provider], account = status?.account;
  const windows = status?.quota?.windows ?? [];
  const remaining = windows.length ? Math.min(...windows.map(window => Math.max(0, 100 - window.usedPercent))) : undefined;
  const tone = remaining !== undefined ? remaining === 0 ? 'exhausted' : remaining <= 10 ? 'warning' : 'healthy' : status?.status === 'loading' ? 'loading' : 'unavailable';
  const visibleWindows = preferences.quotaWindows === 'main' ? windows.slice(0, 2) : windows;
  const summary = visibleWindows.map(window => `${window.label} ${Math.round(Math.max(0, 100 - window.usedPercent))}%`).join(' · ');
  const resets = status?.quota?.bankedResets;
  const name = provider === 'Claude' ? 'Claude Code' : provider, parts = [name];
  for (const field of preferences.fields) {
    if (field === 'quota') parts.push(summary || status?.quota?.credits || (status?.status === 'loading' ? '…' : 'Quota —'));
    if (field === 'reset') parts.push(visibleWindows.filter(window => window.resetsAt).map(window => `${window.label} reset ${bankedResetCountdown(window.resetsAt!).replace(/ left$/, '')}`).join(' · ') || 'Reset —');
    if (field === 'bankedResets' && resets?.availableCount) parts.push(preferences.style === 'compact' ? `↻ ${resets.availableCount}` : `${resets.availableCount} banked reset${resets.availableCount === 1 ? '' : 's'}`);
    if (field === 'account') parts.push(account?.email || account?.method || 'Account —');
    if (field === 'plan') parts.push(account?.plan || 'Plan —');
  }
  const icon = preferences.style === 'text' ? 'dashboard' : provider === 'Codex' ? 'terminal' : 'sparkle';
  const label = preferences.style === 'icons' ? '' : parts.join(' · ');
  const text = `$(${icon})${label ? ` ${label}` : ''}`;
  const details = windows.map(window => `${window.label}: ${Math.round(Math.max(0, 100 - window.usedPercent) * 10) / 10}% remaining${window.resetsAt ? ` · resets ${new Date(window.resetsAt).toLocaleString()}` : ''}`).join('\n');
  return { provider, tone, icon, label, text, tooltip: [`${name}${account?.email ? ` · ${account.email}` : ''}${account?.plan ? ` · ${account.plan}` : ''}`, details || status?.quota?.detail || status?.error || 'Quota has not been reported by the selected CLI.', status?.quota?.credits, ...bankedResetDetails(resets), 'Open quota & quick account switch · Dashboard in menu'].filter(Boolean).join('\n') };
}

export function quotaStatuses(state: QuotaState, preferences: StatusBarPreferences) {
  const active = state.conversation?.conversation.provider ?? state.composeProvider ?? 'Codex';
  const providers = preferences.providers === 'both' ? ['Codex', 'Claude'] as const
    : [preferences.providers === 'active' ? active : preferences.providers === 'claude' ? 'Claude' : 'Codex'] as const;
  return providers.map(provider => quotaStatus({ ...state, conversation: undefined, composeProvider: provider }, preferences));
}
