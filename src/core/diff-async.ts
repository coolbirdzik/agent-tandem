import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { computeLineParts, computePatch, type DiffPart } from './diff-compute';

export type DiffRequest =
  | { kind: 'lines'; before: string; after: string; timeout: number }
  | { kind: 'patch'; name: string; before: string; after: string; timeout: number };
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; inline: () => unknown }

const idleMs = 30000;
let script: string | undefined, worker: Worker | undefined, idleTimer: ReturnType<typeof setTimeout> | undefined, next = 0;
const pending = new Map<number, Pending>();

/**
 * Point at the bundled worker script. Without one, or if the script cannot start, diffs run inline exactly as before,
 * so the worker is only ever an optimization.
 */
export function configureDiffWorker(file: string | undefined) {
  disposeDiffWorker();
  script = file && existsSync(file) ? file : undefined;
}
export function disposeDiffWorker() {
  clearTimeout(idleTimer); idleTimer = undefined;
  const current = worker; worker = undefined;
  // Stopping on purpose must not look like a crashed script.
  current?.removeAllListeners(); current?.on('error', () => undefined);
  settle();
  void current?.terminate();
}
/** Requests the worker can no longer answer are computed inline instead of being lost. */
function settle() {
  for (const [id, entry] of [...pending]) {
    pending.delete(id);
    try { entry.resolve(entry.inline()); } catch (error) { entry.reject(error instanceof Error ? error : new Error(String(error))); }
  }
}
function start(): Worker | undefined {
  if (worker) return worker;
  if (!script) return undefined;
  try {
    const created = new Worker(script);
    created.unref();
    let answered = false;
    created.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      answered = true;
      const entry = pending.get(message.id); pending.delete(message.id);
      if (message.error !== undefined) entry?.reject(new Error(message.error)); else entry?.resolve(message.result);
      if (!pending.size) { clearTimeout(idleTimer); idleTimer = setTimeout(disposeDiffWorker, idleMs); idleTimer.unref(); }
    });
    // A script that never ran is broken for good; a worker that ran and then died is simply replaced next time.
    const lost = () => { if (worker === created) worker = undefined; if (!answered) script = undefined; settle(); };
    created.on('error', lost); created.on('exit', lost);
    worker = created; return created;
  } catch { script = undefined; return undefined; }
}
function run<T>(request: DiffRequest, inline: () => T): Promise<T> {
  const target = start();
  if (!target) { try { return Promise.resolve(inline()); } catch (error) { return Promise.reject(error); } }
  return new Promise<T>((resolve, reject) => {
    const id = ++next;
    clearTimeout(idleTimer);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, inline });
    target.postMessage({ id, ...request });
  });
}

/** Line diff sizes, computed off the extension host thread. Undefined when it took longer than `timeout` milliseconds. */
export function diffLineParts(before: string, after: string, timeout = 1000): Promise<DiffPart[] | undefined> {
  return run({ kind: 'lines', before, after, timeout }, () => computeLineParts(before, after, timeout));
}
/** Unified patch for one file, computed off the extension host thread. Undefined when it took longer than `timeout` milliseconds. */
export function diffPatch(name: string, before: string, after: string, timeout = 1000): Promise<string | undefined> {
  return run({ kind: 'patch', name, before, after, timeout }, () => computePatch(name, before, after, timeout));
}
