import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ReviewStore } from '../../src/core/review';
import { CheckpointStore } from '../../src/core/checkpoints';
import type { ExtensionAPI } from '../../src/extension';
export async function run() {
  const project = vscode.workspace.workspaceFolders![0]!.uri.fsPath, storage = process.env.AGENT_DOCK_CHECKPOINT_STORAGE!;
  const file = path.join(project, 'source.ts'), get = () => readFile(file, 'utf8');
  const reviews = new ReviewStore(path.join(storage, 'reviews')), checkpoints = new CheckpointStore(path.join(storage, 'checkpoints'));
  const reopened = !!process.env.AGENT_DOCK_CHECKPOINT_REOPEN;
  if (!reopened) {
    await writeFile(file, 'before first message');
    for (const turn of [1, 2]) {
      await reviews.begin(project, `r${turn}`);
      const snapshot = await reviews.checkpointBefore(project, `r${turn}`);
      for (const provider of ['Codex', 'Claude']) {
        const key = `${provider}:${provider === 'Codex' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222'}`;
        await checkpoints.record(project, key, Array(turn).fill('Update file'), snapshot);
      }
      await writeFile(file, `after turn ${turn}`);
      const review = await reviews.finish(project, `r${turn}`); await reviews.accept({ project, revision: review.revision });
    }
  }
  const api = await vscode.extensions.getExtension<ExtensionAPI>('agent-dock-local.agent-dock')!.activate();
  const index = await api.syncConversations(); assert.equal(index.errors.length, 0); assert.equal(index.conversations.length, 2);
  for (const provider of ['Codex', 'Claude']) {
    const conversation = index.conversations.find(row => row.provider === provider)!;
    await api.openConversation(conversation.key);
    const saved = api.viewState().checkpoints!;
    assert.equal(saved.length, 2, `${provider} native IDs map both repeated messages`);
    const userMessages = api.conversation()!.messages.filter(message => message.role === 'user');
    assert.deepEqual(saved.map(entry => entry.messageId), userMessages.map(message => message.id));
    if (reopened) {
      assert.equal(await get(), 'before first message'); assert.ok(api.viewState().checkpointUndo);
      await vscode.commands.executeCommand('agentDock.previewCheckpoint', { project, id: saved[1]!.id });
      assert.equal(api.viewState().checkpointPreview!.files.length, 1);
      await vscode.commands.executeCommand('agentDock.closeCheckpointPreview');
      continue;
    }
    const restore = async (id: string) => {
      await vscode.commands.executeCommand('agentDock.previewCheckpoint', { project, id });
      const preview = api.viewState().checkpointPreview!;
      await vscode.commands.executeCommand('agentDock.restoreCheckpoint', { project, id, token: preview.token });
    };
    await vscode.commands.executeCommand('agentDock.previewCheckpoint', { project, id: saved[1]!.id });
    const preview = api.viewState().checkpointPreview!;
    assert.equal(await get(), provider === 'Codex' ? 'after turn 2' : 'before first message', 'Preview does not write code');
    await assert.rejects(async () => vscode.commands.executeCommand('agentDock.restoreCheckpoint', { project, id: saved[1]!.id, token: 'stale' }), /Preview this checkpoint again/);
    const document = await vscode.workspace.openTextDocument(file);
    const edit = new vscode.WorkspaceEdit(); edit.insert(document.uri, new vscode.Position(0, 0), 'unsaved '); await vscode.workspace.applyEdit(edit);
    await assert.rejects(async () => vscode.commands.executeCommand('agentDock.restoreCheckpoint', { project, id: saved[1]!.id, token: preview.token }), /unsaved edits/);
    await vscode.window.showTextDocument(document); await vscode.commands.executeCommand('workbench.action.files.revert');
    await restore(saved[1]!.id); assert.equal(await get(), 'after turn 1');
    assert.equal(api.conversation()!.messages.length, 4, 'Restore preserves native chat history');
    const undo = api.viewState().checkpointUndo!;
    await restore(undo.id); assert.equal(await get(), provider === 'Codex' ? 'after turn 2' : 'before first message');
    await restore(saved[0]!.id); assert.equal(await get(), 'before first message');
    await assert.rejects(async () => vscode.commands.executeCommand('agentDock.previewCheckpoint', { project, id: 'not-a-checkpoint' }), /does not belong/);
  }
  await vscode.commands.executeCommand('agentDock.open');
  const report = { success: true, vscode: vscode.version, phase: reopened ? 'reopen' : 'initial', providers: ['Codex', 'Claude'], checks: ['native repeated message matching', 'Accept-independent snapshots', 'preview without writes', 'stale token protection', 'dirty editor protection', 'per-message restore', 'Undo restore', 'chat preservation', 'checkpoint persistence'] };
  await writeFile(process.env.AGENT_DOCK_CHECKPOINT_REPORT!, JSON.stringify(report, null, 2)); console.log(`AGENT_DOCK_CHECKPOINTS ${JSON.stringify(report)}`);
}
