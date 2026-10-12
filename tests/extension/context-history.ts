import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { appendFile, writeFile } from 'node:fs/promises';
import type { ExtensionAPI } from '../../src/extension';

export async function run() {
  const api = await vscode.extensions.getExtension<ExtensionAPI>('agent-tandem-local.agent-tandem')!.activate();
  const index = await api.syncConversations();
  assert.equal(index.errors.length, 0);
  assert.equal(index.conversations.length, 1);
  const conversation = index.conversations[0]!;
  assert.equal(conversation.title, 'Fix context history display');
  await api.openConversation(conversation.key);
  assert.deepEqual(api.conversation()!.messages.filter(message => message.role === 'user').map(message => message.text), process.env.AGENT_TANDEM_CONTEXT_REOPEN ? ['Fix context history display', 'Add tests'] : ['Fix context history display']);
  assert.ok(api.conversation()!.messages.some(message => message.role === 'tool' && message.text.includes('<environment_context>')), 'Tool output is not filtered as synthetic user context');
  assert.ok(api.conversation()!.messages.some(message => message.role === 'assistant' && message.text.includes('<environment_context>')), 'Assistant examples stay intact');
  await vscode.commands.executeCommand('agentTandem.open');
  if (!process.env.AGENT_TANDEM_CONTEXT_REOPEN) {
    await appendFile(process.env.AGENT_TANDEM_CONTEXT_FIXTURE!, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'page-context-later', content: [{ type: 'input_text', text: '<external_codex_apps_open_page>{"page_id":"page-123"}</external_codex_apps_open_page>' }] } }) + '\n');
    await appendFile(process.env.AGENT_TANDEM_CONTEXT_FIXTURE!, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'context-later', content: [{ type: 'input_text', text: '<environment_context><cwd>H:\\Code\\aot-new</cwd><shell>powershell</shell></environment_context>' }] } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'u2', content: [{ type: 'input_text', text: 'Add tests' }] } }) + '\n');
    await api.syncConversations();
    assert.deepEqual(api.conversation()!.messages.filter(message => message.role === 'user').map(message => message.text), ['Fix context history display', 'Add tests']);
  }
  const report = { success: true, vscode: vscode.version, phase: process.env.AGENT_TANDEM_CONTEXT_REOPEN ? 'reopen' : 'initial', userMessages: api.conversation()!.messages.filter(message => message.role === 'user').length,
    checks: ['Response-only plugin/environment/open-page context is hidden; real prompts, assistant examples and tool output remain; real title and history refresh/reopen are correct.'] };
  await writeFile(process.env.AGENT_TANDEM_CONTEXT_REPORT!, JSON.stringify(report, null, 2)); console.log(`AGENT_TANDEM_CONTEXT_HISTORY ${JSON.stringify(report)}`);
}
