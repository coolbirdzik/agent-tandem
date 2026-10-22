import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeAccount, claudeQuota, codexAccount, codexQuota, readClaudeAccount, readCodexAccount } from '../src/providers/account-status';
import { usageAccount } from '../src/core/usage-account';

describe('account and quota data', () => {
  it('reads banked reset counts and expiry details without exposing opaque ids or other payload fields', () => {
    const quota = codexQuota({ rateLimitResetCredits: { availableCount: 3, credits: [
      { id: 'never-expose-this', status: 'available', title: 'Full reset', expiresAt: 1791580550, accessToken: 'secret' },
      { status: 'available', title: 'Reset', expiresAt: null },
      { status: 'redeemed', title: 'Used reset', expiresAt: 1791580550 },
    ] } });
    expect(quota.status).toBe('available');
    expect(quota.bankedResets).toEqual({ availableCount: 3, credits: [{ title: 'Full reset', expiresAt: 1791580550000 }, { title: 'Reset' }] });
    expect(JSON.stringify(quota)).not.toContain('never-expose'); expect(JSON.stringify(quota)).not.toContain('secret');
  });
  it('preserves zero and count-only banked resets and leaves unsupported data unknown', () => {
    expect(codexQuota({ rateLimitResetCredits: { availableCount: 0, credits: [] } }).bankedResets).toEqual({ availableCount: 0, credits: [] });
    expect(codexQuota({ rateLimitResetCredits: { availableCount: 4, credits: null } }).bankedResets).toEqual({ availableCount: 4 });
    for (const payload of [undefined, null, {}, { availableCount: -1 }, { availableCount: 1.5 }, { availableCount: '2' }]) {
      expect(codexQuota({ rateLimitResetCredits: payload }).bankedResets).toBeUndefined();
    }
    expect(codexQuota({ rateLimitResetCredits: { availableCount: 1, credits: [{ status: 'available', expiresAt: 1e30 }] } }).bankedResets?.credits).toEqual([{}]);
  });
  it('only copies public account fields', () => {
    expect(codexAccount({ type: 'chatgpt', email: 'a@b.test', planType: 'plus', accessToken: 'secret' })).toEqual({ signedIn: true, method: 'ChatGPT', email: 'a@b.test', plan: 'plus' });
    expect(claudeAccount({ email: 'a@b.test', subscriptionType: 'pro', organization: 'Team', tokenSource: 'oauth', apiKey: 'secret' })).toEqual({ signedIn: true, method: 'Claude account', email: 'a@b.test', plan: 'pro', organization: 'Team' });
    expect(codexAccount(null).signedIn).toBe(false);
    expect(claudeAccount({ tokenSource: 'none', apiKeySource: 'none', apiProvider: 'firstParty' }).signedIn).toBe(false);
    expect(claudeAccount({ apiKeySource: 'env' }).method).toBe('API key');
  });
  it('deduplicates Codex buckets, preserves zero and converts reset seconds', () => {
    const quota = codexQuota({ rateLimits: { limitId: 'codex', primary: { usedPercent: 12 } }, rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1791580550 }, secondary: { usedPercent: 50, windowDurationMins: 10080 } },
      reserve: { limitName: 'Reserve', primary: { usedPercent: 30, windowDurationMins: 10080 } },
    } });
    expect(quota.windows).toEqual([
      { id: 'codex:primary', label: '5h', usedPercent: 0, resetsAt: 1791580550000 },
      { id: 'codex:secondary', label: '7d', usedPercent: 50 },
      { id: 'reserve:primary', label: 'Reserve · 7d', usedPercent: 30 },
    ]);
    expect(codexQuota({ rateLimits: { credits: { balance: '0' } } }).credits).toBe('Credits: 0');
    expect(codexQuota({ ordinaryUsageAllowed: false }).detail).toContain('unavailable');
  });
  it('does not turn missing quota into zero usage', () => {
    expect(codexQuota({ rateLimits: { primary: { usedPercent: null }, secondary: { usedPercent: -1 } } }).status).toBe('unavailable');
    const quota = claudeQuota({ rate_limits: { five_hour: { utilization: 0, resets_at: '2026-10-10T00:00:00Z' }, seven_day: null, seven_day_opus: { utilization: 100 }, model_scoped: [{ display_name: 'Model', utilization: 20 }], extra_usage: { is_enabled: true, utilization: 10 } } });
    expect(quota.windows.map(row => [row.label, row.usedPercent])).toEqual([['5h', 0], ['Opus · 7d', 100], ['Model · 7d', 20], ['Extra usage', 10]]);
    expect(quota.windows[0]!.resetsAt).toBe(Date.parse('2026-10-10T00:00:00Z'));
    expect(claudeQuota({ rate_limits_available: false, rate_limits: { five_hour: { utilization: 0 } } }).status).toBe('unavailable');
    expect(claudeQuota({}).windows).toEqual([]);
  });
  it('uses the native bucket id to merge a summary with aliased map entries', () => {
    const quota = codexQuota({ rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300 } }, rateLimitsByLimitId: {
      legacyAlias: { limitId: 'codex', primary: { usedPercent: 46, windowDurationMins: 300 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } },
      model: { limitId: 'model', limitName: 'Model', primary: { usedPercent: 46, windowDurationMins: 300 } },
    } });
    expect(quota.windows.map(window => [window.id, window.usedPercent])).toEqual([['codex:primary', 46], ['codex:secondary', 40], ['model:primary', 46]]);
  });
});

