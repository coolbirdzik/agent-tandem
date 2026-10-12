import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { providerTestHomes } from './provider-test-homes.mjs';

const root = process.cwd(), runtime = path.join(root, '.test-runtime', `cache-live-${Date.now()}`), workspace = path.join(runtime, 'workspace');
await mkdir(workspace, { recursive: true });
Object.assign(process.env, await providerTestHomes(runtime));
const modules = {};
for (const name of ['codex-chat', 'claude-chat', 'account-status']) {
  const file = path.join(runtime, `${name}.mjs`);
  await build({ entryPoints: [`src/providers/${name}.ts`], outfile: file, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
  modules[name] = await import(pathToFileURL(file).href);
}
const checks = [];
for (const provider of ['Codex', 'Claude']) {
  const check = { provider, turns: [] };
  checks.push(check);
  try {
    const account = provider === 'Codex' ? await modules['account-status'].readCodexAccount(workspace) : await modules['account-status'].readClaudeAccount(workspace, query);
    // Avoid sending paid fallback requests when included subscription usage is exhausted.
    if (account.quota?.status === 'available' && account.quota.windows.some(window => window.usedPercent >= 100 && (!window.resetsAt || window.resetsAt > Date.now()))) {
      check.status = 'skipped'; check.reason = 'Subscription quota exhausted';
      continue;
    }
    let sessionId, previousUsage;
    for (let turn = 1; turn <= 2; turn++) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 90000);
      const before = sessionId, messages = new Map();
      let usage;
      const callbacks = {
        session(id) { sessionId = id; },
        message(message, append) { messages.set(message.id, append ? (messages.get(message.id) ?? '') + message.text : message.text); },
        usage(value) { usage = value; },
        async prompt() { throw new Error('The cache smoke test must not require tools or approval.'); },
      };
      const request = { requestId: `cache-${provider}-${turn}`, project: workspace, provider,
        text: `Reply with exactly CACHE_OK_${turn}. Do not use tools or read/change files.`,
        ...(before ? { conversationKey: `${provider}:${before}` } : {}),
        accessMode: provider === 'Codex' ? 'read-only' : 'default' };
      let result;
      try {
        result = provider === 'Codex'
          ? await modules['codex-chat'].runCodexChat(request, callbacks, controller.signal)
          : await modules['claude-chat'].runClaudeChat(request, callbacks, controller, query, '', undefined, previousUsage);
      } finally { clearTimeout(timer); }
      assert.equal(result, 'completed'); assert.ok(sessionId);
      if (before) assert.equal(sessionId, before, 'The second request must resume the original native session.');
      assert.ok([...messages.values()].some(text => text.trim() === `CACHE_OK_${turn}`), 'Expected the short test reply.');
      assert.ok(usage && Number.isFinite(usage.cachedTokens), 'Native cache usage telemetry must be present.');
      check.turns.push({ turn, resumed: !!before, usage });
      previousUsage = usage;
      console.log(`AGENT_TANDEM_CACHE_TURN ${JSON.stringify({ provider, ...check.turns.at(-1) })}`);
    }
    // A miss is valid native behavior; report the observation instead of promising a hit.
    check.status = 'completed'; check.secondTurnCacheHit = check.turns[1].usage.cachedTokens > 0;
  } catch (error) { check.status = 'failed'; check.error = error.message; }
  finally { console.log(`AGENT_TANDEM_CACHE_LIVE ${JSON.stringify(check)}`); }
}
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const success = checks.every(check => check.status === 'completed');
await writeFile(path.join(root, 'artifacts/cache-live.json'), JSON.stringify({ success, checks }, null, 2));
if (!success) process.exitCode = 1;
