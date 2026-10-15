import type { ConversationProvider } from '../providers/conversations';
import type { ProviderAccountStatus } from '../providers/account-status';
import { usageAccount } from './usage-account';

export interface QuotaTick { provider: ConversationProvider; accountId: string; plan: string; windowId: string; label: string; resetsAt: number; at: number; usedPercent: number }
const tickKey = (row: QuotaTick) => JSON.stringify([row.provider, row.accountId, row.plan, row.windowId, row.resetsAt]);
export function quotaTicks(provider: ConversationProvider, status?: ProviderAccountStatus, now = Date.now()): QuotaTick[] {
  const identity = usageAccount(provider, status?.account);
  if (!identity || status?.status !== 'ready' || status.quotaCached || status.quota?.status !== 'available' || !status.updatedAt || status.updatedAt > now || now - status.updatedAt > 300000) return [];
  return status.quota.windows.filter(row => row.resetsAt && row.resetsAt > status.updatedAt! && Number.isFinite(row.usedPercent) && row.usedPercent >= 0 && row.usedPercent <= 100).map(row => ({ provider, accountId: identity.id, plan: status.account?.plan || '', windowId: row.id, label: row.label, resetsAt: row.resetsAt!, at: status.updatedAt!, usedPercent: row.usedPercent }));
}
export function quotaPace(ticks: QuotaTick[], current: QuotaTick, now = Date.now()) {
  let samples = ticks.filter(row => tickKey(row) === tickKey(current) && row.at <= current.at && row.at >= current.at - 3600000).sort((a, b) => a.at - b.at);
  const merged = new Map(samples.map(row => [row.at, row])); merged.set(current.at, current); samples = [...merged.values()].sort((a, b) => a.at - b.at);
  let correction = -1;
  for (let index = 1; index < samples.length; index++) if (samples[index]!.usedPercent < samples[index - 1]!.usedPercent) correction = index;
  if (correction >= 0) samples = samples.slice(correction);
  const first = samples[0]!, elapsed = current.at - first.at;
  const percentPerHour = samples.length >= 2 && elapsed >= 60000 ? (current.usedPercent - first.usedPercent) / elapsed * 3600000 : undefined;
  const exhaustsAt = percentPerHour && percentPerHour > 0 ? current.at + Math.max(0, 100 - current.usedPercent) / percentPerHour * 3600000 : undefined;
  return { samples, percentPerHour, exhaustsAt, stale: now - current.at > 300000, beforeReset: exhaustsAt !== undefined && exhaustsAt < current.resetsAt };
}
