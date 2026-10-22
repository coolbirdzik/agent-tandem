import { describe, it, expect } from 'vitest';
import { shouldWarnStorage, storageSize, storageUsageLevel, storageWarningBytes, type ExtensionStorageUsage } from '../src/core/storage-usage';

const threshold = 1024 ** 3, now = Date.now();
const usage = (total: number): ExtensionStorageUsage => ({ status: 'ready', total, warningBytes: threshold });
describe('Extension storage usage alerts', () => {
  it('uses actual extension bytes, warns at the threshold and distinguishes high usage', () => {
    expect(storageUsageLevel(undefined)).toBe('unknown');
    expect(storageUsageLevel(usage(threshold - 1))).toBe('normal');
    expect(storageUsageLevel(usage(threshold))).toBe('warning');
    expect(storageUsageLevel(usage(threshold * 5))).toBe('critical');
    expect(storageUsageLevel({ ...usage(threshold * 10), warningBytes: 0 })).toBe('normal');
    expect(storageSize(threshold)).toBe('1 GB'); expect(storageSize(0)).toBe('0 B');
  });
  it('notifies at most once a day and allows disabling or changing the alert threshold', () => {
    expect(shouldWarnStorage(usage(threshold), undefined, now)).toBe(true);
    const previous = { at: now, warningBytes: threshold };
    expect(shouldWarnStorage(usage(threshold * 6), previous, now + 60000)).toBe(false);
    expect(shouldWarnStorage(usage(threshold), previous, now + 86400000)).toBe(true);
    expect(shouldWarnStorage({ ...usage(threshold), status: 'error' }, undefined, now)).toBe(false);
    expect(shouldWarnStorage({ ...usage(threshold), warningBytes: 0 }, undefined, now)).toBe(false);
    expect(shouldWarnStorage({ ...usage(threshold), warningBytes: threshold / 2 }, previous, now)).toBe(true);
    expect(storageWarningBytes(undefined)).toBe(threshold); expect(storageWarningBytes(-1)).toBe(threshold);
    expect(storageWarningBytes(0)).toBe(0); expect(storageWarningBytes(512)).toBe(threshold / 2);
  });
});
