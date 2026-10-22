import type { ViewState } from './types';
import { bankedResetCountdown, bankedResetDetails } from './banked-resets';
import { statusBarPreferences, type StatusBarPreferences } from './status-bar-preferences';
import { uniqueQuotaWindows } from './quota-windows';
type QuotaState = Pick<ViewState, 'conversation' | 'composeProvider' | 'accounts'>;
/** Five cells (fits narrow laptop status bars) with eighth-block precision; reserve empty/full bars for the exact endpoints. */
function quotaProgress(remaining: number) {
  const steps = remaining <= 0 ? 0 : remaining >= 100 ? 40 : Math.max(1, Math.min(39, Math.round(remaining * 0.4)));
  const full = Math.floor(steps / 8), partial = '▏▎▍▌▋▊▉'[steps % 8 - 1] ?? '';
  return `${('█'.repeat(full) + partial).padEnd(5, '░')} ${Math.round(remaining * 10) / 10}%`;
}
/** Ring and column product icons in media/provider-icons.ttf, one glyph per eighth of remaining quota. */
export const QUOTA_GLYPHS = { ring: 0xE010, level: 0xE020 } as const;
function quotaGlyph(kind: keyof typeof QUOTA_GLYPHS, remaining: number) {
  return `$(agent-tandem-quota-${kind}-${remaining <= 0 ? 0 : remaining >= 100 ? 8 : Math.max(1, Math.min(7, Math.round(remaining / 12.5)))})`;
}
/** Font character for a quota product icon reference, for webviews that cannot render `$(…)`. */
export function quotaGlyphCharacter(reference: string) {
  const match = /^\$\(agent-tandem-quota-(ring|level)-([0-8])\)$/.exec(reference);
  return match ? String.fromCodePoint(QUOTA_GLYPHS[match[1] as keyof typeof QUOTA_GLYPHS] + Number(match[2])) : undefined;
}
/** Status-bar countdown: the two largest units without spaces, e.g. 2h14m or 3d4h. */
export function compactCountdown(at: number, now = Date.now()) {
  const remaining = at - now;
  if (remaining <= 0) return 'now';
  if (remaining < 60000) return '<1m';
  const total = Math.floor(remaining / 60000), days = Math.floor(total / 1440), hours = Math.floor(total % 1440 / 60), minutes = total % 60;
  return days ? `${days}d${hours ? `${hours}h` : ''}` : hours ? `${hours}h${minutes ? `${minutes}m` : ''}` : `${minutes}m`;
}
export function quotaStatus(state: QuotaState, options: Partial<StatusBarPreferences> = {}) {
  const preferences = statusBarPreferences(options);
  const provider = state.conversation?.conversation.provider ?? state.composeProvider ?? 'Codex';
  const status = state.accounts?.[provider], account = status?.account;
  const windows = uniqueQuotaWindows(status?.quota?.windows);
  const remaining = windows.length ? Math.min(...windows.map(window => Math.max(0, 100 - window.usedPercent))) : undefined;
  const tone = remaining !== undefined ? remaining === 0 ? 'exhausted' : remaining <= 10 ? 'warning' : 'healthy' : status?.status === 'loading' ? 'loading' : 'unavailable';
  const visibleWindows = preferences.quotaWindows === 'main' ? windows.slice(0, 2) : windows;
  const left = (window: typeof windows[number]) => Math.max(0, Math.min(100, 100 - window.usedPercent));
  // With quota shown, each reset rides on its own window as a clock countdown instead of repeating labels.
  const merged = preferences.style !== 'text' && preferences.fields.includes('quota') && preferences.fields.includes('reset');
  const reset = (window: typeof windows[number] | undefined) => window?.resetsAt ? `$(watch)${compactCountdown(window.resetsAt)}` : '';
  const tightest = visibleWindows.reduce<typeof windows[number] | undefined>((best, window) => !best || left(window) < left(best) ? window : best, undefined);
  // Minimal: one column per window and only the tightest percentage (and its reset); hover names each window.
  const summary = preferences.style === 'minimal' ? tightest ? `${visibleWindows.map(window => quotaGlyph('level', left(window))).join('')} ${Math.round(left(tightest))}%${merged && reset(tightest) ? ` ${reset(tightest)}` : ''}` : ''
    : visibleWindows.map(window => {
      const remaining = left(window), quota = `${window.label} ${preferences.style === 'progress' ? quotaProgress(remaining) : preferences.style === 'rings' ? `${quotaGlyph('ring', remaining)} ${Math.round(remaining)}%` : `${Math.round(remaining)}%`}`;
      return merged && reset(window) ? `${quota} ${reset(window)}` : quota;
    }).join(' · ');
  const resets = status?.quota?.bankedResets;
  const name = provider === 'Claude' ? 'Claude Code' : provider, parts: string[] = [];
  for (const field of preferences.fields) {
    if (field === 'quota') parts.push(summary || status?.quota?.credits || (status?.status === 'loading' ? '…' : 'Quota —'));
    if (field === 'reset' && !merged) parts.push(visibleWindows.filter(window => window.resetsAt).map(window => preferences.style === 'text' ? `${window.label} reset ${bankedResetCountdown(window.resetsAt!).replace(/ left$/, '')}` : `${window.label} ${reset(window)}`).join(' · ') || 'Reset —');
    if (field === 'bankedResets' && resets?.availableCount) parts.push(preferences.style === 'text' ? `${resets.availableCount} banked reset${resets.availableCount === 1 ? '' : 's'}` : `↻ ${resets.availableCount}`);
    if (field === 'account') parts.push(account?.email || account?.method || 'Account —');
    if (field === 'plan') parts.push(account?.plan || 'Plan —');
  }
  const icon = provider === 'Codex' ? 'agent-tandem-codex' : 'agent-tandem-claude';
  const label = preferences.style === 'icons' ? '' : parts.join(' · ');
  const text = `$(${icon})${label ? ` ${label}` : ''}`;
  const details = windows.map(window => `${window.label}: ${Math.round(Math.max(0, 100 - window.usedPercent) * 10) / 10}% remaining${window.resetsAt ? ` · resets ${new Date(window.resetsAt).toLocaleString()}` : ''}`).join('\n');
  return { provider, tone, icon, label, text, tooltip: [`${name}${account?.email ? ` · ${account.email}` : ''}${account?.plan ? ` · ${account.plan}` : ''}`, details || status?.quota?.detail || status?.error || 'Quota has not been reported by the selected CLI.', status?.quotaCached && status.updatedAt ? `Cached quota · ${new Date(status.updatedAt).toLocaleString()}` : undefined, status?.quotaCached ? status.error : undefined, status?.quota?.credits, ...bankedResetDetails(resets), 'Open quota & quick account switch · Open usage dashboard from menu'].filter(Boolean).join('\n') };
}

export function quotaStatuses(state: QuotaState, preferences: StatusBarPreferences) {
  const active = state.conversation?.conversation.provider ?? state.composeProvider ?? 'Codex';
  const providers = preferences.providers === 'both' ? ['Codex', 'Claude'] as const
    : [preferences.providers === 'active' ? active : preferences.providers === 'claude' ? 'Claude' : 'Codex'] as const;
  return providers.map(provider => quotaStatus({ ...state, conversation: undefined, composeProvider: provider }, preferences));
}