describe('read-only provider queries', () => {
  async function codex(mode: string, signal?: AbortSignal, refreshToken = false) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-account-')), log = path.join(directory, 'rpc.jsonl');
    const auth = path.join(directory, 'auth.json');
    await writeFile(auth, JSON.stringify({ tokens: { access_token: 'expired-private-access', refresh_token: 'original-private-refresh' } }));
    let child!: ChildProcessWithoutNullStreams;
    const job = readCodexAccount(directory, process.execPath, signal, () => child = spawn(process.execPath, [path.resolve('tests/fixtures/account-server.mjs')], {
      env: { ...process.env, CODEX_HOME: directory, ACCOUNT_CASE: mode, ACCOUNT_RPC_LOG: log }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    }), undefined, { refreshToken });
    return { job, log, auth, directory, child: () => child };
  }
  it.each(['chatgpt', 'api', 'signed-out', 'quota-error', 'quota-exit'])('reads Codex %s without creating a thread or inference', async mode => {
    const run = await codex(mode), result = await run.job;
    expect(result.status).toBe('ready');
    const methods = (await readFile(run.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
    expect(methods).toEqual(['initialize', 'initialized', 'account/read', ...(['chatgpt', 'quota-error', 'quota-exit'].includes(mode) ? ['account/rateLimits/read'] : []), ...(['chatgpt', 'quota-error'].includes(mode) ? ['account/usage/read'] : [])]);
    expect(result.quota?.status).toBe(mode === 'chatgpt' ? 'available' : mode.startsWith('quota-') ? 'error' : 'unavailable');
    expect(result.account?.signedIn).toBe(mode !== 'signed-out');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('never-expose');
    expect(run.child().exitCode !== null || run.child().signalCode !== null).toBe(true);
  });
  it.each(['chatgpt', 'usage-error', 'usage-null'])('keeps API activity separate and preserves quota when usage is %s', async mode => {
    const run = await codex(mode), result = await run.job;
    expect(result.quota?.status).toBe('available'); expect(result.usage?.source).toBe('API');
    expect(result.quota?.bankedResets).toEqual({ availableCount: 2, credits: [{ title: 'Full reset', expiresAt: 1791580550000 }] });
    expect(result.account?.id).toBe('workspace-fixture');
    if (mode === 'chatgpt') {
      expect(result.usage?.accountId).toBe(usageAccount('Codex', result.account)?.id);
      expect(result.usage?.summary?.lifetimeTokens).toBe(1000000);
      expect(result.usage?.daily).toEqual([{ day: '2026-10-09', tokens: 200000 }]);
    } else {
      expect(result.usage?.status).toBe(mode === 'usage-error' ? 'error' : 'unavailable');
      expect(result.usage?.summary?.lifetimeTokens).toBeUndefined();
    }
    expect(JSON.stringify(result)).not.toContain('secret'); expect(JSON.stringify(result)).not.toContain('never-expose');
  });
  it('reads the existing Codex sign-in and quota without forcing an OAuth token refresh', async () => {
    const run = await codex('refresh-sensitive'), result = await run.job;
    expect(result.account).toMatchObject({ signedIn: true, method: 'ChatGPT' });
    expect(result.quota).toMatchObject({ status: 'available', windows: [{ usedPercent: 25 }, { usedPercent: 50 }] });
    const requests = (await readFile(run.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.find(request => request.method === 'account/read')?.params).toEqual({ refreshToken: false });
    expect(requests.some(request => request.method === 'account/rateLimits/read')).toBe(true);
  });
  it('renews an expired saved Codex sign-in through the CLI and persists its rotated grant', async () => {
    const run = await codex('expired', undefined, true);
    try {
      const result = await run.job;
      expect(result.account).toMatchObject({ signedIn: true, email: 'account@example.test' });
      expect(result.quota?.status).toBe('available');
      expect(JSON.parse(await readFile(run.auth, 'utf8')).tokens).toEqual({ access_token: 'rotated-private-access', refresh_token: 'rotated-private-refresh' });
      const requests = (await readFile(run.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests.find(request => request.method === 'account/read')?.params).toEqual({ refreshToken: true });
      expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/usage/read']);
      expect(JSON.stringify(result)).not.toContain('private');
      expect(run.child().exitCode !== null || run.child().signalCode !== null).toBe(true);
    } finally { await rm(run.directory, { recursive: true, force: true }); }
  });
  it.each(['refresh-error', 'refresh-sensitive'])('reports an actionable safe error when token renewal fails: %s', async mode => {
    const run = await codex(mode, undefined, true);
    try {
      await expect(run.job).rejects.toThrow(/sign in again/i);
      expect(JSON.parse(await readFile(run.auth, 'utf8')).tokens.refresh_token).toBe('original-private-refresh');
      const requests = (await readFile(run.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'account/read']);
      expect(run.child().exitCode !== null || run.child().signalCode !== null).toBe(true);
    } finally { await rm(run.directory, { recursive: true, force: true }); }
  });
  it('cancels and reaps a Codex initialization that never responds', async () => {
    const abort = new AbortController(), run = await codex('hang', abort.signal);
    const cancelled = expect(run.job).rejects.toThrow('cancelled');
    setTimeout(() => abort.abort(), 200); await cancelled;
    expect(run.child().exitCode !== null || run.child().signalCode !== null).toBe(true);
  });
  it('reads Claude account/usage with an empty stream and no persisted session', async () => {
    const close = vi.fn(), usage = vi.fn(async () => ({ subscription_type: 'pro', rate_limits_available: true, rate_limits: { five_hour: { utilization: 25 } } }));
    const mock = vi.fn(() => ({ accountInfo: async () => ({ email: 'claude@example.test', tokenSource: 'oauth' }), usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage, close }));
    const result = await readClaudeAccount(process.cwd(), mock as unknown as typeof query, process.execPath);
    expect(result.account?.plan).toBe('pro'); expect(result.quota?.windows[0]?.usedPercent).toBe(25);
    expect(usage).toHaveBeenCalledWith({ skipBehaviors: true }); expect(close).toHaveBeenCalledOnce();
    const request = mock.mock.calls[0] as unknown as [{ prompt: AsyncIterable<unknown>; options: { persistSession: boolean } }];
    expect(request[0].options.persistSession).toBe(false);
    const messages = []; for await (const message of request[0].prompt) messages.push(message);
    expect(messages).toEqual([]);
  });
  it.each(['old-cli', 'quota-error', 'signed-out'])('handles Claude %s without fabricating quota', async mode => {
    const usage = vi.fn(async () => { throw new Error('secret-provider-error'); });
    const mock = (() => ({ accountInfo: async () => mode === 'signed-out' ? {} : { email: 'claude@example.test' }, close: () => undefined,
      ...(mode === 'old-cli' ? {} : { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage }) })) as unknown as typeof query;
    const result = await readClaudeAccount(process.cwd(), mock, process.execPath);
    expect(result.status).toBe('ready'); expect(result.quota?.status).toBe(mode === 'quota-error' ? 'error' : 'unavailable');
    expect(result.quota?.windows).toEqual([]); expect(JSON.stringify(result)).not.toContain('secret');
    if (mode === 'signed-out') expect(usage).not.toHaveBeenCalled();
  });
  it('closes a hung Claude account query on cancellation', async () => {
    const abort = new AbortController(), close = vi.fn();
    const mock = (() => ({ accountInfo: () => new Promise(() => undefined), close })) as unknown as typeof query;
    const result = readClaudeAccount(process.cwd(), mock, process.execPath, abort.signal);
    const cancelled = expect(result).rejects.toThrow('cancelled'); setTimeout(() => abort.abort(), 50); await cancelled;
    expect(close).toHaveBeenCalledOnce();
  });
});
