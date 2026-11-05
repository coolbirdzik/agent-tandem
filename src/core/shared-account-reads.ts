import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderAccountStatus } from '../providers/account-status';

/** Polls run every minute; a result this recent from any window is reused. */
export const SHARED_READ_FRESH = 50000;
/** A read takes at most ~25s plus CLI start-up; a claim older than this belongs to a window that stopped. */
export const SHARED_READ_CLAIM = 40000;
/** How long a window that lost the claim waits for the result before reading itself. */
export const SHARED_READ_WAIT = 30000;
/** Opening the account picker accepts only a result this recent. */
export const SHARED_READ_RECENT = 15000;
/**
 * - `poll`: reuse a fresh result, else claim the read; a window that loses waits for the winner's result.
 * - `recent`: reuse a very recent result, else read.
 * - `none`: always read, then share the result (after a switch, sign-in or CLI change).
 */
export type SharedReadMode = 'poll' | 'recent' | 'none';
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
});
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/** Only display data the extension parsed itself: identity, quota meters, token activity. Never credentials. */
function shareable(status: ProviderAccountStatus): ProviderAccountStatus | undefined {
  if (status.status !== 'ready' || status.quotaCached || !status.account || !Number.isFinite(status.updatedAt)) return;
  return JSON.parse(JSON.stringify({ status: 'ready', account: status.account, ...(status.quota ? { quota: status.quota } : {}), ...(status.usage ? { usage: status.usage } : {}), updatedAt: status.updatedAt }));
}
function valid(value: unknown): ProviderAccountStatus | undefined {
  const row = object(value), account = object(row?.account), quota = row?.quota === undefined ? {} : object(row.quota);
  if (row?.status !== 'ready' || !account || typeof account.method !== 'string' || typeof account.signedIn !== 'boolean' || !Number.isFinite(row.updatedAt) || !quota) return;
  if (row.quota !== undefined && (typeof quota.status !== 'string' || !Array.isArray(quota.windows))) return;
  if (row.usage !== undefined && !object(row.usage)) return;
  return { ...(row as unknown as ProviderAccountStatus), quotaCached: false };
}
/**
 * Every VS Code window polls the same CLI sign-ins and saved accounts. Windows share each read through
 * small files instead of each calling the quota API, so one reading per minute is recorded.
 * Failures in this layer fall back to a normal read: coordination must never block a poll.
 */
export class SharedAccountReads {
  readonly owner = randomUUID();
  /** This window's own last result per key: a slow read finishes late, so it can look fresh at the next poll without being new. */
  private own = new Map<string, number>();
  constructor(readonly directory: string) {}
  private files(key: string) {
    const name = createHash('sha256').update(key).digest('hex').slice(0, 32);
    return { status: path.join(this.directory, `${name}.json`), claim: path.join(this.directory, `${name}.claim`) };
  }
  /** The latest shared result, if it is at most `maxAge` old. */
  async latest(key: string, maxAge: number, now = Date.now()): Promise<ProviderAccountStatus | undefined> {
    try {
      const status = valid(JSON.parse(await readFile(this.files(key).status, 'utf8')));
      return status && status.updatedAt! <= now + 5000 && now - status.updatedAt! <= maxAge ? status : undefined;
    } catch { return undefined; }
  }
  /** Exclusive create; a claim past its lifetime is taken over. Returns the time the winning claim was made. */
  async claim(key: string, now = Date.now()): Promise<{ granted: boolean; at: number }> {
    const file = this.files(key).claim;
    await mkdir(this.directory, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await writeFile(file, JSON.stringify({ owner: this.owner, at: now }), { flag: 'wx', mode: 0o600 }); return { granted: true, at: now }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      let held: { owner?: string; at?: number } = {};
      try { held = JSON.parse(await readFile(file, 'utf8')); } catch { /* Being written or removed: treat as expired. */ }
      if (held.owner === this.owner) return { granted: true, at: held.at ?? now };
      if (Number.isFinite(held.at) && now - held.at! < SHARED_READ_CLAIM && held.at! <= now + 5000) return { granted: false, at: held.at! };
      await unlink(file).catch(() => undefined);
    }
    return { granted: true, at: now };
  }
  private async claimed(key: string) {
    try { const held = JSON.parse(await readFile(this.files(key).claim, 'utf8')); return Number.isFinite(held.at) && Date.now() - held.at < SHARED_READ_CLAIM; }
    catch { return false; }
  }
  async release(key: string) {
    const file = this.files(key).claim;
    try { if (JSON.parse(await readFile(file, 'utf8')).owner === this.owner) await unlink(file); } catch { /* Already released or taken over. */ }
  }
  /** Never replaces a newer result. */
  async publish(key: string, status: ProviderAccountStatus) {
    const clean = shareable(status); if (!clean) return;
    const file = this.files(key).status, previous = await this.latest(key, Infinity);
    if (previous && previous.updatedAt! >= clean.updatedAt!) return;
    await mkdir(this.directory, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(clean), { flag: 'wx', mode: 0o600 }); await rename(temp, file); }
    catch { /* Another window may hold the file open on Windows; its own result is just as good. */ }
    finally { await unlink(temp).catch(() => undefined); }
  }
  async read(key: string, read: () => Promise<ProviderAccountStatus>, mode: SharedReadMode = 'poll', signal?: AbortSignal): Promise<ProviderAccountStatus> {
    let claimed = false;
    try {
      if (mode !== 'none') {
        const fresh = await this.latest(key, mode === 'recent' ? SHARED_READ_RECENT : SHARED_READ_FRESH);
        if (fresh && (mode === 'recent' || fresh.updatedAt !== this.own.get(key))) return fresh;
      }
      if (mode === 'poll') {
        const claim = await this.claim(key); claimed = claim.granted;
        if (!claimed) {
          const until = Date.now() + SHARED_READ_WAIT;
          while (Date.now() < until && !signal?.aborted) {
            await sleep(1000, signal);
            const shared = await this.latest(key, SHARED_READ_FRESH);
            if (shared && shared.updatedAt! >= claim.at) return shared;
            // The winner released without a result: its read failed, so read here now.
            if (!await this.claimed(key)) {
              const last = await this.latest(key, SHARED_READ_FRESH);
              if (last && last.updatedAt! >= claim.at) return last;
              break;
            }
          }
          signal?.throwIfAborted();
        }
      }
    } catch { signal?.throwIfAborted(); /* Fall back to reading. */ }
    try {
      const status = await read();
      if (Number.isFinite(status.updatedAt)) this.own.set(key, status.updatedAt!);
      await this.publish(key, status).catch(() => undefined);
      return status;
    } finally { if (claimed) await this.release(key).catch(() => undefined); }
  }
}
