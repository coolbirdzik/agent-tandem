import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resetCodexUsage } from '../src/providers/codex-usage-reset';

const expected = { signedIn: true, method: 'ChatGPT', id: 'fixture-account', email: 'account@example.test' };
async function run(mode: string, check: (result: ReturnType<typeof resetCodexUsage>, requests: () => Promise<any[]>) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-reset-')), log = path.join(root, 'rpc.jsonl');
  try {
    const result = resetCodexUsage(root, process.execPath, expected, 'same-redemption-key', () => spawn(process.execPath, [path.resolve('tests/fixtures/codex-reset-server.mjs')],
      { env: { ...process.env, RESET_CASE: mode, RESET_RPC_LOG: log }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), 500);
    await check(result, async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)));
  } finally { await rm(root, { recursive: true, force: true }); }
}
describe('Earned Codex usage reset', () => {
  it.each(['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'])('handles %s and reads the actual quota after redemption', async mode => run(mode, async (job, requests) => {
    const result = await job; expect(result.outcome).toBe(mode); expect(result.quota.windows[0]?.usedPercent).toBe(0);
    const calls = await requests(); expect(calls.map(row => row.method)).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume', 'account/rateLimits/read']);
    expect(calls[4].params).toEqual({ idempotencyKey: 'same-redemption-key' });
  }));
  it('refuses to redeem against a different native sign-in', async () => run('mismatch', async (job, requests) => {
    await expect(job).rejects.toThrow('sign-in changed'); expect((await requests()).some(row => row.method.includes('/consume'))).toBe(false);
  }));
  it('does not consume when a fresh API reading reports no credits', async () => run('empty', async (job, requests) => {
    expect((await job).outcome).toBe('noCredit'); expect((await requests()).some(row => row.method.includes('/consume'))).toBe(false);
  }));
  it('keeps a confirmed redemption successful if refreshing limits fails', async () => run('refresh-error', async job => {
    const result = await job; expect(result.outcome).toBe('reset'); expect(result.quota.status).toBe('error'); expect(JSON.stringify(result)).not.toContain('secret');
  }));
  it.each(['unsupported', 'timeout'])('surfaces %s without retrying or exposing raw provider errors', async mode => run(mode, async (job, requests) => {
    await expect(job).rejects.toThrow(mode === 'unsupported' ? 'Update the selected CLI' : 'timed out');
    expect((await requests()).filter(row => row.method.includes('/consume'))).toHaveLength(1);
  }));
});
