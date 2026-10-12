import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import path from 'node:path';
import { HistoryStore } from './history';
import { StepRecorder } from './recorder';
import type { Session } from './types';

export async function runDemo(history: HistoryStore, workspace: string,
  signal: AbortSignal, changed: (session: Session) => void, delay = 450): Promise<Session> {
  const id = randomUUID();
  const root = path.join(workspace, id);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/login.ts'), 'export function validate(value: string): boolean {\r\n  return value.length > 0;\r\n}\r\n');
  await writeFile(path.join(root, 'obsolete.txt'), 'Temporary fixture\n');
  const baseline = await history.capture(root);
  const session: Session = { version: 1, id, title: 'Login validation · step demo', source: 'demo',
    createdAt: new Date().toISOString(), status: 'running', baseline: baseline.id, steps: [] };
  await history.saveSession(session);
  changed(session);
  const recorder = new StepRecorder(history, root, session, () => changed(session));
  const pause = async () => { if (delay) await setTimeout(delay, undefined, { signal }); signal.throwIfAborted(); };
  const operations: [string, () => Promise<string | void>][] = [
    ['Read login validation', async () => { await pause(); return readFile(path.join(root, 'src/login.ts'), 'utf8'); }],
    ['Trim whitespace before validation', async () => {
      await pause(); await writeFile(path.join(root, 'src/login.ts'), 'export function validate(value: string): boolean {\r\n  return value.trim().length > 0;\r\n}\r\n');
      return 'Updated src/login.ts';
    }],
    ['Set minimum length and add test', async () => {
      await pause(); await writeFile(path.join(root, 'src/login.ts'), 'export function validate(value: string): boolean {\r\n  return value.trim().length >= 3;\r\n}\r\n');
      await writeFile(path.join(root, 'src/login.test.ts'), "import { validate } from './login';\nconsole.assert(!validate('  '));\nconsole.assert(validate('abc'));\n");
      return 'Updated src/login.ts and created src/login.test.ts';
    }],
    ['Remove obsolete fixture', async () => { await pause(); await unlink(path.join(root, 'obsolete.txt')); return 'Deleted obsolete.txt'; }],
    ['Verify final file contents', async () => {
      await pause(); const source = await readFile(path.join(root, 'src/login.ts'), 'utf8');
      if (!source.includes('>= 3')) throw new Error('Unexpected final validation.');
      return 'Final source contains minimum length validation. This is a fixture check, not a provider run.';
    }],
  ];
  try {
    for (const [title, operation] of operations) {
      const step = await recorder.record(title, operation, signal);
      if (step.status !== 'completed') { session.status = step.status; break; }
    }
    if (session.status === 'running') session.status = signal.aborted ? 'interrupted' : 'completed';
  } catch (error) {
    session.status = signal.aborted ? 'interrupted' : 'failed';
    if (!signal.aborted) throw error;
  } finally { await history.saveSession(session); changed(session); }
  return session;
}
