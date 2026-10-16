import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import { terminateProcessTree } from './process';

/** Keep native indexes consistent; unsupported CLIs fail without a filesystem fallback. */
export async function deleteCodexThread(executable: string, threadId: string,
  launch: () => ChildProcessWithoutNullStreams = () => spawn(executable, ['app-server'], { cwd: os.homedir(), windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })) {
  const child = launch(), lines = createInterface({ input: child.stdout });
  child.stderr.on('data', () => undefined);
  let next = 0, failure: Error | undefined;
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const fail = (error: Error) => { failure = error; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on('error', fail); child.stdin.on('error', fail);
  child.on('exit', () => fail(new Error('Codex exited before confirming deletion.')));
  lines.on('line', line => {
    let data; try { data = JSON.parse(line); } catch { return; }
    if (data.method) {
      if (data.id !== undefined) child.stdin.write(JSON.stringify({ id: data.id, error: { code: -32601, message: 'Interactive requests are not supported during conversation cleanup.' } }) + '\n');
      return;
    }
    const item = pending.get(data.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(data.id);
    if (data.error) item.reject(new Error(`Codex: ${data.error.message ?? 'Deletion failed.'}${data.error.code === -32601 ? ' Update the CLI to support thread/delete.' : ''}`));
    else if (Object.hasOwn(data, 'result')) item.resolve();
    else item.reject(new Error('Invalid Codex deletion response.'));
  });
  const call = (method: string, params: unknown) => new Promise<void>((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out. Refresh before retrying.`)); }, 30_000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await call('initialize', { clientInfo: { name: 'agent_tandem', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    await call('thread/delete', { threadId });
  } finally { fail(new Error('Deletion transport closed.')); lines.close(); await terminateProcessTree(child); }
}
