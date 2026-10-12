import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { query as sdkQuery, SDKUserMessage, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { findExecutable } from './probe';
import { terminateProcessTree } from './process';
import { codexTokenActivity, type ProviderTokenActivity } from '../core/api-token-activity';
import { usageAccount } from '../core/usage-account';

export interface AccountIdentity { signedIn: boolean; id?: string; email?: string; plan?: string; organization?: string; method: string }
export interface QuotaWindow { id: string; label: string; usedPercent: number; resetsAt?: number }
export interface AccountQuota { status: 'available' | 'unavailable' | 'error'; windows: QuotaWindow[]; detail?: string; credits?: string }
/** Only display fields cross the host/webview boundary; never credentials or raw RPC payloads. */
export interface ProviderAccountStatus { status: 'loading' | 'ready' | 'error'; account?: AccountIdentity; quota?: AccountQuota; usage?: ProviderTokenActivity; updatedAt?: number; error?: string }
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const percent = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const timestamp = (value: unknown) => { const date = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(date) ? date : undefined; };
const seconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
const unavailable = (detail: string): AccountQuota => ({ status: 'unavailable', windows: [], detail });
export function codexAccount(value: unknown, routing?: unknown): AccountIdentity {
  const account = object(value);
  return { signedIn: !!text(account.type), method: account.type === 'chatgpt' ? 'ChatGPT' : account.type === 'apiKey' ? 'API key' : account.type === 'amazonBedrock' ? 'Amazon Bedrock' : text(account.type) ?? 'Not signed in',
    ...(text(account.email) ? { email: text(account.email) } : {}), ...(text(account.planType) ? { plan: text(account.planType) } : {}),
    ...(account.type === 'chatgpt' && text(object(routing).chatgptAccountId) ? { id: text(object(routing).chatgptAccountId) } : {}) };
}
function windowLabel(minutes: unknown, fallback: string) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return fallback;
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
export function codexQuota(value: unknown): AccountQuota {
  const result = object(value), primary = object(result.rateLimits), buckets = object(result.rateLimitsByLimitId);
  const primaryId = text(primary.limitId) ?? 'codex';
  const rows = new Map<string, Record<string, any>>();
  if (Object.keys(primary).length) rows.set(primaryId, primary);
  for (const [id, bucket] of Object.entries(buckets)) rows.set(id, object(bucket));
  const windows: QuotaWindow[] = [];
  for (const [id, bucket] of rows) for (const name of ['primary', 'secondary'] as const) {
    const data = object(bucket[name]), usedPercent = percent(data.usedPercent);
    if (usedPercent === undefined) continue;
    const scope = id === primaryId || id === 'codex' ? '' : `${text(bucket.limitName) ?? id} · `;
    windows.push({ id: `${id}:${name}`, label: scope + windowLabel(data.windowDurationMins, name === 'primary' ? 'Primary' : 'Secondary'), usedPercent,
      ...(seconds(data.resetsAt) ? { resetsAt: seconds(data.resetsAt) } : {}) });
  }
  const credits = object(primary.credits);
  const creditLabel = credits.unlimited === true ? 'Unlimited credits' : text(credits.balance) ? `Credits: ${text(credits.balance)}` : undefined;
  return { status: windows.length || creditLabel ? 'available' : 'unavailable', windows, ...(creditLabel ? { credits: creditLabel } : {}),
    ...(result.ordinaryUsageAllowed === false ? { detail: 'Included usage is currently unavailable.' } : !windows.length && !creditLabel ? { detail: 'This account does not report subscription quota.' } : {}) };
}
export function claudeAccount(value: unknown): AccountIdentity {
  const account = object(value), source = text(account.tokenSource), key = text(account.apiKeySource);
  const external = text(account.apiProvider) && account.apiProvider !== 'firstParty';
  const email = text(account.email), plan = text(account.subscriptionType);
  return { signedIn: !!(email || plan || external || (source && source !== 'none') || (key && key !== 'none')),
    method: external ? account.apiProvider : key && key !== 'none' && !email ? 'API key' : email || plan || (source && source !== 'none') ? 'Claude account' : 'Not signed in',
    ...(email ? { email } : {}), ...(plan ? { plan } : {}), ...(text(account.organization) ? { organization: text(account.organization) } : {}) };
}
export function claudeQuota(value: unknown): AccountQuota {
  const result = object(value), limits = object(result.rate_limits);
  if (result.rate_limits_available === false) return unavailable('Subscription quota is not available for this authentication method.');
  const windows: QuotaWindow[] = [];
  const labels: Record<string, string> = { five_hour: '5h', seven_day: '7d', seven_day_opus: 'Opus · 7d', seven_day_sonnet: 'Sonnet · 7d', seven_day_oauth_apps: 'SDK apps · 7d', seven_day_overage_included: 'Included models · 7d' };
  for (const [id, label] of Object.entries(labels)) {
    const data = object(limits[id]), usedPercent = percent(data.utilization);
    if (usedPercent !== undefined) windows.push({ id, label, usedPercent, ...(timestamp(data.resets_at) ? { resetsAt: timestamp(data.resets_at) } : {}) });
  }
  if (Array.isArray(limits.model_scoped)) limits.model_scoped.forEach((row, index) => {
    const data = object(row), usedPercent = percent(data.utilization), label = text(data.display_name);
    if (label && usedPercent !== undefined) windows.push({ id: `model:${index}`, label: `${label} · 7d`, usedPercent, ...(timestamp(data.resets_at) ? { resetsAt: timestamp(data.resets_at) } : {}) });
  });
  const extra = object(limits.extra_usage), usedPercent = percent(extra.utilization);
  if (extra.is_enabled === true && usedPercent !== undefined) windows.push({ id: 'extra_usage', label: 'Extra usage', usedPercent });
  return windows.length ? { status: 'available', windows } : unavailable('Claude Code did not return quota windows. Refresh to try again.');
}

/** Read-only RPCs: no thread, turn, or inference request. */
export async function readCodexAccount(project: string, configured = '', signal?: AbortSignal,
  launch = (executable: string) => spawn(executable, ['app-server'], { cwd: project, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })) : Promise<ProviderAccountStatus> {
  const executable = await findExecutable('codex', configured); signal?.throwIfAborted();
  const child = launch(executable), lines = createInterface({ input: child.stdout });
  child.stderr.on('data', () => undefined);
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer?: NodeJS.Timeout }>();
  let nextId = 0, failure: Error | undefined;
  const fail = (error: Error) => { failure = error; for (const p of pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  const abort = () => fail(new Error('Account refresh cancelled.'));
  const timer = setTimeout(() => fail(new Error('Account refresh timed out.')), 25000);
  signal?.addEventListener('abort', abort, { once: true });
  child.on('error', () => fail(new Error('Could not start Codex account refresh.')));
  child.on('exit', () => fail(new Error('Codex closed during account refresh.')));
  child.stdin.on('error', () => fail(new Error('Codex account connection closed.')));
  lines.on('line', line => {
    try {
      const message = JSON.parse(line), p = pending.get(message.id); if (!p) return;
      pending.delete(message.id);
      if (p.timer) clearTimeout(p.timer);
      if (message.error) p.reject(new Error('Codex could not read this account data.')); else p.resolve(message.result);
    } catch { fail(new Error('Invalid Codex account response.')); }
  });
  const call = (method: string, params: unknown, timeoutMs?: number): Promise<any> => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId, timer = timeoutMs ? setTimeout(() => { pending.delete(id); reject(new Error('Optional account query timed out.')); }, timeoutMs) : undefined;
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    if (signal?.aborted) abort();
    await call('initialize', { clientInfo: { name: 'agent_dock', title: 'AgentDock', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    // Read the current sign-in. Forcing OAuth renewal on every quota poll can
    // return a null account even when the existing session can read rate limits.
    const result = await call('account/read', { refreshToken: false }), account = codexAccount(result?.account, result?.workspaceRouting);
    let usage: ProviderTokenActivity = { source: 'API', status: 'unavailable', detail: 'Token activity requires a Codex-backed ChatGPT sign-in.' };
    let quota = unavailable(account.signedIn ? 'Subscription quota is not available for this authentication method.' : 'Sign in to view quota.');
    if (account.signedIn && account.method === 'ChatGPT') {
      try { quota = codexQuota(await call('account/rateLimits/read', {})); }
      catch { signal?.throwIfAborted(); quota = { status: 'error', windows: [], detail: 'Could not refresh quota. Try again.' }; }
      try { usage = codexTokenActivity(await call('account/usage/read', {}, 8000), usageAccount('Codex', account)?.id, Date.now()); }
      catch { signal?.throwIfAborted(); usage = { source: 'API', status: 'error', detail: 'Could not read account/usage/read. The CLI or account may not support token activity. Refresh to retry.' }; }
    }
    return { status: 'ready', account, quota, usage, updatedAt: Date.now() };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); fail(new Error('Account refresh finished.')); lines.close();
    await terminateProcessTree(child); child.stdin.end();
  }
}

/** Initialize an empty SDK input stream: listing account/usage never sends a user message. */
export async function readClaudeAccount(project: string, query: typeof sdkQuery, configured = '', signal?: AbortSignal): Promise<ProviderAccountStatus> {
  const executable = await findExecutable('claude', configured); signal?.throwIfAborted();
  const controller = new AbortController();
  let child: ChildProcessWithoutNullStreams | undefined, stream: ReturnType<typeof sdkQuery> | undefined, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  async function* input(): AsyncGenerator<SDKUserMessage> { await hold; }
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const abort = () => rejectStopped(new Error('Account refresh cancelled.'));
  const timer = setTimeout(() => rejectStopped(new Error('Account refresh timed out.')), 25000);
  signal?.addEventListener('abort', abort, { once: true });
  const bounded = <T>(job: Promise<T>) => Promise.race([job, stopped]);
  try {
    stream = query({ prompt: input(), options: {
      cwd: project, pathToClaudeCodeExecutable: executable, abortController: controller,
      settingSources: ['user', 'project', 'local'], persistSession: false,
      spawnClaudeCodeProcess: options => {
        controller.signal.throwIfAborted();
        child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
        const owned = child; owned.stderr.on('data', () => undefined);
        return { stdin: owned.stdin, stdout: owned.stdout, get killed() { return owned.killed; }, get exitCode() { return owned.exitCode; }, get signalCode() { return owned.signalCode; },
          kill() { void terminateProcessTree(owned).catch(() => undefined); return true; }, on(event, listener) { owned.on(event, listener); }, once(event, listener) { owned.once(event, listener); }, off(event, listener) { owned.off(event, listener); } } satisfies SpawnedProcess;
      },
    } });
    if (signal?.aborted) abort();
    const account = claudeAccount(await bounded(stream.accountInfo()));
    let quota = unavailable(account.signedIn ? 'Update Claude Code to read subscription quota.' : 'Sign in to view quota.');
    if (account.signedIn && typeof stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === 'function') {
      try {
        const usage = await bounded(stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
        if (text(usage.subscription_type)) account.plan = text(usage.subscription_type);
        quota = claudeQuota(usage);
      } catch { signal?.throwIfAborted(); quota = { status: 'error', windows: [], detail: 'Could not refresh quota. Try again.' }; }
    }
    return { status: 'ready', account, quota, updatedAt: Date.now() };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); stream?.close(); release();
    if (child) await terminateProcessTree(child);
  }
}
