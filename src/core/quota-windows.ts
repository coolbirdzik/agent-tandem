import type { QuotaWindow } from '../providers/account-status';

/** A native limit may arrive through both the summary and the per-limit map.
 * Keep the last value for each limit/window id; equal percentages in different
 * model-specific windows are still distinct quotas. */
export function uniqueQuotaWindows(windows: readonly QuotaWindow[] = []): QuotaWindow[] {
  return [...new Map(windows.map(window => [window.id, window])).values()];
}
