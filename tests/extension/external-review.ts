import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { ExtensionAPI } from '../../src/extension';

const execute = promisify(execFile);
async function waitFor(check: () => boolean, label: string) {
  const until = Date.now() + 20000;
  while (!check() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(check(), label);
}
export async function run() {
  const extension = vscode.extensions.getExtension<ExtensionAPI>('agent-dock-local.agent-dock'); assert.ok(extension);
  const api = await extension.activate(), project = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const guideOpen = () => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => /^(Welcome|Welcome to AgentDock|Getting Started)$/i.test(tab.label)));
  if (process.env.AGENT_DOCK_EXTERNAL_STAGE === 'resume') {
    assert.equal(api.viewState().review?.externalTracking, undefined, 'Explicit pause survives a new VS Code window');
    assert.equal(guideOpen(), false, 'Onboarding is not reopened after its first display');
    assert.deepEqual(api.viewState().review?.undo?.files, ['deleted.ts'], 'The latest Revert Undo survives window restart');
    await vscode.commands.executeCommand('agentDock.undoRevert');
    assert.equal(await readFile(path.join(project, 'deleted.ts'), 'utf8'), 'codex conversation\n');
    assert.deepEqual(api.viewState().review!.files.map(file => file.path), ['deleted.ts', 'source.ts'], 'Undo preserves unrelated pending review after restart');
    await vscode.commands.executeCommand('agentDock.gettingStarted');
    assert.ok(guideOpen(), 'Guide remains available on demand');
    await vscode.commands.executeCommand('agentDock.toggleExternalReview');
    assert.equal(api.viewState().review?.externalTracking, true, 'Paused tracking can be resumed');
    await vscode.commands.executeCommand('agentDock.toggleExternalReview');
    const report = { success: true, vscode: vscode.version, checks: ['Review companion is the default view', 'Automatic tracking and first-run guide', 'Passive capture preserves editor focus', 'Status-bar shortcut opens the latest conversation diff', 'Native filesystem watcher captures external add/modify/delete without chat', 'Accept/revert are independent and not recaptured', 'Claude/Codex local edit history groups pending files by conversation', 'Revert preview leaves files unchanged until confirmation', 'Undo restores only its scope and pending conversation identity', 'Undo survives window restart and preserves unrelated changes', 'Stop flushes changes and preserves review', 'Explicit pause survives window restart', 'Onboarding opens once and can be reopened manually'] };
    await writeFile(path.join(process.env.AGENT_DOCK_REPORT_DIR!, 'external-review-host.json'), JSON.stringify(report, null, 2));
    console.log(`AGENT_DOCK_EXTERNAL_REVIEW ${JSON.stringify(report)}`); return;
  }
  assert.ok(guideOpen(), `First-run walkthrough is visible; tabs: ${vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => tab.label)).join(', ')}`);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('agentDock.trackingControls'));
  assert.ok(commands.includes('agentDock.gettingStarted'));
  assert.ok(commands.includes('agentDock.reviewLatest'));
  assert.ok(commands.includes('agentDock.undoRevert'));
  assert.equal(api.viewState().screen, 'changes', 'Review companion is the initial view');
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(project, 'source.ts')));
  const originalTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const native = process.env.AGENT_DOCK_TEST_NODE!;
  const writer = async (script: string) => execute(native, ['-e', script, project], { windowsHide: true });
  assert.equal(api.viewState().review?.externalTracking, true);
  assert.equal(api.viewState().chat, undefined);
  await writer("const fs=require('fs'),p=require('path'),root=process.argv[1];fs.writeFileSync(p.join(root,'source.ts'),'external one\\n');fs.writeFileSync(p.join(root,'new.ts'),'created outside\\n');fs.unlinkSync(p.join(root,'deleted.ts'));");
  await waitFor(() => api.viewState().review?.files.length === 3 && !api.viewState().reviewBusy, 'Filesystem watcher automatically captures changes from an external process');
  const first = api.viewState().review!;
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab, originalTab, 'Passive capture does not steal editor focus');
  await vscode.commands.executeCommand('agentDock.acceptChanges', { project, revision: first.revision, file: 'new.ts' });
  assert.equal(api.viewState().review?.files.length, 2);
  await vscode.commands.executeCommand('agentDock.revertChanges', { project, revision: api.viewState().review!.revision });
  await waitFor(() => !api.viewState().reviewBusy, 'Review writes settle');
  await vscode.commands.executeCommand('agentDock.captureExternalChanges');
  assert.equal(api.viewState().review?.files.length, 0, 'Own reverts are not recaptured');
  assert.equal(await readFile(path.join(project, 'source.ts'), 'utf8'), 'user edits before tracking\n');
  assert.equal(await readFile(path.join(project, 'new.ts'), 'utf8'), 'created outside\n');
  assert.equal(await readFile(path.join(project, 'deleted.ts'), 'utf8'), 'original deleted file\n');
  // Synthetic native history exercises the actual history readers and diff UI; no inference is started.
  const claudeId = '11111111-1111-4111-8111-111111111111', codexId = '22222222-2222-4222-8222-222222222222';
  const claudeDir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
  const codexDir = path.join(process.env.CODEX_HOME!, 'sessions');
  await mkdir(claudeDir, { recursive: true }); await mkdir(codexDir, { recursive: true });
  await writer("const fs=require('fs'),p=require('path'),root=process.argv[1];fs.writeFileSync(p.join(root,'source.ts'),'claude conversation\\n');fs.writeFileSync(p.join(root,'deleted.ts'),'codex conversation\\n');");
  const timestamp = new Date().toISOString();
  const claudeRecords = [
    { type: 'user', uuid: 'user-1', cwd: project, sessionId: claudeId, timestamp, isSidechain: false, message: { role: 'user', content: 'Change source for Claude' } },
    { type: 'assistant', uuid: 'assistant-1', cwd: project, sessionId: claudeId, timestamp, isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: path.join(project, 'source.ts'), old_string: 'user edits before tracking', new_string: 'claude conversation' } }] } },
    { type: 'user', uuid: 'result-1', cwd: project, sessionId: claudeId, timestamp, isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'Updated successfully' }] } },
  ];
  const codexRecords = [
    { type: 'session_meta', timestamp, payload: { id: codexId, cwd: project } },
    { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'Change deleted file for Codex' } },
    { type: 'response_item', timestamp, payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch-1', input: '*** Begin Patch\n*** Update File: deleted.ts\n@@\n-original deleted file\n+codex conversation\n*** End Patch' } },
    { type: 'response_item', timestamp, payload: { type: 'custom_tool_call_output', call_id: 'patch-1', output: 'Success. Updated the following files:\nM deleted.ts' } },
  ];
  await writeFile(path.join(claudeDir, `${claudeId}.jsonl`), claudeRecords.map(record => JSON.stringify(record)).join('\n') + '\n');
  await writeFile(path.join(codexDir, `rollout-${codexId}.jsonl`), codexRecords.map(record => JSON.stringify(record)).join('\n') + '\n');
  await api.syncConversations(); await vscode.commands.executeCommand('agentDock.captureExternalChanges');
  const grouped = api.viewState().review!;
  assert.deepEqual(grouped.files.map(file => [file.path, file.captures?.flatMap(capture => capture.conversations?.map(item => item.key) ?? [])]), [['deleted.ts', [`Codex:${codexId}`]], ['source.ts', [`Claude:${claudeId}`]]]);
  await vscode.commands.executeCommand('agentDock.showSection', 'changes');
  assert.equal(api.viewState().screen, 'changes');
  await vscode.commands.executeCommand('agentDock.previewReview', { project, revision: grouped.revision, group: `Claude:${claudeId}` });
  const diff = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(diff?.input instanceof vscode.TabInputTextDiff, 'Conversation file opens the standard native diff');
  assert.ok(diff.input.modified.path.endsWith('/source.ts'));
  await vscode.commands.executeCommand('agentDock.acceptChanges', { project, revision: grouped.revision, group: `Claude:${claudeId}` });
  assert.deepEqual(api.viewState().review!.files.map(file => file.path), ['deleted.ts'], 'Group accept preserves Codex review');
  await vscode.commands.executeCommand('agentDock.reviewLatest');
  const quickDiff = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(quickDiff?.input instanceof vscode.TabInputTextDiff && quickDiff.input.modified.path.endsWith('/deleted.ts'), 'Status-bar command opens the remaining conversation diff directly');
  await vscode.commands.executeCommand('agentDock.previewRevert', { project, revision: api.viewState().review!.revision, group: `Codex:${codexId}` });
  assert.deepEqual(api.viewState().revertPreview?.files.map(file => file.path), ['deleted.ts']);
  assert.equal(await readFile(path.join(project, 'deleted.ts'), 'utf8'), 'codex conversation\n', 'Revert preview leaves workspace bytes untouched');
  await vscode.commands.executeCommand('agentDock.confirmRevert', { token: api.viewState().revertPreview!.token });
  assert.equal(await readFile(path.join(project, 'source.ts'), 'utf8'), 'claude conversation\n');
  assert.equal(await readFile(path.join(project, 'deleted.ts'), 'utf8'), 'original deleted file\n');
  assert.equal(api.viewState().chat, undefined, 'Native edit review does not start either provider');
  assert.deepEqual(api.viewState().review!.files.map(file => file.path), [], 'All conversation decisions are complete');
  assert.ok(api.viewState().review!.undo, 'Undo remains available after the last pending change is reverted');
  await vscode.commands.executeCommand('agentDock.undoRevert');
  assert.equal(await readFile(path.join(project, 'deleted.ts'), 'utf8'), 'codex conversation\n');
  assert.equal(await readFile(path.join(project, 'source.ts'), 'utf8'), 'claude conversation\n', 'Undo does not affect accepted Claude changes');
  assert.deepEqual(api.viewState().review!.files.map(file => file.path), ['deleted.ts']);
  await vscode.commands.executeCommand('agentDock.revertChanges', { project, revision: api.viewState().review!.revision, group: `Codex:${codexId}` });
  await writer("const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(process.argv[1],'source.ts'),'external two\\n');");
  await vscode.commands.executeCommand('agentDock.toggleExternalReview');
  assert.equal(api.viewState().review?.externalTracking, undefined);
  assert.equal(api.viewState().review?.files.length, 1, `Stop flushes the final external write: ${JSON.stringify(api.viewState().review?.files)}`);
  assert.equal(api.viewState().chat, undefined, 'No AgentDock chat or inference was used');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('AGENT_DOCK_EXTERNAL_REVIEW first stage passed');
}
