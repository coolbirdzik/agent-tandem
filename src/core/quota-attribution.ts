import type { ConversationProvider } from '../providers/conversations';
import type { QuotaTick } from './quota-pace';

/** A response can land just outside the samples around the rise it caused. */
const QUOTA_RISE_SLACK = 120000;
/** Sparse samples cannot place a rise in time, so they identify nothing. */
const QUOTA_RISE_MAX_GAP = 900000;
export interface QuotaRises { accounts: Map<string, { spans: Array<[number, number]>; latest: number }>; from: number }
export function quotaRises(ticks: QuotaTick[]) {
  const result = new Map<ConversationProvider, QuotaRises>(), previous = new Map<string, QuotaTick>();
  for (const tick of [...ticks].sort((a, b) => a.at - b.at)) {
    const rises = result.get(tick.provider) ?? { accounts: new Map(), from: tick.at + QUOTA_RISE_MAX_GAP + QUOTA_RISE_SLACK };
    result.set(tick.provider, rises);
    const key = JSON.stringify([tick.provider, tick.accountId, tick.windowId]), last = previous.get(key); previous.set(key, tick);
    const account = rises.accounts.get(tick.accountId) ?? { spans: [], latest: tick.at };
    account.latest = tick.at; rises.accounts.set(tick.accountId, account);
    if (last && tick.usedPercent > last.usedPercent && tick.at - last.at <= QUOTA_RISE_MAX_GAP) account.spans.push([last.at, tick.at]);
  }
  return result;
}
/** The one account whose quota rose around a response. Several or none identify nothing, and neither does a response that a sample yet to arrive could still cover. */
export function quotaRiseAccount(rises: QuotaRises | undefined, timestamp: number) {
  if (!rises || timestamp < rises.from) return undefined;
  const accounts = [...rises.accounts];
  if (!accounts.every(([, { latest }]) => latest > timestamp + QUOTA_RISE_SLACK || latest < timestamp - QUOTA_RISE_MAX_GAP - QUOTA_RISE_SLACK)) return undefined;
  const matches = accounts.filter(([, { spans }]) => spans.some(([from, to]) => timestamp >= from - QUOTA_RISE_SLACK && timestamp <= to + QUOTA_RISE_SLACK));
  return matches.length === 1 ? matches[0]![0] : undefined;
}
