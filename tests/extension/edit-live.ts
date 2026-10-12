import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '../../src/extension';
import type { ChatEdit } from '../../src/providers/chat';

export async function run() {
  const api = await vscode.extensions.getExtension<ExtensionAPI>('agent-dock-local.agent-dock')!.activate();
  const project = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const checks: string[] = [];
  const send = async (provider: string, text: string, edit?: ChatEdit) => {
    const timer = setTimeout(() => void vscode.commands.executeCommand('agentDock.stopChat'), 90_000);
    try {
      await vscode.commands.executeCommand('agentDock.sendChat', { requestId: randomUUID(), project, provider, text,
        conversationKey: api.conversation()?.conversation.id ? api.conversation()!.conversation.key : undefined, ...(edit ? { edit } : {}) });
      assert.equal(api.viewState().chat?.status, 'completed', api.viewState().error);
      assert.equal(api.viewState().chat?.phase, undefined);
      await api.syncConversations();
    } finally { clearTimeout(timer); }
  };
  for (const provider of ['Codex', 'Claude']) {
    const baseline = `BASE_${randomUUID().replaceAll('-', '')}`;
    const discarded = `OLD_${randomUUID().replaceAll('-', '')}`;
    const future = `FUTURE_${randomUUID().replaceAll('-', '')}`;
    await vscode.commands.executeCommand('agentDock.newChat', provider);
    await send(provider, `Remember my baseline token: ${baseline}. Reply only READY. Do not use tools or change files.`);
    await send(provider, `Replace my baseline token with ${discarded}. Reply only READY. Do not use tools or change files.`);
    await send(provider, `Replace my baseline token with ${future}. Reply only READY. Do not use tools or change files.`);
    const original = structuredClone(api.conversation()!);
    const users = original.messages.filter(message => message.role === 'user');
    assert.equal(users.length, 3);
    const editedText = 'What is my baseline token? Reply only the token. Do not use tools or change files.';
    await send(provider, editedText, { messageId: users[1]!.id, revision: original.conversation.revision });
    const branch = api.conversation()!;
    assert.notEqual(branch.conversation.key, original.conversation.key);
    assert.deepEqual(branch.messages.filter(message => message.role === 'user').map(message => message.text), [users[0]!.text, editedText]);
    const response = branch.messages.filter(message => message.role === 'assistant').at(-1)!.text;
    assert.ok(response.includes(baseline), `${provider} retained the preceding context: ${response}`);
    assert.ok(!response.includes(discarded) && !response.includes(future), 'Discarded turns are absent from the model context');
    await api.openConversation(original.conversation.key);
    assert.deepEqual(api.conversation()!.messages.filter(message => message.role === 'user').map(message => message.text), users.map(message => message.text));
    const restored = api.conversation()!;
    await send(provider, 'If I have already supplied a baseline token, reply only that token. Otherwise reply only FRESH_CONTEXT. Do not use tools or change files.',
      { messageId: restored.messages.find(message => message.role === 'user')!.id, revision: restored.conversation.revision });
    assert.notEqual(api.conversation()!.conversation.key, original.conversation.key);
    assert.equal(api.conversation()!.messages.filter(message => message.role === 'user').length, 1);
    assert.ok(api.conversation()!.messages.filter(message => message.role === 'assistant').at(-1)!.text.includes('FRESH_CONTEXT'));
    assert.equal(await readFile(path.join(project, 'sentinel.txt'), 'utf8'), 'current project bytes\n');
    assert.equal(api.viewState().review?.files.length, 0);
    checks.push(`${provider}: edited middle message branches before the target, keeps prior context, excludes target/later turns, preserves original history and current files; editing the first message starts fresh context.`);
  }
  const report = { success: true, vscode: vscode.version, checks };
  await writeFile(process.env.AGENT_DOCK_EDIT_REPORT!, JSON.stringify(report, null, 2)); console.log(`AGENT_DOCK_EDIT_LIVE ${JSON.stringify(report)}`);
}
