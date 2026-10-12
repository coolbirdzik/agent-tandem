import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ReviewStore } from '../../src/core/review';
import { reviewSnapshotUri } from '../../src/host/review-editor';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '../../src/extension';
import { snapshotUri } from '../../src/host/preview';

async function waitFor(predicate: () => boolean, description: string) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 8000) throw new Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
export async function run() {
  const checks: string[] = [];
  const extension = vscode.extensions.getExtension<ExtensionAPI>(process.env.AGENT_TANDEM_EXTENSION_ID || 'agent-tandem-local.agent-tandem');
  assert.ok(extension, 'Development extension is loaded');
  const api = await extension.activate();
  const directory = process.env.AGENT_TANDEM_REPORT_DIR;
  const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
  if (process.env.AGENT_TANDEM_TEST_PHASE === 'reopen') {
    assert.ok(directory);
    const index = await api.syncConversations();
    assert.equal(index.conversations.length, 2);
    assert.equal(api.conversation()?.conversation.provider, 'Claude', 'Previously selected conversation reopens in a new Extension Host');
    assert.equal(api.viewState().codexFastMode, true, 'Codex Fast mode survives a new Extension Host');
    const prior = JSON.parse(await readFile(`${directory}/extension-test.json`, 'utf8')) as { sessionId: string; stepId: string; afterId: string; abandonedId: string; reviewSnapshot: { hash: string; file: string } };
    assert.match((await vscode.workspace.openTextDocument(reviewSnapshotUri(prior.reviewSnapshot.hash, prior.reviewSnapshot.file))).getText(), /before/, 'Accepted review snapshot stays readable in a new Extension Host');
    const restored = api.sessions().find(session => session.id === prior.sessionId);
    assert.ok(restored);
    assert.equal(restored.steps.find(step => step.id === prior.stepId)?.after, prior.afterId);
    const original = await vscode.workspace.openTextDocument(snapshotUri(prior.sessionId, prior.afterId, 'src/login.ts'));
    assert.match(original.getText(), /length > 0/);
    assert.doesNotMatch(original.getText(), /length >= 3/);
    const abandoned = api.sessions().find(session => session.id === prior.abandonedId);
    assert.equal(abandoned?.status, 'interrupted');
    assert.equal(abandoned?.steps[0]?.after, undefined);
    const count = tabs().length;
    await vscode.commands.executeCommand('agentTandem.openFile', { sessionId: prior.sessionId, stepId: prior.stepId, file: 'src/login.ts' });
    assert.match(api.viewState().changePreview?.file?.after ?? '', /length > 0/);
    assert.ok(tabs().some(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === original.uri.toString()), 'Reopened changes open in a native diff editor');
    const report = { success: true, vscode: vscode.version, checks: ['Project conversations sync and the last selection reopens in a separate Extension Host', 'A separate Extension Host reopens the saved old-step diff in the VS Code editor', 'Unfinished session is recovered as interrupted without an invented after-snapshot'] };
    await writeFile(`${directory}/extension-restart-test.json`, JSON.stringify(report, null, 2));
    console.log(`AGENT_TANDEM_RESTART_TEST ${JSON.stringify(report)}`);
    return;
  }
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('vscode.diff')); assert.ok(commands.includes('vscode.changes'));
  checks.push('Native diff and changes commands available');
  const defaultTabs = tabs().length;
  const automaticTabs: string[] = [];
  const tabEvents = vscode.window.tabGroups.onDidChangeTabs(event => automaticTabs.push(...event.opened.map(tab => tab.label)));
  await vscode.commands.executeCommand('agentTandem.open');
  await waitFor(() => api.viewResolved(), 'single AgentTandem sidebar webview resolves');
  assert.equal(tabs().length, defaultTabs, 'Opening AgentTandem uses the tandem, not an editor tab');
  const index = await api.syncConversations();
  assert.ok(api.conversation(), 'Latest workspace conversation opens automatically');
  assert.equal(api.viewState().project, vscode.workspace.workspaceFolders![0]!.uri.fsPath);
  assert.deepEqual(index.errors, []);
  assert.equal(index.conversations.length, 2, 'Both existing project conversations are discovered');
  const codex = index.conversations.find(item => item.provider === 'Codex')!;
  await api.openConversation(codex.key);
  const project = api.viewState().project!;
  for (const enabled of [true, false, true]) {
    await vscode.commands.executeCommand('agentTandem.setFastMode', { project, provider: 'Codex', enabled });
    assert.equal(api.viewState().codexFastMode, enabled);
  }
  await assert.rejects(async () => vscode.commands.executeCommand('agentTandem.setFastMode', { project: '/stale-project', provider: 'Codex', enabled: false }), /workspace changed/);
  checks.push('Codex Fast mode toggles On/Off and rejects stale project requests');
  const claude = index.conversations.find(item => item.provider === 'Claude')!;
  const codexContent = await vscode.commands.executeCommand<Awaited<ReturnType<ExtensionAPI['openConversation']>>>('agentTandem.openConversation', codex.key);
  assert.deepEqual(codexContent?.messages.map(item => item.text), ['Existing Codex conversation', 'Codex reply']);
  const claudeContent = await api.openConversation(claude.key);
  assert.deepEqual(claudeContent?.messages.map(item => item.text), ['Existing Claude conversation', 'Claude reply']);
  await Promise.all([api.openConversation(codex.key), api.openConversation(claude.key)]);
  assert.equal(api.conversation()?.conversation.key, claude.key, 'Concurrent reads keep the last selected conversation');
  checks.push('Existing project conversations load from Codex rollouts and the bundled official Claude SDK without inference');
  await api.openConversation(codex.key);
  await appendFile(process.env.AGENT_TANDEM_CODEX_FIXTURE!, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', client_id: 'u2', message: 'Codex external update' } }) + '\n');
  await waitFor(() => api.conversation()?.messages.at(-1)?.text === 'Codex external update', 'automatic Codex history sync');
  await api.openConversation(claude.key);
  await appendFile(process.env.AGENT_TANDEM_CLAUDE_FIXTURE!, JSON.stringify({ uuid: '55555555-5555-4555-8555-555555555555', parentUuid: '44444444-4444-4444-8444-444444444444', type: 'user', sessionId: claude.id, cwd: claude.cwd, timestamp: new Date().toISOString(), isSidechain: false, message: { role: 'user', content: 'Claude external update' } }) + '\n');
  // Explicit refresh also updates the open transcript.
  await api.syncConversations();
  assert.equal(api.conversation()?.messages.at(-1)?.text, 'Claude external update');
  checks.push('External Codex writes auto-sync; Claude writes refresh the open transcript without switching sessions');
  await vscode.commands.executeCommand('agentTandem.newChat', 'Codex');
  assert.equal(api.conversation(), undefined);
  assert.equal(api.viewState().composeProvider, 'Codex');
  await api.syncConversations();
  assert.equal(api.conversation(), undefined, 'History refresh preserves a new chat');
  const chatConfig = vscode.workspace.getConfiguration('agentTandem');
  const oldExecutable = chatConfig.inspect<string>('codexExecutable')?.workspaceValue;
  try {
    await chatConfig.update('codexExecutable', pathForMissingExecutable(), vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('agentTandem.sendChat', { requestId: 'host-chat', project: api.viewState().project, provider: 'Codex', text: 'Message from the composer' });
    assert.equal(api.viewState().chat?.status, 'failed');
    assert.equal(api.conversation()?.messages[0]?.text, 'Message from the composer');
    assert.match(api.viewState().error ?? '', /executable was not found/);
    assert.equal(tabs().length, defaultTabs);
  } finally {
    await chatConfig.update('codexExecutable', oldExecutable, vscode.ConfigurationTarget.Workspace);
  }
  await vscode.commands.executeCommand('agentTandem.newChat', 'Claude');
  assert.equal(api.viewState().composeProvider, 'Claude');
  assert.equal(api.viewState().chat, undefined);
  await api.openConversation(claude.key);
  checks.push('Chat commands preserve a new compose screen through sync, accept typed text, expose provider failures and switch providers inside the tandem');
  await vscode.commands.executeCommand('agentTandem.showSection', 'tools');
  assert.equal(api.viewState().screen, 'tools');
  await vscode.commands.executeCommand('agentTandem.showSection', 'conversations');
  const previousSessionId = api.sessions()[0]?.id;
  const execution = api.runDemo(250);
  await waitFor(() => api.sessions()[0]?.id !== previousSessionId && (api.sessions()[0]?.steps.some(step => step.changes.length === 1 && !!step.after) ?? false), 'first saved edit while run is active');
  const live = api.sessions()[0]!;
  assert.equal(live.status, 'running');
  const liveStep = live.steps.find(step => step.changes.length === 1)!;
  await vscode.commands.executeCommand('agentTandem.openFile', { sessionId: live.id, stepId: liveStep.id, file: 'src/login.ts' });
  assert.match(api.viewState().changePreview?.file?.patch ?? '', /\+.*trim/);
  assert.ok(tabs().some(tab => tab.input instanceof vscode.TabInputTextDiff), 'View Changes opens the native diff editor during a run');
  checks.push('View Changes opens native diff editors while the sidebar keeps conversations');
  const session = await execution;
  assert.equal(session.status, 'completed'); assert.equal(session.steps.length, 5);
  const first = session.steps[1]!; const second = session.steps[2]!;
  await vscode.commands.executeCommand('agentTandem.openStep', { sessionId: session.id, stepId: second.id });
  assert.equal(api.viewState().changePreview?.files.length, 2);
  assert.ok(tabs().some(tab => tab.label.includes(second.title)), 'View changes opens native multi-file editor');
  await vscode.commands.executeCommand('agentTandem.previewFile', 'src/login.ts');
  assert.match(api.viewState().changePreview?.file?.before ?? '', /length > 0/);
  assert.match(api.viewState().changePreview?.file?.after ?? '', /length >= 3/);
  assert.equal(api.changeNavigationState()?.total, 2, 'A selected step file retains both changed files');
  const stepEditor = vscode.window.activeTextEditor!;
  const end = stepEditor.document.lineAt(stepEditor.document.lineCount - 1).range.end;
  stepEditor.selection = new vscode.Selection(end, end);
  await vscode.commands.executeCommand('agentTandem.nextChange');
  await waitFor(() => api.changeNavigationState()?.file === 'src/login.test.ts', 'Step file navigation advances to the other file');
  assert.equal(api.changeNavigationState()?.total, 2);
  await vscode.commands.executeCommand('agentTandem.openCumulative', { sessionId: session.id, stepId: second.id });
  assert.equal(api.viewState().changePreview?.cumulative, true);
  await vscode.commands.executeCommand('agentTandem.previewFile', 'src/login.ts');
  assert.doesNotMatch(api.viewState().changePreview?.file?.before ?? '', /trim/);
  const countBeforeOutput = tabs().length;
  await vscode.commands.executeCommand('agentTandem.openStep', { sessionId: session.id, stepId: session.steps[0]!.id });
  assert.equal(api.viewState().changePreview?.files.length, 0);
  assert.ok(api.viewState().changePreview?.output);
  assert.equal(api.viewState().changePreview?.file, undefined);
  assert.equal(tabs().length, countBeforeOutput, 'A no-change step shows output without opening a new diff');
  assert.ok(automaticTabs.length > 0, 'Change commands open VS Code editor tabs by default');
  tabEvents.dispose();
  checks.push('File and cumulative changes use native diff/multi-file editors; no-change steps show output');
  assert.equal(commands.includes('agentTandem.selectProject'), false, 'No manual project picker command');
  const initialRoot = vscode.workspace.workspaceFolders![0]!.uri;
  const blankRoot = vscode.workspace.workspaceFolders![1]!.uri;
  const otherFile = vscode.Uri.joinPath(blankRoot, 'root-test.txt');
  await vscode.workspace.fs.writeFile(otherFile, Buffer.from('Other root'));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(otherFile));
  await waitFor(() => api.viewState().project === blankRoot.fsPath && !api.viewState().syncing, 'active editor root auto-sync');
  assert.equal(api.viewState().conversations?.length, 0); assert.equal(api.conversation(), undefined);
  const initialFile = vscode.Uri.joinPath(initialRoot, 'root-test.txt');
  await vscode.workspace.fs.writeFile(initialFile, Buffer.from('Initial root'));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(initialFile));
  await waitFor(() => api.viewState().project === initialRoot.fsPath && !api.viewState().syncing, 'original editor root auto-sync');
  assert.equal(api.viewState().conversations?.length, 2);
  await api.openConversation(claude.key);
  checks.push('Current workspace root is automatic; switching editors in multi-root workspaces clears unrelated history');
  const pendingPreview = vscode.commands.executeCommand('agentTandem.openStep', { sessionId: session.id, stepId: second.id });
  await vscode.commands.executeCommand('agentTandem.showSection', 'tools');
  await pendingPreview;
  assert.equal(api.viewState().screen, 'tools', 'A slow snapshot read does not override later navigation');

  await vscode.commands.executeCommand('agentTandem.openInTab');
  await waitFor(() => tabs().some(tab => tab.input instanceof vscode.TabInputWebview), 'explicit Open in tab');
  const countWithTab = tabs().length;
  await vscode.commands.executeCommand('agentTandem.openInTab');
  assert.equal(tabs().length, countWithTab, 'Explicit AgentTandem tab is reused');
  await vscode.commands.executeCommand('agentTandem.openFileInEditor', { sessionId: session.id, stepId: first.id, file: 'src/login.ts' });
  await waitFor(() => tabs().some(tab => tab.input instanceof vscode.TabInputTextDiff), 'explicit Open diff in editor');
  checks.push('AgentTandem editor tab is explicit and reused; change links open native diff editors directly');
  const firstAfter = snapshotUri(session.id, first.after!, 'src/login.ts');
  const secondBefore = snapshotUri(session.id, second.before, 'src/login.ts');
  const secondAfter = snapshotUri(session.id, second.after!, 'src/login.ts');
  const firstDoc = await vscode.workspace.openTextDocument(firstAfter);
  const beforeDoc = await vscode.workspace.openTextDocument(secondBefore);
  const secondDoc = await vscode.workspace.openTextDocument(secondAfter);
  assert.equal(firstDoc.getText(), beforeDoc.getText());
  assert.match(firstDoc.getText(), /length > 0/); assert.match(secondDoc.getText(), /length >= 3/);
  assert.equal(firstDoc.uri.scheme, 'agenttandem-snapshot'); assert.equal(firstDoc.isDirty, false);
  checks.push('Two steps editing the same file retain distinct historical contents');
  const edit = new vscode.WorkspaceEdit(); edit.insert(firstAfter, new vscode.Position(0, 0), 'WRITE SHOULD FAIL');
  try { await vscode.workspace.applyEdit(edit); } catch { /* Other versions may reject readonly edits directly. */ }
  await waitFor(() => firstDoc.getText() === beforeDoc.getText(), 'historical buffer restored after external WorkspaceEdit');
  assert.equal((await api.history.readSnapshotFile(first.after!, 'src/login.ts')).toString(), beforeDoc.getText());
  checks.push('Readonly snapshot buffer restores immutable content after an external WorkspaceEdit');
  await vscode.commands.executeCommand('agentTandem.openStepInEditor', { sessionId: session.id, stepId: second.id });
  await waitFor(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label.includes(second.title))), 'multi-file changes tab');
  checks.push('Explicit multi-file editor command opens the native changes editor');
  const removed = session.steps[3]!;
  const removedAfter = await vscode.workspace.openTextDocument(snapshotUri(session.id, removed.after!, 'obsolete.txt'));
  assert.equal(removedAfter.getText(), '');
  const addedBefore = await vscode.workspace.openTextDocument(snapshotUri(session.id, second.before, 'src/login.test.ts'));
  assert.equal(addedBefore.getText(), '');
  checks.push('Added/deleted files have correct empty sides');
  await api.refreshFromStorage();
  const saved = api.sessions().find(value => value.id === session.id)!;
  assert.equal(saved.steps[1]?.after, first.after);
  await vscode.commands.executeCommand('agentTandem.openFile', { sessionId: saved.id, stepId: first.id, file: 'src/login.ts' });
  assert.equal((await vscode.workspace.openTextDocument(firstAfter)).getText(), firstDoc.getText());
  checks.push('Reopened storage keeps old step URI and content');
  const reviewStore = new ReviewStore(path.join(api.history.directory, 'reviews'));
  const reviewProject = api.viewState().project!;
  // The parent repository ignores .test-runtime; own this fixture's Git scope.
  await promisify(execFile)('git', ['init', '-q'], { cwd: reviewProject, windowsHide: true });
  const fixtureFolder = '.review-editor-fixture';
  const reviewFile = (name: string) => path.join(reviewProject, fixtureFolder, name);
  await mkdir(path.join(reviewProject, fixtureFolder), { recursive: true });
  await writeFile(reviewFile('modified.ts'), 'export const value = "before";\n');
  await writeFile(reviewFile('deleted.txt'), 'deleted original\n');
  await writeFile(reviewFile('large.ts'), 'a'.repeat(600_000) + '\nBEFORE END\n');
  await vscode.workspace.fs.delete(vscode.Uri.file(reviewFile('added.txt'))).then(() => undefined, error => { if (error.code !== 'FileNotFound') throw error; });
  await reviewStore.begin(reviewProject, 'editor-fixture');
  await writeFile(reviewFile('modified.ts'), 'export const value = "after";\n');
  await writeFile(reviewFile('added.txt'), 'added contents\n');
  await writeFile(reviewFile('large.ts'), 'b'.repeat(600_000) + '\nAFTER END\n');
  await vscode.workspace.fs.delete(vscode.Uri.file(reviewFile('deleted.txt')));
  const captured = await reviewStore.finish(reviewProject, 'editor-fixture');
  await vscode.commands.executeCommand('agentTandem.refreshReview');
  const request = (file?: string) => ({ project: reviewProject, revision: api.viewState().review!.revision, file });
  for (const name of ['modified.ts', 'added.txt', 'deleted.txt', 'large.ts']) {
    const file = captured.files.find(row => row.path === `${fixtureFolder}/${name}`)!;
    assert.ok(file);
    await vscode.commands.executeCommand('agentTandem.previewReview', request(file.path));
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputTextDiff, 'Clicking a review file focuses a native diff editor');
    assert.equal(input.original.toString(), reviewSnapshotUri(file.before, file.path).toString());
    assert.equal(input.modified.toString(), reviewSnapshotUri(file.after, file.path).toString());
    const left = (await vscode.workspace.openTextDocument(input.original)).getText();
    const right = (await vscode.workspace.openTextDocument(input.modified)).getText();
    if (name === 'modified.ts') {
      assert.match(left, /before/); assert.match(right, /after/);
      if (!extension.packageJSON.enabledApiProposals) {
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', input.modified, 20);
        assert.ok(lenses.some(lens => lens.command?.command === 'agentTandem.acceptHunk'), 'Stable Marketplace build exposes Accept through CodeLens');
        assert.ok(lenses.some(lens => lens.command?.command === 'agentTandem.rejectHunk'), 'Stable Marketplace build exposes Reject through CodeLens');
      }
    }
    if (name === 'added.txt') { assert.equal(left, ''); assert.equal(right, 'added contents\n'); }
    if (name === 'deleted.txt') { assert.equal(left, 'deleted original\n'); assert.equal(right, ''); }
    if (name === 'large.ts') { assert.equal(left.length, 600_012); assert.ok(left.endsWith('BEFORE END\n')); assert.ok(right.endsWith('AFTER END\n')); }
    assert.equal(api.viewState().reviewPreview, undefined, 'Review diff stays in the VS Code editor');
    const count = tabs().length;
    await vscode.commands.executeCommand('agentTandem.previewReview', request(file.path));
    assert.equal(tabs().length, count, 'Repeated file clicks reuse the same diff');
  }
  await vscode.commands.executeCommand('agentTandem.previewReview', request());
  await waitFor(() => tabs().some(tab => tab.label.includes('AgentTandem · Pending changes')), 'View changes opens the native multi-file editor');
  await assert.rejects(async () => vscode.commands.executeCommand('agentTandem.previewReview', { ...request(), revision: 'stale' }), /updated/);
  const modified = captured.files.find(row => row.path.endsWith('/modified.ts'))!;
  await vscode.commands.executeCommand('agentTandem.acceptChanges', request(modified.path));
  assert.equal(api.viewState().review!.files.length, captured.files.length - 1, 'File Accept leaves every other file pending');
  assert.ok(!api.viewState().review!.files.some(file => file.path === modified.path));
  assert.equal(api.changeNavigationState()?.total, captured.files.length - 1, 'Native review drops the accepted file');
  const remaining = api.viewState().review!.files.find(file => file.path.endsWith('/added.txt'))!;
  await vscode.commands.executeCommand('agentTandem.previewReview', request(remaining.path));
  const acceptedTab = vscode.window.tabGroups.activeTabGroup.activeTab!;
  await vscode.commands.executeCommand('agentTandem.acceptChanges', request(remaining.path));
  assert.equal(api.viewState().review!.files.length, captured.files.length - 2, 'A second file Accept still affects just that file');
  assert.ok(!tabs().includes(acceptedTab), 'Reviewed single-file diff retires instead of retaining changed colours with no actions');
  assert.equal(api.changeNavigationState()?.total, captured.files.length - 2, 'Review continues with the remaining files');
  assert.match((await vscode.workspace.openTextDocument(reviewSnapshotUri(modified.before, modified.path))).getText(), /before/, 'Accept does not invalidate open snapshot documents');
  await vscode.commands.executeCommand('agentTandem.revertChanges', request());
  assert.equal(api.viewState().review!.files.length, 0);
  assert.ok(!tabs().some(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === 'agenttandem-review'), 'All-reviewed pending diff tabs close');
  assert.equal((await readFile(reviewFile('deleted.txt'), 'utf8')), 'deleted original\n');
  assert.equal((await readFile(reviewFile('modified.ts'), 'utf8')), 'export const value = "after";\n');
  assert.equal((await readFile(reviewFile('added.txt'), 'utf8')), 'added contents\n', 'Accept keeps the already applied contents');
  const historicalTabs = tabs().filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === 'agenttandem-snapshot');
  await reviewStore.begin(reviewProject, 'accept-all-fixture');
  await writeFile(reviewFile('modified.ts'), 'export const value = "accepted again";\n');
  await writeFile(reviewFile('added.txt'), 'accepted again\n');
  await reviewStore.finish(reviewProject, 'accept-all-fixture');
  await vscode.commands.executeCommand('agentTandem.refreshReview');
  await vscode.commands.executeCommand('agentTandem.previewReview', request());
  await vscode.window.showTextDocument(vscode.Uri.file(reviewFile('modified.ts')));
  const unrelatedEditor = vscode.window.tabGroups.activeTabGroup.activeTab;
  await vscode.commands.executeCommand('agentTandem.acceptChanges', request(modified.path));
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab, unrelatedEditor, 'Sidebar review never steals focus from a workspace editor');
  assert.equal(api.viewState().review!.files.length, 1);
  await vscode.commands.executeCommand('agentTandem.previewReview', request());
  await vscode.commands.executeCommand('agentTandem.acceptChanges', request());
  assert.equal(api.viewState().review!.files.length, 0, 'Explicit Accept all clears the pending review');
  assert.equal(await readFile(reviewFile('added.txt'), 'utf8'), 'accepted again\n', 'Accept all preserves applied code');
  assert.ok(!tabs().some(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === 'agenttandem-review'));
  assert.ok(historicalTabs.every(tab => tabs().includes(tab)), 'Saved-step history tabs survive pending review decisions');
  checks.push('File Accept retains other pending files; review editors and counters refresh; Accept all closes completed pending diffs, keeps applied code, history and unrelated editor focus');
  checks.push('Review file clicks focus native diff editors; View changes opens multi-file comparison; added/deleted and large files retain complete snapshots, stale requests fail and Accept/Revert still work');
  const stopRun = api.runDemo(3000);
  await waitFor(() => api.sessions()[0]?.steps[0]?.status === 'running', 'stoppable step begins');
  api.stop(); const stopped = await stopRun;
  assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.steps.length, 1);
  checks.push('Stop interrupts the fixture and does not run subsequent steps');
  const abandonedId = randomUUID();
  await api.history.saveSession({ ...session, id: abandonedId, title: 'Interrupted reload fixture', status: 'running',
    steps: [{ id: randomUUID(), title: 'Unfinished step', status: 'running', before: session.baseline, changes: [], output: '', captureMode: 'exact' }] });
  const report = { success: true, vscode: vscode.version, checks,
    sessionId: session.id, stepId: first.id, afterId: first.after, abandonedId, reviewSnapshot: { hash: modified.before!, file: modified.path },
    tabs: vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({ label: tab.label, input: tab.input?.constructor.name }))) };
  if (directory) { await mkdir(directory, { recursive: true }); await writeFile(`${directory}/extension-test.json`, JSON.stringify(report, null, 2)); }
  console.log(`AGENT_TANDEM_EXTENSION_TEST ${JSON.stringify(report)}`);
}

function pathForMissingExecutable() {
  return vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, `missing-codex-${randomUUID()}.exe`).fsPath;
}
