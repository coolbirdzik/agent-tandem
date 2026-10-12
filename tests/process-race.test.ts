import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: execute }));
import { terminateProcessTree } from '../src/providers/process';

it.skipIf(process.platform !== 'win32')('waits for the owned root exit when taskkill reports a descendant already exited', async () => {
  const owned = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, signalCode: null });
  const child = owned as unknown as ChildProcess;
  execute.mockImplementation((_file, args, _options, callback) => {
    expect(args).toEqual(['/PID', '123', '/T', '/F']);
    callback(new Error('Child has no running instance'));
    setTimeout(() => { owned.exitCode = 0; child.emit('exit', 0); }, 20);
  });
  await expect(terminateProcessTree(child)).resolves.toBeUndefined();
});
it.skipIf(process.platform !== 'win32')('still fails if the owned root remains alive after a failed taskkill', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 456, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  execute.mockImplementation((_file, _args, _options, callback) => callback(new Error('Access denied')));
  await expect(terminateProcessTree(child)).rejects.toThrow('Could not stop agent process 456');
});
