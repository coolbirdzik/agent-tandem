import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execute = promisify(execFile);
const stopping = new WeakMap<ChildProcess, Promise<void>>();

/** Only terminate the process we spawned and its descendants, never by name. */
export function terminateProcessTree(child: ChildProcess): Promise<void> {
  const existing = stopping.get(child); if (existing) return existing;
  const job = (async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    let stopError: Error | undefined;
    if (process.platform === 'win32') {
      try {
        await execute(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      } catch (error) {
        // taskkill can return failure for a descendant that exited while it
        // was walking the tree, before Node delivers the root's exit event.
        // Wait for that event; a root that remains alive still fails below.
        stopError = new Error(`Could not stop agent process ${child.pid}: ${(error as Error).message}`);
      }
    } else {
      // Local provider launches use their own process group on POSIX.
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(stopError ?? new Error('Agent process did not stop.')), 2000); })]); }
    finally { if (timer) clearTimeout(timer); }
  })();
  stopping.set(child, job); return job;
}
