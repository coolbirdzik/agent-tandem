import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ReviewStore } from '../../src/core/review';
import type { ExtensionAPI } from '../../src/extension';
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function until(get: () => Promise<boolean> | boolean, description: string) {
  const start = Date.now(); while (!await get()) { if (Date.now() - start > 60_000) throw new Error(`Timed out: ${description}`); await pause(); }
}
export async function run() {
  const extension = vscode.extensions.getExtension(process.env.AGENT_TANDEM_EXTENSION_ID!)!;
  const api = await extension.activate() as ExtensionAPI;
  const runtime = process.env.AGENT_TANDEM_REVIEW_RUNTIME!, project = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const edition = process.env.AGENT_TANDEM_REVIEW_EDITION!;
  assert.equal(vscode.workspace.getConfiguration('agentTandem').get('reviewEditor'), 'webview');
  assert.equal(vscode.workspace.getConfiguration('agentTandem').inspect('reviewEditor')?.defaultValue, 'webview');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  if ((await vscode.commands.getCommands(true)).includes('workbench.action.closeAuxiliaryBar')) await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  const first = '01-source.ts', added = '02-added.ts', deleted = '03-deleted.ts', binary = '04-binary.dat';
  const before = 'export const first = 1;\n' + 'export const context = true;\n'.repeat(10) + 'export const last = 2;\n';
  const after = before.replace('first = 1', 'first = 100').replace('last = 2', 'last = 200');
  const store = new ReviewStore(path.join(api.history.directory, 'reviews'));
  await writeFile(path.join(project, first), before); await writeFile(path.join(project, deleted), 'deleted contents\n');
  await writeFile(path.join(project, binary), Buffer.from([0, 1]));
  await store.begin(project, 'webview-review');
  await writeFile(path.join(project, first), after); await writeFile(path.join(project, added), 'export const start = 1;\n' + '// full file context\n'.repeat(800) + 'export const tailMarker = "<img src=x onerror=alert(1)>";\n');
  await unlink(path.join(project, deleted)); await writeFile(path.join(project, binary), Buffer.from([0, 2]));
  await store.finish(project, 'webview-review'); await vscode.commands.executeCommand('agentTandem.refreshReview');
  const request = () => ({ project, revision: api.viewState().review!.revision, file: first });
  await vscode.commands.executeCommand('agentTandem.previewReview', request());
  await until(() => !!api.reviewWebviewState()?.file?.hunks.length, 'shared Webview editor loads immutable blocks');
  await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview, 'Webview review tab becomes active');
  assert.equal(api.reviewWebviewState()!.files.length, 4);
  assert.equal(api.reviewWebviewState()!.file!.hunks.length, 2);
  const stage = async (name: string) => {
    await writeFile(path.join(runtime, 'stage.json'), JSON.stringify({ stage: name }));
    await until(async () => readFile(path.join(runtime, `${name}.done`), 'utf8').then(() => true, () => false), `${name} UI clicks`);
  };
  const initialRevision = api.viewState().review!.revision;
  await stage('dark');
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
  await stage('light');
  await stage('narrow');
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Global);
  await stage('accept');
  await until(() => api.viewState().review?.revision !== initialRevision && api.reviewWebviewState()?.file?.hunks.length === 1 && !api.reviewWebviewState()?.busy, 'Accept updates the pending blocks');
  assert.equal(await readFile(path.join(project, first), 'utf8'), after, 'Accept keeps workspace bytes');
  await stage('stale');
  await until(() => !!api.reviewWebviewState()?.error?.includes('Changes updated'), 'Stale block action is rejected by the bridge');
  assert.equal(await readFile(path.join(project, first), 'utf8'), after, 'Stale block action preserves disk bytes');
  const acceptedRevision = api.viewState().review!.revision;
  await stage('reject');
  await until(() => api.viewState().review?.revision !== acceptedRevision && !api.viewState().review!.files.some(file => file.path === first), 'Reject resolves the remaining block');
  assert.equal(await readFile(path.join(project, first), 'utf8'), after.replace('last = 200', 'last = 2'), 'Reject keeps the accepted block');
  await stage('undo');
  await until(() => api.viewState().review!.files.some(file => file.path === first) && !api.reviewWebviewState()?.busy, 'Undo restores the rejected block');
  assert.equal(await readFile(path.join(project, first), 'utf8'), after);
  await vscode.commands.executeCommand('agentTandem.previewReview', request());
  await writeFile(path.join(project, first), '// newer saved edit\n' + after);
  await stage('external');
  await until(() => !!api.reviewWebviewState()?.error?.includes('changed after the agent'), 'Newer saved edit blocks rejection');
  assert.equal(await readFile(path.join(project, first), 'utf8'), '// newer saved edit\n' + after);
  await writeFile(path.join(project, first), after);
  const dirty = await vscode.workspace.openTextDocument(path.join(project, first));
  const edit = new vscode.WorkspaceEdit(); edit.insert(dirty.uri, new vscode.Position(0, 0), '// unsaved\n'); await vscode.workspace.applyEdit(edit);
  await stage('dirty');
  await until(() => !!api.reviewWebviewState()?.error?.includes('unsaved'), 'Dirty-buffer conflict appears inside review');
  assert.equal(await readFile(path.join(project, first), 'utf8'), after, 'Dirty-buffer conflict preserves disk bytes');
  await vscode.commands.executeCommand('workbench.action.files.revert', dirty.uri);
  // A file can be open only as a background document; drop its buffer explicitly after reverting.
  if (dirty.isDirty) { const revert = new vscode.WorkspaceEdit(); revert.replace(dirty.uri, new vscode.Range(0, 0, dirty.lineCount, 0), after); await vscode.workspace.applyEdit(revert); await dirty.save(); }
  await stage('navigation');
  await until(() => api.reviewWebviewState()?.file?.path === deleted, 'Navigation crosses to the deleted file');
  await stage('binary');
  await until(() => api.reviewWebviewState()?.file?.path === binary, 'File picker opens binary metadata');
  assert.match(api.reviewWebviewState()!.file!.notice!, /Binary/);
  await stage('native');
  await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff, 'Optional native diff opens');
  const report = { success: true, edition, vscode: vscode.version, checks: ['Monaco Webview default in both editions', 'Full-file context with inline colored buttons', 'Monaco worker diff and syntax tokens', 'Ctrl+F reaches line 802 without truncation', 'Source HTML stays inert', 'Dark/light/narrow layouts', 'Accept preserves bytes', 'Stale block actions are rejected', 'Reject restores only its block', 'Undo restores rejected bytes', 'Newer saved edits block rejection', 'Dirty buffers block rejection', 'Navigation crosses files', 'Binary file fallback', 'Native diff'] };
  await writeFile(path.resolve(runtime, '..', '..', 'artifacts', `review-webview-${edition}.json`), JSON.stringify(report, null, 2));
  await writeFile(path.join(runtime, 'stage.json'), JSON.stringify({ stage: 'complete' }));
  console.log(`REVIEW_WEBVIEW_TEST ${JSON.stringify(report)}`);
}
