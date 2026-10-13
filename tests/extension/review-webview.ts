import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ReviewStore } from '../../src/core/review';
import { CheckpointStore } from '../../src/core/checkpoints';
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
  const readme = process.env.AGENT_TANDEM_README_SCREENSHOTS === '1';
  const index = await api.syncConversations();
  const source = index.conversations.find(conversation => conversation.id === '11111111-1111-4111-8111-111111111111')!;
  const other = index.conversations.find(conversation => conversation.id === '22222222-2222-4222-8222-222222222222')!;
  assert.ok(source); assert.ok(other);
  assert.equal(vscode.workspace.getConfiguration('agentTandem').get('reviewEditor'), 'webview');
  assert.equal(vscode.workspace.getConfiguration('agentTandem').inspect('reviewEditor')?.defaultValue, 'webview');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  if ((await vscode.commands.getCommands(true)).includes('workbench.action.closeAuxiliaryBar')) await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  const first = '01-source.ts', added = '02-added.ts', deleted = '03-deleted.ts', binary = '04-binary.dat';
  const image = '05-image.png', addedImage = '06-added.svg', deletedImage = '07-deleted.svg', brokenImage = '08-broken.png';
  const oldImage = await readFile(path.join(extension.extensionPath, 'media', 'icon.png'));
  const newImage = await readFile(path.join(extension.extensionPath, 'media', 'screenshots', 'editor-diff.png'));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="red"/></svg>';
  const context = readme ? `
type ReviewMode = 'code' | 'image';

export function previewMode(file: string): ReviewMode {
  const extension = file.split('.').pop()?.toLowerCase();
  const images = new Set(['png', 'jpg', 'webp', 'svg']);

  if (extension && images.has(extension)) {
    return 'image';
  }

  return 'code';
}

` : 'export const context = true;\n'.repeat(10);
  const before = 'export const first = 1;\n' + context + 'export const last = 2;\n';
  const after = before.replace('first = 1', 'first = 100').replace('last = 2', 'last = 200');
  const store = new ReviewStore(path.join(api.history.directory, 'reviews'));
  await writeFile(path.join(project, first), before); await writeFile(path.join(project, deleted), 'deleted contents\n');
  await writeFile(path.join(project, binary), Buffer.from([0, 1]));
  await writeFile(path.join(project, image), oldImage); await writeFile(path.join(project, deletedImage), svg);
  await writeFile(path.join(project, brokenImage), oldImage);
  const cover = (updated: boolean) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${updated ? '#152d48' : '#d3e9ef'}"/><stop offset="1" stop-color="${updated ? '#c6907d' : '#f5ecda'}"/></linearGradient></defs><rect width="640" height="360" fill="url(#sky)"/><circle cx="${updated ? 478 : 490}" cy="${updated ? 118 : 86}" r="${updated ? 43 : 34}" fill="${updated ? '#ffcda0' : '#fff8dc'}"/><path d="M0 270 130 145 255 265 380 120 525 260 640 160V360H0Z" fill="${updated ? '#486578' : '#a4b9b8'}"/><path d="M0 310 180 205 325 310 490 210 640 285V360H0Z" fill="${updated ? '#233b4e' : '#779397'}"/><path d="M0 345Q190 260 370 340T640 302V360H0Z" fill="${updated ? '#142b39' : '#44666c'}"/></svg>`;
  if (readme) await writeFile(path.join(project, '09-cover.svg'), cover(false));
  await store.begin(project, 'webview-review', undefined, source);
  const checkpoints = new CheckpointStore(path.join(api.history.directory, 'checkpoints'));
  await checkpoints.record(project, source.key, ['Review new code and image changes'], await store.checkpointBefore(project, 'webview-review'));
  await writeFile(path.join(project, first), after); await writeFile(path.join(project, added), 'export const start = 1;\n' + '// full file context\n'.repeat(800) + 'export const tailMarker = "<img src=x onerror=alert(1)>";\n');
  await unlink(path.join(project, deleted)); await writeFile(path.join(project, binary), Buffer.from([0, 2]));
  await writeFile(path.join(project, image), newImage); await writeFile(path.join(project, addedImage), svg);
  await unlink(path.join(project, deletedImage)); await writeFile(path.join(project, brokenImage), Buffer.from([0, 2]));
  if (readme) await writeFile(path.join(project, '09-cover.svg'), cover(true));
  await store.finish(project, 'webview-review'); await vscode.commands.executeCommand('agentTandem.refreshReview');
  const request = () => ({ project, revision: api.viewState().review!.revision, file: first });
  await vscode.commands.executeCommand('agentTandem.previewReview', request());
  await until(() => !!api.reviewWebviewState()?.file?.hunks.length, 'shared Webview editor loads immutable blocks');
  await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview, 'Webview review tab becomes active');
  assert.equal(api.reviewWebviewState()!.files.length, readme ? 9 : 8);
  assert.equal(api.reviewWebviewState()!.file!.hunks.length, 2);
  const stage = async (name: string) => {
    await writeFile(path.join(runtime, 'stage.json'), JSON.stringify({ stage: name }));
    await until(async () => readFile(path.join(runtime, `${name}.done`), 'utf8').then(() => true, () => false), `${name} UI clicks`);
  };
  const initialRevision = api.viewState().review!.revision;
  await stage('dark');
  assert.equal(api.reviewWebviewState()!.context!.conversation!.key, source.key);
  assert.equal(api.reviewWebviewState()!.context!.canOpenConversation, true);
  await stage('agent-list');
  await until(() => api.reviewWebviewState()?.group === source.key && api.reviewWebviewState()?.file?.path === first, 'Agent file picker retains its conversation scope');
  await api.openConversation(other.key);
  await stage('conversation-link');
  await until(() => api.conversation()?.conversation.key === source.key && api.viewState().screen === 'conversations' && !!api.viewState().checkpointPreview, 'Conversation link opens the correct extension chat and Restore previews its checkpoint');
  assert.equal(await readFile(path.join(project, first), 'utf8'), after, 'Restore preview preserves workspace bytes');
  await vscode.commands.executeCommand('agentTandem.closeCheckpointPreview');
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await vscode.commands.executeCommand('agentTandem.previewReview', request());
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
  await stage('image');
  await until(() => api.reviewWebviewState()?.file?.path === image, 'Image comparison opens');
  assert.equal(api.reviewWebviewState()!.file!.images!.before.src, `data:image/png;base64,${oldImage.toString('base64')}`);
  assert.equal(api.reviewWebviewState()!.file!.images!.after.src, `data:image/png;base64,${newImage.toString('base64')}`);
  await stage('image-narrow');
  await stage('added-image'); await stage('deleted-image'); await stage('broken-image');
  if (readme) await stage('readme-image');
  await stage('native-image');
  await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview && api.changeNavigationState()?.file === image, 'Editor image diff keeps its file navigation scope');
  await stage('image-to-code');
  await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff && api.changeNavigationState()?.file === binary, 'Previous file crosses from image to code');
  await vscode.commands.executeCommand('agentTandem.nextFile'); await stage('code-to-image');
  await until(() => api.changeNavigationState()?.file === image, 'Next file crosses from code to image');
  await vscode.commands.executeCommand('agentTandem.previewReview', { project, revision: api.viewState().review!.revision, file: binary });
  await stage('native');
  await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff, 'Optional native diff opens');
  const recorded = path.join(runtime, 'recorded-images'); await mkdir(recorded);
  await writeFile(path.join(recorded, 'asset.png'), oldImage); await writeFile(path.join(recorded, 'deleted.svg'), svg);
  const baseline = await api.history.capture(recorded);
  await writeFile(path.join(recorded, 'asset.png'), newImage); await unlink(path.join(recorded, 'deleted.svg'));
  const afterSnapshot = await api.history.capture(recorded), sessionId = randomUUID(), stepId = randomUUID();
  await api.history.saveSession({ version: 1, id: sessionId, title: 'Image history', source: 'demo', createdAt: new Date().toISOString(), status: 'completed', baseline: baseline.id,
    steps: [{ id: stepId, title: 'Saved image changes', status: 'completed', before: baseline.id, after: afterSnapshot.id, changes: await api.history.changes(baseline.id, afterSnapshot.id), output: '', captureMode: 'exact' }] });
  await api.refreshFromStorage();
  await writeFile(path.join(recorded, 'asset.png'), 'newer workspace contents');
  await vscode.commands.executeCommand('agentTandem.openStepInEditor', { sessionId, stepId }); await stage('saved-image');
  assert.equal(api.changeNavigationState()?.file, 'asset.png');
  await vscode.commands.executeCommand('agentTandem.openCumulativeInEditor', { sessionId, stepId, file: 'asset.png' }); await stage('cumulative-image');
  await vscode.commands.executeCommand('agentTandem.openFileInEditor', { sessionId, stepId, file: 'deleted.svg' }); await stage('saved-deleted-image');
  assert.equal(await readFile(path.join(recorded, 'asset.png'), 'utf8'), 'newer workspace contents');
  const report = { success: true, edition, vscode: vscode.version, checks: ['Monaco Webview default in both editions', 'Full-file context with inline colored buttons', 'Monaco worker diff and syntax tokens', 'Ctrl+F reaches line 802 without truncation', 'Source HTML stays inert', 'Dark/light/narrow layouts', 'Accept preserves bytes', 'Stale block actions are rejected', 'Reject restores only its block', 'Undo restores rejected bytes', 'Newer saved edits block rejection', 'Dirty buffers block rejection', 'Navigation crosses files', 'Binary file fallback', 'Native diff'] };
  report.checks.push('Old/new PNG snapshots decode', 'Added/deleted SVG previews', 'Broken image retains the other side', 'Narrow image layout', 'Image editor navigation to/from code', 'Saved step/cumulative image comparisons preserve workspace bytes');
  report.checks.push('Agent change list retains conversation scope', 'Conversation shortcut opens the correct extension chat', 'Visible Restore code opens a checkpoint preview without writing files');
  await writeFile(path.resolve(runtime, '..', '..', 'artifacts', `review-webview-${edition}.json`), JSON.stringify(report, null, 2));
  await writeFile(path.join(runtime, 'stage.json'), JSON.stringify({ stage: 'complete' }));
  console.log(`REVIEW_WEBVIEW_TEST ${JSON.stringify(report)}`);
}
