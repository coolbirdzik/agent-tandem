const minute = 60000;
export const SAVED_QUOTA_REFRESH_MS = 10 * minute;

/** CLI transports may expose HTTP headers; only retain a validated retry deadline. */
export function quotaRetryAfter(error: unknown, now = Date.now()): number | undefined {
  const value = error as { headers?: Record<string, unknown> & { get?: (name: string) => unknown }; data?: { headers?: Record<string, unknown> }; retryAfterAt?: number } | undefined;
  if (Number.isFinite(value?.retryAfterAt) && value!.retryAfterAt! > now) return value!.retryAfterAt;
  const headers = value?.headers ?? value?.data?.headers;
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (typeof raw !== 'string' && typeof raw !== 'number') return;
  const seconds = Number(raw), at = String(raw).trim() && Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(String(raw));
  return Number.isFinite(at) && at > now ? at : undefined;
}

/** Automatic reads use a ten-minute cache. Manual reads cannot bypass error backoff. */
export class QuotaRefreshPolicy {
  private attempts = new Map<string, { at: number; failures: number; blockedUntil: number }>();
  start(key: string, now = Date.now()) {
    const previous = this.attempts.get(key);
    this.attempts.set(key, { at: now, failures: previous?.failures ?? 0, blockedUntil: previous?.blockedUntil ?? 0 });
  }
  due(key: string, background: boolean, updatedAt?: number, now = Date.now()) {
    const row = this.attempts.get(key);
    if (row && now < row.blockedUntil) return false;
    const at = Math.max(row?.at ?? 0, updatedAt ?? 0);
    return !at || now - at >= (background ? SAVED_QUOTA_REFRESH_MS : minute);
  }
  complete(key: string, failed: boolean, retryAfterAt?: number, now = Date.now()) {
    const failures = failed ? (this.attempts.get(key)?.failures ?? 0) + 1 : 0;
    // Jitter spreads retries between extension hosts; no immediate retry loop.
    const delay = failed ? Math.min(2 * 60 * minute, SAVED_QUOTA_REFRESH_MS * 2 ** Math.min(failures - 1, 4)) + Math.random() * 30000 : 0;
    this.attempts.set(key, { at: now, failures, blockedUntil: Math.max(now + delay, retryAfterAt ?? 0) });
  }
}
