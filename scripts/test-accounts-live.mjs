import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { providerTestHomes } from './provider-test-homes.mjs';

const root = process.cwd(), runtime = path.join(root, '.test-runtime', `accounts-live-${Date.now()}`), workspace = path.join(runtime, 'workspace');
await mkdir(workspace, { recursive: true });
Object.assign(process.env, await providerTestHomes(runtime));
const file = path.join(runtime, 'accounts.mjs');
await build({ entryPoints: ['src/providers/account-status.ts'], outfile: file, bundle: true, platform: 'node', format: 'esm', target: 'node22' });
const { readCodexAccount, readClaudeAccount } = await import(pathToFileURL(file).href);
const checks = [];
for (const provider of ['Codex', 'Claude']) {
  const value = provider === 'Codex' ? await readCodexAccount(workspace) : await readClaudeAccount(workspace, query);
  assert.equal(value.status, 'ready'); assert.equal(value.account.signedIn, true);
  assert.ok(value.account.email || value.account.method === 'API key');
  assert.ok(value.quota && ['available', 'unavailable', 'error'].includes(value.quota.status));
  for (const window of value.quota.windows) assert.ok(Number.isFinite(window.usedPercent) && window.usedPercent >= 0);
  if (provider === 'Codex') {
    assert.equal(value.usage?.source, 'API');
    for (const row of value.usage?.daily ?? []) assert.ok(Number.isSafeInteger(row.tokens) && row.tokens >= 0);
  }
  // Reports include only presence flags and usage meters, never email or credentials.
  const check = { provider, success: true, hasEmail: !!value.account.email, plan: value.account.plan, method: value.account.method, quota: value.quota,
    ...(provider === 'Codex' ? { tokenActivitySource: value.usage?.source, tokenActivityStatus: value.usage?.status, hasLifetimeTokens: value.usage?.summary?.lifetimeTokens !== undefined, dailyBuckets: value.usage?.daily?.length ?? null } : {}) };
  checks.push(check); console.log(`AGENT_TANDEM_ACCOUNTS_LIVE ${JSON.stringify(check)}`);
}
await mkdir(path.join(root, 'artifacts'), { recursive: true });
await writeFile(path.join(root, 'artifacts/accounts-live.json'), JSON.stringify({ success: true, checks }, null, 2));
