import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it, expect } from 'vitest';
import { terminateProcessTree } from '../src/providers/process';

it('Stop kills the owned tree, stops descendant writes, and keeps an unrelated sibling running', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'agent-dock-stop-'));
  const children: ChildProcess[] = [];
  const launch = (mode: string, target: string) => {
    const child = spawn(process.execPath, [path.resolve('tests/fixtures/process-tree.mjs'), mode, target], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child); child.stdout.resume(); child.stderr.resume(); return child;
  };
  const heartbeat = async (file: string) => {
    const started = Date.now();
    while (true) {
      try { return await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() - started > 5000) throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  try {
    const root = launch('tree', folder), sibling = launch('child', path.join(folder, 'sibling.txt'));
    await heartbeat(path.join(folder, 'child.txt')); await heartbeat(path.join(folder, 'sibling.txt'));
    await terminateProcessTree(root);
    const stopped = await heartbeat(path.join(folder, 'child.txt')), stillRunning = await heartbeat(path.join(folder, 'sibling.txt'));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await heartbeat(path.join(folder, 'child.txt'))).toBe(stopped);
    expect(await heartbeat(path.join(folder, 'sibling.txt'))).not.toBe(stillRunning);
    expect(sibling.exitCode).toBeNull(); expect(root.exitCode !== null || root.signalCode !== null).toBe(true);
  } finally { await Promise.all(children.map(terminateProcessTree)); await rm(folder, { recursive: true, force: true }); }
}, 15_000);
