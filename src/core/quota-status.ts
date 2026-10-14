import type { ViewState } from './types';
import { bankedResetDetails } from './banked-resets';
export function quotaStatus(state: Pick<ViewState, 'conversation' | 'composeProvider' | 'accounts'>) {
  const provider = state.conversation?.conversation.provider ?? state.composeProvider ?? 'Codex';
  const status = state.accounts?.[provider], account = status?.account;
  const windows = status?.quota?.windows ?? [];
  const remaining = windows.length ? Math.min(...windows.map(window => Math.max(0, 100 - window.usedPercent))) : undefined;
  const tone = remaining !== undefined ? remaining === 0 ? 'exhausted' : remaining <= 10 ? 'warning' : 'healthy' : status?.status === 'loading' ? 'loading' : 'unavailable';
  const summary = windows.slice(0, 2).map(window => `${window.label} ${Math.round(Math.max(0, 100 - window.usedPercent))}%`).join(' · ');
  const resets = status?.quota?.bankedResets;
  const text = `$(dashboard) ${provider} · ${summary || (status?.status === 'loading' ? '…' : 'Quota —')}${resets?.availableCount ? ` · ${resets.availableCount} banked resets` : ''}`;
  const details = windows.map(window => `${window.label}: ${Math.round(Math.max(0, 100 - window.usedPercent) * 10) / 10}% remaining${window.resetsAt ? ` · resets ${new Date(window.resetsAt).toLocaleString()}` : ''}`).join('\n');
  return { provider, tone, text, tooltip: [`${provider}${account?.email ? ` · ${account.email}` : ''}${account?.plan ? ` · ${account.plan}` : ''}`, details || status?.quota?.detail || 'Quota has not been reported by the selected CLI.', ...bankedResetDetails(resets), 'Open AgentTandem Settings · usage dashboard'].join('\n') };
}
