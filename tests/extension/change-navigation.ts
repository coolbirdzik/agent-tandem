import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExtensionAPI } from '../../src/extension';
import { ReviewStore } from '../../src/core/review';
import { reviewSnapshotUri } from '../../src/host/review-editor';

const delay = () => new Promise(resolve => setTimeout(resolve, 100));
async function waitFor(predicate: () => boolean, description: string) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > 10_000) throw new Error(`Timed out: ${description}`); await delay(); }
}
const codeLenses = (uri: vscode.Uri) => vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri);
export async function run() {
  const api = await vscode.extensions.getExtension<ExtensionAPI>('agent-dock-local.agent-dock')!.activate();
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  const runtime = process.env.AGENT_DOCK_NAV_RUNTIME!;
  const reportFile = path.join(runtime, '..', '..', 'artifacts/change-navigation-test.json');
  if (process.env.AGENT_DOCK_NAV_REOPEN) {
    const prior = JSON.parse(await readFile(reportFile, 'utf8'));
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.parse(prior.last.original), vscode.Uri.parse(prior.last.modified), 'restored · AgentDock changes');
    await waitFor(() => api.changeNavigationState()?.total === 4, 'saved navigation scope restores after restarting Extension Host');
    const editor = vscode.window.activeTextEditor!;
    editor.selection = new vscode.Selection(21, 0, 21, 0);
    await new Promise(resolve => setTimeout(resolve, 800));
    await vscode.commands.executeCommand('agentDock.nextChange');
    await waitFor(() => api.changeNavigationState()?.index === 1, 'restored last file advances to first');
    await writeFile(path.join(runtime, 'reopen-report.json'), JSON.stringify({ success: true, counter: api.changeNavigationState() }, null, 2));
    return;
  }
  const project = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  await promisify(execFile)('git', ['init', '-q'], { cwd: project, windowsHide: true });
  const first = '01-first.ts', added = '02-added.ts', deleted = '03-deleted.ts', last = '04-last.ts';
  const before = Array.from({ length: 120 }, (_, i) => `export const value${i + 1} = ${i + 1};`).join('\n') + '\n';
  const after = before.replace('value8 = 8', 'value8 = 800').replace('value55 = 55', 'value55 = 5500').replace('value100 = 100', 'value100 = 10000');
  const lastBefore = 'before\n' + 'same\n'.repeat(20) + 'tail before\n';
  const lastAfter = 'after\n' + 'same\n'.repeat(20) + 'tail after\n';
  const reviews = new ReviewStore(path.join(api.history.directory, 'reviews'));
  await writeFile(path.join(project, first), before);
  await writeFile(path.join(project, deleted), 'deleted original\n');
  await writeFile(path.join(project, last), lastBefore);
  await reviews.begin(project, 'navigation-test');
  await writeFile(path.join(project, first), after);
  await writeFile(path.join(project, added), 'added contents\n');
  await unlink(path.join(project, deleted));
  await writeFile(path.join(project, last), lastAfter);
  const captured = await reviews.finish(project, 'navigation-test');
  assert.equal(captured.files.length, 4);
  await vscode.commands.executeCommand('agentDock.refreshReview');
  const request = (file?: string) => ({ project, revision: api.viewState().review!.revision, file });
  const openSingle = async (file = first, line = 0) => {
    await vscode.commands.executeCommand('agentDock.previewReview', request(file));
    await waitFor(() => api.changeNavigationState()?.file === file, 'single file navigation scope');
    const editor = vscode.window.activeTextEditor!;
    editor.selection = new vscode.Selection(line, 0, line, 0);
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.AtTop);
    await new Promise(resolve => setTimeout(resolve, 800));
    return editor;
  };
  const openMulti = async () => {
    await vscode.commands.executeCommand('agentDock.previewReview', request());
    await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label.includes('Pending changes') ?? false, 'multi-file changes active');
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(api.changeNavigationState()?.total, 4);
  };
  const visited: unknown[] = [];
  const move = async (direction: 'next' | 'previous', file: string, line: number) => {
    await vscode.commands.executeCommand(`agentDock.${direction}Change`);
    await waitFor(() => api.changeNavigationState()?.file === file && vscode.window.activeTextEditor?.selection.active.line === line, `${direction}: ${file}:${line + 1}`);
    const state = api.changeNavigationState()!;
    assert.equal(state.total, 4);
    assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.label.includes(`File ${state.index}/4`));
    visited.push({ direction, ...state, line });
  };
  const editor = await openSingle();
  for (const [file, line] of [[first, 7], [first, 54], [first, 99], [added, 0], [deleted, 0], [last, 0], [last, 21], [first, 7]] as const) await move('next', file, line);
  for (const [file, line] of [[last, 21], [last, 0], [deleted, 0], [added, 0], [first, 99]] as const) await move('previous', file, line);
  assert.equal(editor.document.getText(), after);
  const initial = captured.files.find(file => file.path === first)!;
  assert.equal((await vscode.workspace.openTextDocument(reviewSnapshotUri(initial.before, first))).getText(), before);
  // Rapid clicks are processed in order across file boundaries.
  await openSingle(first, 99);
  await Promise.all([1, 2, 3].map(() => vscode.commands.executeCommand('agentDock.nextChange')));
  await waitFor(() => api.changeNavigationState()?.file === last, 'queued Next clicks reach fourth file');
  await openMulti();
  const multiFiles = new Set<string>();
  for (let i = 0; i < 10; i++) {
    await vscode.commands.executeCommand('agentDock.nextChange'); await delay();
    const state = api.changeNavigationState()!; assert.equal(state.total, 4); multiFiles.add(state.file);
    console.log(`MULTI_FILE_POSITION ${JSON.stringify({ state, uri: vscode.window.activeTextEditor?.document.uri.toString(), line: vscode.window.activeTextEditor?.selection.active.line })}`);
  }
  assert.equal(multiFiles.size, 4, 'Native multi-file navigation reaches every file, including add/delete');
  const plain = await vscode.workspace.openTextDocument({ content: 'untouched\n' });
  await vscode.window.showTextDocument(plain);
  assert.equal(api.changeNavigationState(), undefined, 'Counter hides in unrelated editors');
  await vscode.commands.executeCommand('agentDock.nextChange');
  assert.equal(vscode.window.activeTextEditor?.document, plain);
  if (process.env.AGENT_DOCK_NAV_VISUAL) {
    for (const stage of ['badge', 'single', 'multi']) {
      if (stage === 'badge') await openSingle(first, 0);
      else if (stage === 'single') await openSingle(first, 99); else await openMulti();
      const selections: unknown[] = [];
      const listener = vscode.window.onDidChangeTextEditorSelection(event => selections.push({ uri: event.textEditor.document.uri.toString(), line: event.selections[0]?.active.line }));
      await writeFile(path.join(runtime, 'stage.json'), JSON.stringify({ stage, counter: api.changeNavigationState(), title: vscode.window.tabGroups.activeTabGroup.activeTab?.label }));
      const start = Date.now();
      while (!await readFile(path.join(runtime, `${stage}.done`), 'utf8').then(() => true, () => false)) {
        if (Date.now() - start > 600_000) throw new Error(`Visual test timed out: ${stage}`);
        await delay();
      }
      listener.dispose();
      await writeFile(path.join(runtime, `${stage}-clicks.json`), JSON.stringify(selections, null, 2));
    }
  }
  // The compact lens row must work on released builds, where editor insets are unavailable.
  const settings = () => vscode.workspace.getConfiguration('agentDock');
  await settings().update('blockActionsStyle', 'lens', vscode.ConfigurationTarget.Global);
  const lensEditor = await openSingle(first, 0);
  assert.equal(vscode.workspace.getConfiguration('diffEditor').get<boolean>('codeLens'), true, 'Opening a review enables diff code lenses');
  const lensHunks = await reviews.hunks({ project, revision: api.viewState().review!.revision, file: first });
  assert.equal(lensHunks.length, 3);
  const rendered = await codeLenses(lensEditor.document.uri);
  for (const [index, hunk] of lensHunks.entries()) {
    const row = rendered.filter(lens => lens.range.start.line === hunk.newLine).map(lens => lens.command?.title);
    assert.deepEqual(row, ['$(check) Accept', '$(discard) Reject', '$(arrow-down) Next change', `Block ${index + 1}/3`],
      `block ${index + 1} renders its own Accept/Reject/Next row at line ${hunk.newLine + 1}`);
  }
  // Cards take over the editor wherever insets work, so the two styles never stack.
  await settings().update('blockActionsStyle', 'auto', vscode.ConfigurationTarget.Global);
  await openSingle(first, 0);
  assert.equal((await codeLenses(lensEditor.document.uri)).length, 0, 'Card style replaces the lens row instead of adding to it');
  if (!process.env.AGENT_DOCK_NAV_VISUAL) await settings().update('blockActionsStyle', 'lens', vscode.ConfigurationTarget.Global);
  // Floating review actions decide one hunk, not the entire file.
  const firstBeforeAccept = api.viewState().review!.files.find(file => file.path === first)!.before;
  for (const [stage, line] of [
    ['hunkAccept', 7],
    ['hunkRevert', 54],
  ] as const) {
    let blockEditor: vscode.TextEditor;
    if (stage === 'hunkRevert' && process.env.AGENT_DOCK_NAV_VISUAL) {
      await openMulti();
      for (let attempt = 0; attempt < 20; attempt++) {
        if (api.changeNavigationState()?.file === first && vscode.window.activeTextEditor?.selection.active.line === line) break;
        await vscode.commands.executeCommand('agentDock.nextChange'); await delay();
      }
      assert.equal(vscode.window.activeTextEditor?.selection.active.line, line, 'Multi-file preview reveals target block');
      blockEditor = vscode.window.activeTextEditor!;
      blockEditor.selection = new vscode.Selection(line + 2, 0, line + 2, 0);
    } else blockEditor = await openSingle(first, stage === 'hunkAccept' ? 20 : 0);
    // Keep the cursor outside both target changes. Buttons must bind their own block.
    const cursorLine = blockEditor.selection.active.line;
    if (process.env.AGENT_DOCK_NAV_VISUAL) {
      await vscode.workspace.getConfiguration('editor').update('fontSize', 10, vscode.ConfigurationTarget.Global);
      await vscode.workspace.getConfiguration('editor').update('lineHeight', 13, vscode.ConfigurationTarget.Global);
      if (stage === 'hunkAccept') blockEditor.revealRange(new vscode.Range(Math.max(0, line - 5), 0, Math.min(119, line + 35), 0), vscode.TextEditorRevealType.AtTop);
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    const revision = api.viewState().review!.revision;
    if (process.env.AGENT_DOCK_NAV_VISUAL) {
      const blocks = await reviews.hunks({ project, revision, file: first });
      const blockIndex = blocks.findIndex(hunk => hunk.newLine === line) + 1;
      assert.ok(blockIndex, `target block exists at line ${line + 1}`);
      await writeFile(path.join(runtime, 'stage.json'), JSON.stringify({ stage, line, cursorLine, file: first, blockIndex, blockCount: blocks.length }));
      const start = Date.now();
      while (!await readFile(path.join(runtime, `${stage}.done`), 'utf8').then(() => true, () => false)) {
        if (Date.now() - start > 60_000) throw new Error(`Visual test timed out: ${stage}`);
        await delay();
      }
    } else {
      // Click the block's own lens: the action must carry its hunk, not the cursor.
      const action = stage === 'hunkAccept' ? 'agentDock.acceptHunk' : 'agentDock.rejectHunk';
      const lens = (await codeLenses(blockEditor.document.uri)).find(lens => lens.range.start.line === line && lens.command?.command === action);
      assert.ok(lens, `${stage} renders its action lens at line ${line + 1}`);
      await vscode.commands.executeCommand(lens.command!.command, ...(lens.command!.arguments ?? []));
    }
    await waitFor(() => api.viewState().review?.revision !== revision, `${stage} publishes a review decision`);
    const review = api.viewState().review!;
    assert.equal(review.files.length, 4, 'Individual hunk decision leaves the file and other files pending');
    const pending = review.files.find(file => file.path === first)!;
    assert.notEqual(pending.before, firstBeforeAccept, 'Accepted hunk becomes part of the pending baseline');
    const content = await readFile(path.join(project, first), 'utf8');
    if (stage === 'hunkAccept') {
      assert.equal(content, after, 'Accept hunk leaves every workspace byte unchanged');
      assert.equal((await reviews.hunks({ project, revision: review.revision, file: first })).length, 2);
    } else {
      assert.equal(content, after.replace('value55 = 5500', 'value55 = 55'), 'Revert restores only the second hunk');
      assert.equal((await reviews.hunks({ project, revision: review.revision, file: first })).length, 1);
    }
    await writeFile(path.join(runtime, `${stage}-result.json`), JSON.stringify({ success: true, revision: review.revision, pendingFiles: review.files.length, cursorWasOutsideBlock: cursorLine !== line }));
  }
  const reviewedRevision = api.viewState().review!.revision;
  const originalFirst = captured.files.find(file => file.path === first)!;
  await vscode.commands.executeCommand('vscode.diff', reviewSnapshotUri(originalFirst.before, first), reviewSnapshotUri(originalFirst.after, first), 'Old review preview');
  vscode.window.activeTextEditor!.selection = new vscode.Selection(7, 0, 7, 0);
  await new Promise(resolve => setTimeout(resolve, 800));
  await vscode.commands.executeCommand('agentDock.revertCurrentChange');
  assert.equal(api.viewState().review!.revision, reviewedRevision, 'Old preview cannot revert an accepted hunk');
  await vscode.commands.executeCommand('agentDock.acceptHunk', { project, revision: 'stale-revision', file: first, hunk: 'stale-hunk', line: 7 });
  assert.equal(api.viewState().review!.revision, reviewedRevision, 'A stale lens cannot decide a block');
  assert.equal((await codeLenses(vscode.window.activeTextEditor!.document.uri)).length, 0, 'Old previews render no block actions');
  assert.equal(await readFile(path.join(project, first), 'utf8'), after.replace('value55 = 5500', 'value55 = 55'));
  const workspaceEditor = await vscode.window.showTextDocument(vscode.Uri.file(path.join(project, first)));
  await workspaceEditor.edit(edit => edit.insert(new vscode.Position(0, 0), '// my unsaved change\n'));
  await openSingle(first, 99);
  await vscode.commands.executeCommand('agentDock.revertCurrentChange');
  assert.equal(api.viewState().review!.revision, reviewedRevision, 'Dirty workspace editor blocks per-hunk revert');
  assert.match(api.viewState().error!, /unsaved edits/);
  assert.ok(workspaceEditor.document.getText().startsWith('// my unsaved change'));
  await vscode.window.showTextDocument(workspaceEditor.document);
  await vscode.commands.executeCommand('undo');
  await waitFor(() => !workspaceEditor.document.isDirty, 'owned test edit undone');
  await openSingle(last, 21);
  const lastFile = captured.files.find(file => file.path === last)!;
  const report = { success: true, vscode: vscode.version, visited, multiFiles: [...multiFiles], last: { original: reviewSnapshotUri(lastFile.before, last).toString(), modified: reviewSnapshotUri(lastFile.after, last).toString() }, checks: ['Single-file clicks retain all four files', 'Next/Previous cross file boundaries and wrap', 'Added/deleted files and first-line hunks remain reachable', 'Rapid clicks serialize', 'Counter updates and hides in unrelated editors', 'Floating Accept/Revert decide only the selected hunk', 'Old previews and dirty workspace edits block hunk decisions', 'Every block renders an Accept/Reject/Next lens row that decides its own hunk'] };
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(`AGENT_DOCK_NAV_TEST ${JSON.stringify(report)}`);
}
