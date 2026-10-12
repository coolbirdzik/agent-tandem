import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { providerTestHomes } from './provider-test-homes.mjs';

const root = process.cwd(), runtime = path.join(root, '.test-runtime', `usage-accounts-live-${Date.now()}`), workspace = path.join(runtime, 'workspace');
await mkdir(workspace, { recursive: true }); Object.assign(process.env, await providerTestHomes(runtime));
const modules = {}, require = createRequire(import.meta.url);
for (const entry of ['providers/codex-chat', 'providers/claude-chat', 'providers/account-status', 'providers/usage-history', 'core/usage-account', 'core/usage-account-store', 'core/quota-estimate']) {
  const file = path.join(runtime, `${path.basename(entry)}.cjs`);
  await build({ entryPoints: [`src/${entry}.ts`], outfile: file, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
  modules[path.basename(entry)] = require(file);
}
const { usageAccount } = modules['usage-account'], { UsageAccountStore } = modules['usage-account-store'];
const ledger = new UsageAccountStore(path.join(runtime, 'usage')), checks = [];
for (const provider of ['Codex', 'Claude']) {
  const check = { provider }; checks.push(check);
  try {
    const status = provider === 'Codex' ? await modules['account-status'].readCodexAccount(workspace) : await modules['account-status'].readClaudeAccount(workspace, query);
    const identity = usageAccount(provider, status.account); assert.ok(identity, 'Native account is identifiable'); check.identityAvailable = true;
    if (status.quota?.windows.some(window => window.usedPercent >= 100 && (!window.resetsAt || window.resetsAt > Date.now()))) { check.status = 'skipped'; check.reason = 'Subscription quota exhausted'; continue; }
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 90000), writes = []; let sessionId;
    const callbacks = { session(id) { sessionId = id; }, message() {}, attributeUsage(key, account) {
      assert.equal(account.id, identity.id, 'Running CLI identity matches its native account read'); writes.push(ledger.record(key, account));
    }, async prompt() { throw new Error('The attribution test needs no tools or approval.'); } };
    const request = { requestId: `usage-${provider}`, project: workspace, provider, text: 'Reply only with OK. Do not use tools or read/change files.', accessMode: provider === 'Codex' ? 'read-only' : 'default' };
    let result;
    try { result = provider === 'Codex' ? await modules['codex-chat'].runCodexChat(request, callbacks, abort.signal) : await modules['claude-chat'].runClaudeChat(request, callbacks, abort, query); }
    finally { clearTimeout(timer); }
    assert.equal(result, 'completed'); assert.ok(sessionId); await Promise.all(writes);
    assert.ok(writes.length, 'Live turn emitted native attribution evidence');
    const history = new modules['usage-history'].UsageHistory({ codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR }, new UsageAccountStore(ledger.directory));
    const data = await history.read();
    const attributed = data.days.filter(row => row.provider === provider && row.account?.id === identity.id);
    assert.ok(attributed.length && attributed.reduce((sum, row) => sum + row.total, 0) > 0, 'Native transcript token counts join persisted account evidence');
    assert.ok(!data.days.some(row => row.provider === provider && !row.account), 'New main-thread usage is attributed');
    check.status = 'completed'; check.attributionPersisted = true; check.nativeTokenCountsScoped = true;
  } catch (error) { check.status = 'failed'; check.error = error.message; }
  finally { console.log(`AGENT_DOCK_USAGE_ACCOUNTS_LIVE ${JSON.stringify(check)}`); }
}
const success = checks.every(check => check.status === 'completed');
await mkdir(path.join(root, 'artifacts'), { recursive: true });
await writeFile(path.join(root, 'artifacts', 'usage-accounts-live.json'), JSON.stringify({ success, checks }, null, 2));
if (!success) process.exitCode = 1;
