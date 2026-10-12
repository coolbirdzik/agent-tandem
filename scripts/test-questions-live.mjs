import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { providerTestHomes } from './provider-test-homes.mjs';

const root = process.cwd(), runtime = path.join(root, '.test-runtime', `questions-live-${Date.now()}`);
const workspace = path.join(runtime, 'workspace');
await mkdir(workspace, { recursive: true });
Object.assign(process.env, await providerTestHomes(runtime));
const bundle = path.join(runtime, 'providers.mjs');
await build({ stdin: { contents: "export { runClaudeChat } from './src/providers/claude-chat'; export { runCodexChat } from './src/providers/codex-chat';", resolveDir: root }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22' });
const { runClaudeChat, runCodexChat } = await import(pathToFileURL(bundle).href);
const checks = [];
for (const provider of ['Claude', 'Codex']) {
  const abort = new AbortController(), prompts = [], messages = [], started = Date.now();
  const timer = setTimeout(() => abort.abort(), 120000);
  const request = { requestId: `questions-${provider}`, project: workspace, provider, accessMode: 'full-access', text:
    `Test the question UI. Do not read, write, or edit files and do not run commands. Call ${provider === 'Claude' ? 'AskUserQuestion' : 'request_user_input'} exactly once with two questions: "Which rendering approach?" (header "Rendering", choices "CodeLens" / "Inset") and "Scope?" (header "Scope", choices "Pending review" / "Cumulative"). Each option needs a description. Wait for the tool answers, then repeat both selected labels in your final reply. Do not ask in plain text.` };
  const callbacks = {
    session() {}, activity() {},
    message(message) { messages.push(message); },
    async prompt(prompt, signal) {
      assert.ok(prompt.questions?.length, 'Question reaches the panel callback, not a permission prompt');
      prompts.push(prompt);
      // Leave the callback pending briefly, just as the webview does.
      await new Promise(resolve => setTimeout(resolve, 300));
      signal.throwIfAborted();
      return { id: 'live-question', answers: Object.fromEntries(prompt.questions.map(q => [q.id, q.options?.[0]?.label || 'Test answer'])) };
    },
  };
  try {
    const result = provider === 'Claude' ? await runClaudeChat(request, callbacks, abort, query) : await runCodexChat(request, callbacks, abort.signal);
    assert.equal(result, 'completed'); assert.equal(prompts.length, 1); assert.equal(prompts[0].questions.length, 2);
    const final = messages.filter(m => m.role === 'assistant').map(m => m.text).join('\n');
    for (const q of prompts[0].questions) assert.ok(final.includes(q.options[0].label), 'Agent receives and repeats the selected answer');
    const check = { provider, success: true, questions: prompts[0].questions.length, durationMs: Date.now() - started };
    checks.push(check); console.log(`AGENT_DOCK_QUESTIONS_LIVE ${JSON.stringify(check)}`);
  } finally { clearTimeout(timer); }
}
await mkdir(path.join(root, 'artifacts'), { recursive: true });
await writeFile(path.join(root, 'artifacts', 'questions-live.json'), JSON.stringify({ success: true, checks }, null, 2));
