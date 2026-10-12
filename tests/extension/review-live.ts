import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile, writeFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '../../src/extension';

export async function run() {
  const extension = vscode.extensions.getExtension<ExtensionAPI>('agent-tandem-local.agent-tandem')!;
  const api = await extension.activate();
  const project = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const file = (name: string) => path.join(project, name);
  const text = async (name: string) => (await readFile(file(name), 'utf8'));
  const request = (name?: string) => ({ project, revision: api.viewState().review!.revision, file: name });
  const report = process.env.AGENT_TANDEM_REVIEW_REPORT!;
  if (process.env.AGENT_TANDEM_TEST_PHASE === 'reopen') {
    assert.equal(api.viewState().review?.files.length, 3, 'Unaccepted changes survive a new Extension Host');
    assert.equal(await text('edited.ts'), "export const mode = 'after';\n");
    await vscode.commands.executeCommand('agentTandem.previewReview', request('edited.ts'));
    const diff = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(diff instanceof vscode.TabInputTextDiff);
    assert.match((await vscode.workspace.openTextDocument(diff.original)).getText(), /before/);
    assert.match((await vscode.workspace.openTextDocument(diff.modified)).getText(), /after/);
    await vscode.commands.executeCommand('agentTandem.acceptChanges', request('edited.ts'));
    assert.equal(api.viewState().review?.files.length, 2);
    assert.equal(await text('edited.ts'), "export const mode = 'after';\n", 'Accept leaves already applied bytes intact');
    await vscode.commands.executeCommand('agentTandem.revertChanges', request());
    assert.equal(api.viewState().review?.files.length, 0);
    assert.equal(await text('deleted.txt'), 'keep original\n');
    await assert.rejects(readFile(file('added.txt')), { code: 'ENOENT' });
    const prior = JSON.parse(await readFile(report, 'utf8'));
    prior.success = true; prior.checks.push('Pending review survives restart; real diff, Accept one, Revert all work through VS Code commands');
    await writeFile(report, JSON.stringify(prior, null, 2)); console.log(`AGENT_TANDEM_REVIEW_LIVE ${JSON.stringify(prior)}`); return;
  }
  await vscode.commands.executeCommand('agentTandem.open');
  const checks: string[] = [];
  for (const provider of ['Codex', 'Claude']) {
    await writeFile(file('edited.ts'), "export const mode = 'before';\n"); await writeFile(file('deleted.txt'), 'keep original\n');
    await unlink(file('added.txt')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await vscode.commands.executeCommand('agentTandem.newChat', provider);
    const phases = new Set<string>(), tools = new Set<string>();
    const observeActivity = setInterval(() => {
      const chat = api.viewState().chat;
      if (chat?.phase) phases.add(chat.phase);
      if (chat?.activity) tools.add(chat.activity);
    }, 20);
    const timeout = setTimeout(() => void vscode.commands.executeCommand('agentTandem.stopChat'), 90_000);
    const answerPrompts = setInterval(() => {
      for (const prompt of api.viewState().chat?.prompts ?? []) {
        // The agent is instructed to write only the three named fixture files.
        void vscode.commands.executeCommand('agentTandem.answerAgent', { id: prompt.id, allow: true }).then(undefined, () => undefined);
      }
    }, 250);
    try {
      console.log(`AGENT_TANDEM_REVIEW_LIVE starting ${provider} in disposable workspace`);
      await vscode.commands.executeCommand('agentTandem.sendChat', { requestId: randomUUID(), project, provider,
        text: "In the current disposable test workspace, modify only these three files: overwrite edited.ts with exactly `export const mode = 'after';` followed by one newline; create added.txt with exactly `new file` followed by one newline; delete deleted.txt. Use your file tools, do not delegate, and do not modify anything outside this workspace. Finish with Done." });
    } finally { clearTimeout(timeout); clearInterval(answerPrompts); clearInterval(observeActivity); }
    assert.equal(api.viewState().chat?.status, 'completed', api.viewState().error);
    assert.ok(phases.has('working'), `${provider} exposes its working phase while inference is active`);
    assert.ok(tools.size > 0, `${provider} exposes real tool activity while working`);
    assert.equal(api.viewState().chat?.phase, undefined, 'Working effects finish after review capture');
    assert.equal(api.viewState().chat?.activity, undefined, 'Completed tool activity is cleared');
    assert.equal(await text('edited.ts'), "export const mode = 'after';\n"); assert.equal(await text('added.txt'), 'new file\n');
    await assert.rejects(readFile(file('deleted.txt')), { code: 'ENOENT' });
    assert.deepEqual(api.viewState().review?.files.map(change => [change.path, change.kind]), [['added.txt', 'added'], ['deleted.txt', 'deleted'], ['edited.ts', 'modified']]);
    assert.equal(api.viewState().review?.busy, false);
    const messageCheckpoints = api.viewState().checkpoints;
    assert.equal(messageCheckpoints?.length, 1, `${provider} captures a before-send checkpoint through the real chat lifecycle`);
    assert.equal(messageCheckpoints![0]!.messageId, api.conversation()!.messages.find(message => message.role === 'user')!.id);
    await api.syncConversations(); assert.equal(api.viewState().review?.files.length, 3, 'Transcript refresh does not accept changes');
    const persistedCheckpoint = api.viewState().checkpoints;
    assert.equal(persistedCheckpoint?.length, 1, `${provider} checkpoint remains available after native history refresh`);
    assert.equal(persistedCheckpoint![0]!.messageId, api.conversation()!.messages.find(message => message.role === 'user')!.id);
    if (process.env.AGENT_TANDEM_REVIEW_LARGE_FILE === '1') assert.equal((await stat(file('src/core'))).size, 105 * 1024 * 1024);
    checks.push(`${provider} real chat modifies/adds/deletes files${process.env.AGENT_TANDEM_REVIEW_LARGE === '1' ? ' in a workspace with over 20,000 source files' : process.env.AGENT_TANDEM_REVIEW_LARGE_FILE === '1' ? ' with a 105 MiB src/core file present' : ''}; completion displays three already applied changes pending review`);
    checks.push(`${provider} exposes working/tool activity during real inference and clears it after completion`);
    if (provider === 'Codex') {
      await vscode.commands.executeCommand('agentTandem.revertChanges', request());
      assert.equal(await text('edited.ts'), "export const mode = 'before';\n"); assert.equal(await text('deleted.txt'), 'keep original\n');
      await assert.rejects(readFile(file('added.txt')), { code: 'ENOENT' });
      assert.equal(api.viewState().review?.files.length, 0); checks.push('Revert all after real Codex chat restores modified/deleted files and removes the added file');
    }
  }
  await writeFile(report, JSON.stringify({ success: false, vscode: vscode.version, checks }, null, 2));
}
