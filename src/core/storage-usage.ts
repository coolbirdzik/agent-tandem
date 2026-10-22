import type { StorageState } from './storage';

export interface ExtensionStorageUsage {
  status: 'idle' | 'loading' | 'ready' | 'error'; total?: number; files?: number;
  categories?: StorageState['categories']; checkedAt?: number; error?: string;
  warningBytes: number;
}
export const storageWarningBytes = (megabytes: unknown) => (typeof megabytes === 'number' && Number.isFinite(megabytes) && megabytes >= 0 ? megabytes : 1024) * 1024 * 1024;
export function storageUsageLevel(usage: ExtensionStorageUsage | undefined): 'unknown' | 'normal' | 'warning' | 'critical' {
  if (usage?.total === undefined) return 'unknown';
  if (!usage.warningBytes || usage.total < usage.warningBytes) return 'normal';
  return usage.total >= usage.warningBytes * 5 ? 'critical' : 'warning';
}
export function storageSize(bytes: number) {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const unit = bytes < 1024 ** 2 ? 1 : bytes < 1024 ** 3 ? 2 : 3;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 ** unit)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}
/** Repeated background checks do not repeatedly interrupt the same user. */
export function shouldWarnStorage(usage: ExtensionStorageUsage, previous?: { at: number; warningBytes: number }, now = Date.now()) {
  return usage.status === 'ready' && ['warning', 'critical'].includes(storageUsageLevel(usage)) &&
    (!previous || previous.warningBytes !== usage.warningBytes || now - previous.at >= 24 * 3600000);
}
