import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AccountProvider } from './account-providers';
import { profileIdentityKey } from './account-profiles';
import type { AccountIdentity, AccountQuota, ProviderAccountStatus } from '../providers/account-status';
import { withStorageLock } from './storage-lock';
import { uniqueQuotaWindows } from './quota-windows';

interface Snapshot { key: string; at: number; quota: AccountQuota }
const keyFor = (provider: AccountProvider, identity?: AccountIdentity) => {
  const id = profileIdentityKey(provider, identity);
  return id ? JSON.stringify([id, identity?.plan || '']) : undefined;
};
/** Persist display meters only, scoped to the native account, workspace and plan. */
function cleanQuota(value: any): AccountQuota | undefined {
  if (value?.status !== 'available' || !Array.isArray(value.windows)) return;
  const windows = value.windows.flatMap((row: any) => row && typeof row.id === 'string' && typeof row.label === 'string' && Number.isFinite(row.usedPercent) && row.usedPercent >= 0 && row.usedPercent <= 100
    ? [{ id: row.id, label: row.label, usedPercent: row.usedPercent, ...(Number.isFinite(row.resetsAt) ? { resetsAt: row.resetsAt } : {}) }] : []);
  const banked = value.bankedResets;
  return { status: 'available', windows: uniqueQuotaWindows(windows), ...(typeof value.credits === 'string' ? { credits: value.credits } : {}),
    ...(banked && Number.isSafeInteger(banked.availableCount) && banked.availableCount >= 0 ? { bankedResets: { availableCount: banked.availableCount,
      ...(Array.isArray(banked.credits) ? { credits: banked.credits.filter((row: any) => row && typeof row === 'object').map((row: any) => ({ ...(typeof row.title === 'string' ? { title: row.title } : {}), ...(Number.isFinite(row.expiresAt) ? { expiresAt: row.expiresAt } : {}) })) } : {}) } } : {}) };
}
export class AccountQuotaCache {
  private rows = new Map<string, Snapshot>();
  private loading?: Promise<void>;
  constructor(private root: string) {}
  private get file() { return path.join(this.root, 'quota-cache.json'); }
  private async read(): Promise<Snapshot[]> {
    try {
      const content = await readFile(this.file, 'utf8'); if (Buffer.byteLength(content) > 2 * 1024 * 1024) return [];
      const data = JSON.parse(content); if (data.version !== 1 || !Array.isArray(data.snapshots)) return [];
      return data.snapshots.flatMap((row: any): Snapshot[] => {
        const quota = cleanQuota(row?.quota);
        return quota && typeof row.key === 'string' && Number.isFinite(row.at) && row.at > 0 ? [{ key: row.key, at: row.at, quota }] : [];
      });
    } catch { return []; }
  }
  load() { return this.loading ??= this.read().then(rows => { for (const row of rows) this.rows.set(row.key, row); }); }
  restore(provider: AccountProvider, status: ProviderAccountStatus): ProviderAccountStatus {
    if (status.quota?.status === 'available' || status.quota?.status === 'unavailable') return status;
    const key = keyFor(provider, status.account), saved = key ? this.rows.get(key) : undefined;
    return saved ? { ...status, quota: saved.quota, updatedAt: saved.at, quotaCached: true } : status;
  }
  async remember(provider: AccountProvider, status: ProviderAccountStatus) {
    await this.load();
    const key = keyFor(provider, status.account);
    if (!key || status.status !== 'ready' || status.quotaCached || !status.quota || status.quota.status === 'error') return;
    const quota = cleanQuota(status.quota), at = status.updatedAt || Date.now();
    const snapshot = quota ? { key, at, quota } : undefined, previous = this.rows.get(key);
    if (snapshot && previous && previous.at > at) return;
    if (JSON.stringify(previous) === JSON.stringify(snapshot)) return;
    if (snapshot) this.rows.set(key, snapshot); else this.rows.delete(key);
    // Cache failures must not turn a verified sign-in switch into an auth failure.
    await withStorageLock(this.root, async () => {
      const rows = new Map((await this.read()).map(row => [row.key, row]));
      if (snapshot) { if ((rows.get(key)?.at || 0) <= at) rows.set(key, snapshot); } else rows.delete(key);
      const snapshots = [...rows.values()].sort((a, b) => b.at - a.at).slice(0, 512);
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify({ version: 1, snapshots }), { flag: 'wx', mode: 0o600 }); await rename(temp, this.file); }
      finally { await unlink(temp).catch(() => undefined); }
    }).catch(() => undefined);
  }
}
