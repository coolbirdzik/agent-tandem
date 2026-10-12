import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, unlink, rmdir, rename } from 'node:fs/promises';
import path from 'node:path';

interface Lease { active: boolean }
const held = new AsyncLocalStorage<Map<string, Lease>>();
const queues = new Map<string, Promise<void>>();
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
/** Serialize snapshot/reference writes and cleanup across VS Code windows. */
export async function withStorageLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
  if (held.getStore()?.get(key)?.active) return operation();
  // Local work queues before attempting the cross-process lock. A long capture
  // must not cause this window's reads/writes to time out against its own PID.
  const previous = queues.get(key) ?? Promise.resolve();
  const job = previous.then(() => acquire(root, key, operation));
  const tail = job.then(() => undefined, () => undefined);
  queues.set(key, tail);
  try { return await job; }
  finally { if (queues.get(key) === tail) queues.delete(key); }
}
async function acquire<T>(root: string, key: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const directory = path.join(root, '.snapshot-lock'), ownerFile = path.join(directory, 'owner.json');
  const owner = { pid: process.pid, token: randomUUID() }, deadline = performance.now() + 120000;
  while (true) {
    try { await mkdir(directory); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Snapshot lock is not a regular directory.');
      let previous: { pid: number; token: string };
      try { previous = JSON.parse(await readFile(ownerFile, 'utf8')); }
      catch (error) {
        if (missing(error) && Date.now() - info.mtimeMs > 60000) { await rmdir(directory).catch(() => undefined); continue; }
        if (!missing(error)) throw error;
        previous = { pid: process.pid, token: '' };
      }
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || typeof previous.token !== 'string') throw new Error('Invalid snapshot lock owner.');
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (!alive && (await readFile(ownerFile, 'utf8')) === JSON.stringify(previous)) {
        await unlink(ownerFile); await rmdir(directory).catch(() => undefined); continue;
      }
    } catch (error) { if (!missing(error)) throw error; }
    if (performance.now() >= deadline) throw new Error('Snapshot storage is still in use by another capture or cleanup after 2 minutes. Wait for it to finish, then try again.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const temporaryOwner = path.join(directory, `${owner.token}.tmp`);
  const lease: Lease = { active: true };
  try {
    // Contenders must see either no owner yet or a complete JSON document.
    await writeFile(temporaryOwner, JSON.stringify(owner), { flag: 'wx' });
    await rename(temporaryOwner, ownerFile);
    return await held.run(new Map([...(held.getStore() ?? []), [key, lease]]), operation);
  } finally {
    // Detached callbacks inherit AsyncLocalStorage, but must reacquire after release.
    lease.active = false;
    await unlink(temporaryOwner).catch(error => { if (!missing(error)) throw error; });
    if (await readFile(ownerFile, 'utf8').then(value => value === JSON.stringify(owner), () => false)) await unlink(ownerFile);
    await rmdir(directory).catch(() => undefined);
  }
}
