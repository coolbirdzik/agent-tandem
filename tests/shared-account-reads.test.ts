import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SHARED_READ_CLAIM, SharedAccountReads } from '../src/core/shared-account-reads';
import type { ProviderAccountStatus } from '../src/providers/account-status';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function windows() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-shared-reads-')); roots.push(root);
  return [new SharedAccountReads(root), new SharedAccountReads(root)] as const;
}
const status = (usedPercent: number, updatedAt = Date.now()): ProviderAccountStatus => ({ status: 'ready', updatedAt,
  account: { signedIn: true, email: 'one@test.invalid', method: 'Claude account' }, quota: { status: 'available', windows: [{ id: 'five_hour', label: '5h', usedPercent }] } });

describe('Sharing account reads between windows', () => {
  it('reuses a fresh result from another window with its own reading time', async () => {
    const [first, second] = await windows(), reading = status(8);
    expect(await first.read('cli:Claude', async () => reading)).toBe(reading);
    const read = vi.fn(async () => status(4));
    const adopted = await second.read('cli:Claude', read);
    expect(read).not.toHaveBeenCalled();
    expect(adopted).toMatchObject({ quotaCached: false, updatedAt: reading.updatedAt, quota: { windows: [{ usedPercent: 8 }] } });
    // A window's own slow read can still look fresh at its next poll; it reads again rather than reusing it.
    const again = vi.fn(async () => status(9, reading.updatedAt! + 1));
    await first.read('cli:Claude', again); expect(again).toHaveBeenCalledOnce();
  });
  it('waits for the window that claimed the read, then uses its result', async () => {
    const [first, second] = await windows();
    let finish!: (value: ProviderAccountStatus) => void;
    const leader = first.read('cli:Claude', () => new Promise(resolve => { finish = resolve; }));
    await vi.waitFor(async () => expect((await readdir(first.directory)).some(name => name.endsWith('.claim'))).toBe(true));
    const read = vi.fn(async () => status(4)), follower = second.read('cli:Claude', read);
    setTimeout(() => finish(status(9)), 200);
    expect((await follower).quota!.windows[0]!.usedPercent).toBe(9); await leader;
    expect(read).not.toHaveBeenCalled();
    expect((await readdir(first.directory)).some(name => name.endsWith('.claim'))).toBe(false);
  });
  it('reads itself when the claiming window fails or stopped, or the shared file is corrupt', async () => {
    const [first, second] = await windows();
    const failed = first.read('cli:Codex', () => new Promise((_, reject) => setTimeout(() => reject(new Error('CLI missing')), 300)));
    await vi.waitFor(async () => expect((await readdir(first.directory)).some(name => name.endsWith('.claim'))).toBe(true));
    const read = vi.fn(async () => status(3));
    const [, own] = await Promise.all([failed.catch(() => undefined), second.read('cli:Codex', read)]);
    expect(read).toHaveBeenCalledOnce(); expect(own.quota!.windows[0]!.usedPercent).toBe(3);
    // A claim left by a window that closed mid-read expires.
    expect((await first.claim('profile:x', Date.now() - SHARED_READ_CLAIM - 1)).granted).toBe(true);
    expect((await second.claim('profile:x')).granted).toBe(true);
    expect((await first.claim('profile:x')).granted).toBe(false);
    const [file] = (await readdir(first.directory)).filter(name => name.endsWith('.json'));
    await writeFile(path.join(first.directory, file!), '{"status":"ready","account":');
    const again = vi.fn(async () => status(5));
    expect((await second.read('cli:Codex', again)).quota!.windows[0]!.usedPercent).toBe(5); expect(again).toHaveBeenCalledOnce();
  });
  it('always reads in none mode, accepts only very recent results when the picker opens, and never shares older or cached data', async () => {
    const [first, second] = await windows();
    await first.publish('cli:Claude', status(8, Date.now() - 20000));
    const recent = vi.fn(async () => status(9));
    expect((await second.read('cli:Claude', recent, 'recent')).quota!.windows[0]!.usedPercent).toBe(9); expect(recent).toHaveBeenCalledOnce();
    const forced = vi.fn(async () => status(10));
    await second.read('cli:Claude', forced, 'none'); expect(forced).toHaveBeenCalledOnce();
    await first.publish('cli:Claude', status(2, Date.now() - 60000));
    await first.publish('cli:Claude', { ...status(1), quotaCached: true });
    expect((await first.latest('cli:Claude', Infinity))!.quota!.windows[0]!.usedPercent).toBe(10);
    await first.publish('profile:error', { status: 'error', error: 'Could not refresh this sign-in.' });
    expect(await first.latest('profile:error', Infinity)).toBeUndefined();
    const saved = await Promise.all((await readdir(first.directory)).map(name => readFile(path.join(first.directory, name), 'utf8')));
    expect(saved.join('')).not.toMatch(/token|secret/i);
  });
});
