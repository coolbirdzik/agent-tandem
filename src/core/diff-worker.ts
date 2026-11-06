import { parentPort } from 'node:worker_threads';
import { computeLineParts, computePatch } from './diff-compute';
import type { DiffRequest } from './diff-async';

// Worker entry: diffs run here so a slow comparison cannot freeze the extension host.
parentPort?.on('message', (request: DiffRequest & { id: number }) => {
  try {
    const result = request.kind === 'lines' ? computeLineParts(request.before, request.after, request.timeout)
      : computePatch(request.name, request.before, request.after, request.timeout);
    parentPort!.postMessage({ id: request.id, result });
  } catch (error) { parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
});
