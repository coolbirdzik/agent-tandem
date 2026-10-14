import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { withStorageLock } from '../src/core/storage-lock';

let folder: string, bundle: string, sequence = 0;
const children = new Set<ChildProcess>();
const pause = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const root = () => path.join(folder, `storage-${sequence++}`);
beforeAll(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-lock-')); bundle = path.join(folder, 'lock.mjs');
  await build({ entryPoints: ['src/core/storage-lock.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  children.clear();
});
afterAll(async () => { await rm(folder, { recursive: true, force: true }); });
async function otherWindow(directory: string) {
  const child = fork(path.resolve('tests/fixtures/storage-lock-worker.mjs'), [bundle, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.add(child);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('exit', () => reject(new Error('Lock owner exited before entering.')));
    child.once('message', () => resolve());
  });
  return child;
}

describe('Snapshot storage coordination', () => {
  it('recovers an aged ownerless lock with an empty temp left by an interrupted owner write', async () => {
    const directory = root(), lock = path.join(directory, '.snapshot-lock'), temp = path.join(lock, `${randomUUID()}.tmp`);
    await mkdir(lock, { recursive: true }); await writeFile(temp, '');
    const past = new Date(Date.now() - 120000); await utimes(temp, past, past); await utimes(lock, past, past);
    await expect(withStorageLock(directory, async () => 'recovered')).resolves.toBe('recovered');
    await expect(readFile(temp)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('times out on an ownerless nonempty lock instead of retrying forever or deleting unknown files', async () => {
    const directory = root(), lock = path.join(directory, '.snapshot-lock'), file = path.join(lock, 'unknown.txt');
    await mkdir(lock, { recursive: true }); await writeFile(file, 'keep');
    const past = new Date(Date.now() - 120000); await utimes(lock, past, past);
    const now = performance.now(), clock = vi.spyOn(performance, 'now').mockReturnValue(now);
    const waiting = withStorageLock(directory, async () => { throw new Error('Must not enter'); }); waiting.catch(() => undefined);
    await pause(); clock.mockReturnValue(now + 121000);
    await expect(waiting).rejects.toThrow('after 2 minutes');
    expect(await readFile(file, 'utf8')).toBe('keep');
  });
  it('retains a fresh unpublished owner temp while waiting for the creator', async () => {
    const directory = root(), lock = path.join(directory, '.snapshot-lock'), temp = path.join(lock, `${randomUUID()}.tmp`);
    await mkdir(lock, { recursive: true }); await writeFile(temp, '');
    const past = new Date(Date.now() - 120000); await utimes(lock, past, past);
    const now = performance.now(), clock = vi.spyOn(performance, 'now').mockReturnValue(now);
    const waiting = withStorageLock(directory, async () => { throw new Error('Must not enter'); }); waiting.catch(() => undefined);
    await pause(); clock.mockReturnValue(now + 121000);
    await expect(waiting).rejects.toThrow('after 2 minutes'); expect(await readFile(temp, 'utf8')).toBe('');
  });
  it('queues local work in FIFO order without applying the cross-window timeout to it', async () => {
    const directory = root(), entered = gate(), release = gate(), order: number[] = [];
    const first = withStorageLock(directory, async () => { order.push(1); entered.resolve(); await release.promise; });
    await entered.promise;
    const now = performance.now(), clock = vi.spyOn(performance, 'now').mockReturnValue(now);
    const second = withStorageLock(directory, async () => { order.push(2); });
    const third = withStorageLock(directory, async () => { order.push(3); });
    await pause(); clock.mockReturnValue(now + 180000); await pause();
    expect(order).toEqual([1]); release.resolve(); await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]);
  });
  it('allows nested snapshot writes and continues after an operation fails', async () => {
    const directory = root();
    const failed = withStorageLock(directory, () => withStorageLock(directory, async () => { throw new Error('capture failed'); }));
    const next = withStorageLock(directory, async () => 42);
    await expect(failed).rejects.toThrow('capture failed'); await expect(next).resolves.toBe(42);
    await expect(readFile(path.join(directory, '.snapshot-lock', 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('makes callbacks from a released async context reacquire before writing', async () => {
    const directory = root(), resume = gate(), entered = gate(), release = gate(); let detached!: Promise<void>, ran = false;
    await withStorageLock(directory, async () => {
      detached = resume.promise.then(() => withStorageLock(directory, async () => { ran = true; }));
    });
    const second = withStorageLock(directory, async () => { entered.resolve(); await release.promise; });
    await entered.promise; resume.resolve(); await pause(); expect(ran).toBe(false);
    release.resolve(); await second; await detached; expect(ran).toBe(true);
  });
  it('waits through a live capture in another process past the former 15-second limit', async () => {
    const directory = root(), child = await otherWindow(directory), now = performance.now(), date = Date.now(); let ran = false;
    const clock = vi.spyOn(performance, 'now').mockReturnValue(now), wall = vi.spyOn(Date, 'now').mockReturnValue(date);
    const waiting = withStorageLock(directory, async () => { ran = true; }); waiting.catch(() => undefined);
    await pause(); clock.mockReturnValue(now + 30000); wall.mockReturnValue(date + 30000); await pause(); expect(ran).toBe(false);
    expect(JSON.parse(await readFile(path.join(directory, '.snapshot-lock', 'owner.json'), 'utf8')).pid).toBe(child.pid);
    const exited = once(child, 'exit'); child.send('release'); await exited; await waiting; expect(ran).toBe(true);
  });
  it('retains a live owner when the cross-window wait really expires', async () => {
    const directory = root(), child = await otherWindow(directory), now = performance.now();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(now);
    const waiting = withStorageLock(directory, async () => { throw new Error('Must not enter'); }); waiting.catch(() => undefined);
    await pause(); clock.mockReturnValue(now + 121000);
    await expect(waiting).rejects.toThrow('after 2 minutes');
    expect(JSON.parse(await readFile(path.join(directory, '.snapshot-lock', 'owner.json'), 'utf8')).pid).toBe(child.pid);
    clock.mockRestore(); const exited = once(child, 'exit'); child.send('release'); await exited;
    await expect(withStorageLock(directory, async () => 'next')).resolves.toBe('next');
  });
  it('recovers the lock after its owning process crashes', async () => {
    const directory = root(), child = await otherWindow(directory), exited = once(child, 'exit');
    child.kill(); await exited;
    await expect(withStorageLock(directory, async () => 'recovered')).resolves.toBe('recovered');
  });
});
