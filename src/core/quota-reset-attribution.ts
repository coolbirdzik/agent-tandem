import type { ConversationProvider } from '../providers/conversations';
import type { QuotaObservation } from './quota-estimate';
import type { QuotaTick } from './quota-pace';

/**
 * A started quota window resets at a time fixed for its whole cycle, and accounts' cycles start independently.
 * Codex writes the reset times it was served beside each response, so they name the account that served it,
 * even when no sign-in or quota sample was recorded at that moment.
 * One account's readings jitter by a second or two; two accounts have been seen ten seconds apart.
 */
const RESET_TOLERANCE = 3000;
export interface QuotaReset { provider: ConversationProvider; accountId: string; minutes: number; resetsAt: number }
const UNIT = { m: 1, h: 60, d: 1440 } as const;
function labelMinutes(label: string): number | undefined {
  if (label === 'Weekly') return 10080;
  const match = /^(\d+)([mhd])$/.exec(label);
  return match ? Number(match[1]) * UNIT[match[2] as keyof typeof UNIT] : undefined;
}
/** Reset times of started windows on Codex's main limit, the only one written into transcripts. */
export function quotaResets(ticks: readonly QuotaTick[], observations: readonly QuotaObservation[]): QuotaReset[] {
  const rows: QuotaReset[] = [];
  // An unused window's reset time is "now + its length" and drifts with every reading, so it identifies nothing.
  for (const tick of ticks) {
    const minutes = labelMinutes(tick.label);
    if (tick.provider === 'Codex' && tick.windowId.startsWith('codex:') && tick.usedPercent > 0 && minutes) rows.push({ provider: tick.provider, accountId: tick.accountId, minutes, resetsAt: tick.resetsAt });
  }
  for (const row of observations) {
    const minutes = labelMinutes(row.label);
    if (row.provider === 'Codex' && row.usedPercent > 0 && minutes && Number.isFinite(row.resetsAt)) rows.push({ provider: row.provider, accountId: row.accountId, minutes, resetsAt: row.resetsAt });
  }
  return rows;
}
/** `minutes:seconds` for each started window on the main limit of a transcript's `rate_limits`, or undefined. */
export function transcriptResets(value: unknown): string | undefined {
  const limits = value && typeof value === 'object' ? value as Record<string, any> : undefined;
  if (!limits || (limits.limit_id !== undefined && limits.limit_id !== null && limits.limit_id !== 'codex')) return;
  const windows: string[] = [];
  for (const window of [limits.primary, limits.secondary]) {
    const minutes = window?.window_minutes, resetsAt = window?.resets_at, used = window?.used_percent;
    if (Number.isSafeInteger(minutes) && minutes > 0 && Number.isSafeInteger(resetsAt) && resetsAt > 0 && typeof used === 'number' && used > 0) windows.push(`${minutes}:${resetsAt}`);
  }
  return windows.length ? windows.join(',') : undefined;
}
/** The one account whose saved quota windows reset when this response's windows did. Two accounts, or windows naming different accounts, identify nothing. */
export function quotaResetResolver(resets: readonly QuotaReset[]) {
  const groups = new Map<string, QuotaReset[]>();
  for (const row of resets) {
    const key = `${row.provider}:${row.minutes}`, list = groups.get(key) ?? [];
    list.push(row); groups.set(key, list);
  }
  for (const list of groups.values()) list.sort((a, b) => a.resetsAt - b.resetsAt);
  const near = (provider: ConversationProvider, minutes: number, resetsAt: number) => {
    const list = groups.get(`${provider}:${minutes}`) ?? [], found = new Set<string>();
    let low = 0, high = list.length;
    while (low < high) { const middle = (low + high) >> 1; if (list[middle]!.resetsAt < resetsAt - RESET_TOLERANCE) low = middle + 1; else high = middle; }
    for (let index = low; index < list.length && list[index]!.resetsAt <= resetsAt + RESET_TOLERANCE; index++) found.add(list[index]!.accountId);
    return found;
  };
  return (provider: ConversationProvider, encoded: string | undefined): string | undefined => {
    if (!encoded) return;
    let candidates: Set<string> | undefined;
    for (const pair of encoded.split(',')) {
      const [minutes, seconds] = pair.split(':').map(Number);
      if (!minutes || !seconds) continue;
      const found = near(provider, minutes, seconds * 1000);
      // A window no saved reading covers says nothing either way.
      if (!found.size) continue;
      candidates = candidates ? new Set([...candidates].filter(id => found.has(id))) : found;
    }
    return candidates?.size === 1 ? [...candidates][0] : undefined;
  };
}
