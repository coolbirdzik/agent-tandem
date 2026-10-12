import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { query as sdkQuery, SDKUserMessage, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { findExecutable } from './probe';
import { terminateProcessTree } from './process';
import { modelId, type ModelChoice } from './models';
import { effortId, effortLabel } from './effort';

function effortChoices(rows: Array<{ reasoningEffort: string; description?: string }> | undefined) {
  if (!Array.isArray(rows)) return undefined;
  return [...new Map(rows.flatMap(row => {
    try { const id = effortId(row.reasoningEffort); return id ? [[id, { id, label: effortLabel(id), description: row.description }] as const] : []; } catch { return []; }
  })).values()];
}

function choices(rows: ModelChoice[]) {
  const unique = new Map<string, ModelChoice>();
  for (const row of rows) { if (modelId(row.id)) unique.set(row.id, row); }
  if (!unique.size) throw new Error('The provider returned no models. Check your sign-in and refresh.');
  return [...unique.values()];
}
/** Catalog discovery never starts a thread or inference turn. */
export async function codexModels(project: string, configured = '', signal?: AbortSignal,
  launch = (executable: string) => spawn(executable, ['app-server'], { cwd: project, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })) {
  const executable = await findExecutable('codex', configured);
  signal?.throwIfAborted();
  const child = launch(executable), lines = createInterface({ input: child.stdout });
  child.stderr.on('data', () => undefined);
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let id = 0, failure: Error | undefined;
  const fail = (error: Error) => { failure = error; for (const p of pending.values()) p.reject(error); pending.clear(); };
  const abort = () => fail(new Error('Model discovery cancelled.'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => fail(new Error('Model discovery timed out. Refresh to try again.')), 25_000);
  child.on('error', () => fail(new Error('Could not start Codex model discovery.')));
  child.on('exit', () => fail(new Error('Codex exited during model discovery.')));
  child.stdin.on('error', () => fail(new Error('Codex model connection closed.')));
  lines.on('line', line => {
    try {
      const message = JSON.parse(line), p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id);
      if (message.error) p.reject(new Error(message.error.message ?? 'Codex rejected model discovery.')); else p.resolve(message.result);
    } catch { fail(new Error('Invalid Codex model catalog response.')); }
  });
  const call = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const requestId = ++id; pending.set(requestId, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
  });
  try {
    if (signal?.aborted) abort();
    await call('initialize', { clientInfo: { name: 'agent_dock', title: 'AgentDock', version: '0.1.0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const rows: ModelChoice[] = [], seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await call('model/list', { limit: 100, cursor, includeHidden: false });
      if (!Array.isArray(page?.data)) throw new Error('Invalid Codex model catalog.');
      rows.push(...page.data.filter((row: any) => !row.hidden).map((row: any) => ({ id: row.model, label: row.displayName || row.model, description: row.description,
        ...(Array.isArray(row.supportedReasoningEfforts) ? { reasoningEfforts: effortChoices(row.supportedReasoningEfforts), defaultReasoningEffort: row.defaultReasoningEffort } : {}) })));
      cursor = page.nextCursor ?? null;
      if (cursor && seen.has(cursor)) throw new Error('Codex returned a repeated model catalog page.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return choices(rows);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); fail(new Error('Model discovery finished.')); lines.close();
    await terminateProcessTree(child); child.stdin.end();
  }
}

/** Initialize an SDK stream with no user messages, then close it after listing. */
export async function claudeModels(project: string, query: typeof sdkQuery, configured = '', signal?: AbortSignal) {
  const executable = await findExecutable('claude', configured);
  signal?.throwIfAborted();
  const controller = new AbortController();
  let child: ChildProcessWithoutNullStreams | undefined, stream: ReturnType<typeof sdkQuery> | undefined;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  async function* input(): AsyncGenerator<SDKUserMessage> { await hold; }
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const abort = () => rejectStopped(new Error('Model discovery cancelled.'));
  const timer = setTimeout(() => rejectStopped(new Error('Model discovery timed out. Refresh to try again.')), 25_000);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    stream = query({ prompt: input(), options: {
      cwd: project, pathToClaudeCodeExecutable: executable, abortController: controller,
      settingSources: ['user', 'project', 'local'], persistSession: false,
      spawnClaudeCodeProcess: options => {
        controller.signal.throwIfAborted();
        child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
        const ownedChild = child;
        ownedChild.stderr.on('data', () => undefined);
        return {
          stdin: ownedChild.stdin, stdout: ownedChild.stdout,
          get killed() { return ownedChild.killed; }, get exitCode() { return ownedChild.exitCode; }, get signalCode() { return ownedChild.signalCode; },
          kill() { void terminateProcessTree(ownedChild).catch(() => undefined); return true; },
          on(event, listener) { ownedChild.on(event, listener); }, once(event, listener) { ownedChild.once(event, listener); }, off(event, listener) { ownedChild.off(event, listener); },
        } satisfies SpawnedProcess;
      },
    } });
    if (signal?.aborted) abort();
    const rows = await Promise.race([stream.supportedModels(), stopped]);
    return choices(rows.map(row => ({ id: row.value, label: row.displayName || row.value, description: row.description,
      ...(row.supportsEffort && Array.isArray(row.supportedEffortLevels) ? { reasoningEfforts: effortChoices(row.supportedEffortLevels.map(reasoningEffort => ({ reasoningEffort }))) } : {}) })));
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    controller.abort(); stream?.close(); release();
    if (child) await terminateProcessTree(child);
  }
}
