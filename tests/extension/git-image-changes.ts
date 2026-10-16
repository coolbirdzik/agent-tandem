import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExtensionAPI } from '../../src/extension';
import { gitImageChanges } from '../../src/host/git-image-changes';

const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd, windowsHide: true });
async function waitFor<T>(get: () => T | Promise<T>, description: string): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const value = await get(); if (value) return value as NonNullable<T>;
    if (Date.now() - start > 20_000) throw new Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}
// A real 1×1 PNG (binary, with NUL bytes) so VS Code takes its binary image-diff path; the suffix makes each side distinct.
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const bytes = (text: string) => Buffer.concat([pixel, Buffer.from(text)]);
// Counts VS Code's image-diff crash in this test window's renderer logs.
async function selectionErrors() {
  const logs = path.join(process.env.AGENT_TANDEM_GIT_IMAGES_RUNTIME!, 'profile', 'logs');
  const files = (await readdir(logs, { recursive: true })).filter(name => String(name).endsWith('renderer.log'));
  const texts = await Promise.all(files.map(name => readFile(path.join(logs, String(name)), 'utf8').catch(() => '')));
  return texts.join('\n').split("reading 'selection'").length - 1;
}
const read = (uri: vscode.Uri) => vscode.workspace.fs.readFile(uri).then(value => Buffer.from(value), () => undefined);

export async function run() {
  const api = await vscode.extensions.getExtension<ExtensionAPI>(process.env.AGENT_TANDEM_EXTENSION_ID || 'agent-tandem-local.agent-tandem')!.activate();
  const project = vscode.workspace.workspaceFolders![0]!.uri.fsPath, file = (name: string) => vscode.Uri.file(path.join(project, name));
  await git(project, 'init', '-q'); await git(project, 'config', 'user.email', 'test@example.test'); await git(project, 'config', 'user.name', 'Test');
  for (const [name, text] of [['a.png', 'a-head'], ['b.png', 'b-head'], ['note.txt', 'note']] as const) await writeFile(path.join(project, name), name.endsWith('.png') ? bytes(text) : text);
  await git(project, 'add', '.'); await git(project, 'commit', '-qm', 'initial');
  await writeFile(path.join(project, 'a.png'), bytes('a-work'));
  await writeFile(path.join(project, 'b.png'), bytes('b-index')); await git(project, 'add', 'b.png');
  await writeFile(path.join(project, 'c.png'), bytes('c-new')); await writeFile(path.join(project, 'note.txt'), 'changed');
  const gitApi = (await vscode.extensions.getExtension<any>('vscode.git')!.activate()).getAPI(1);
  const repository = await waitFor(() => gitApi.getRepository(file('a.png')), 'Git opens the test repository');
  await waitFor(async () => { await repository.status(); return repository.state.workingTreeChanges.length >= 2 && repository.state.indexChanges.length === 1; }, 'Git reports staged and unstaged changes');

  // Unstaged images: index (here HEAD) → working tree, including the untracked image with no original.
  const unstaged = await gitImageChanges(file('a.png'));
  assert.deepEqual(unstaged.files.map(row => row.file).sort(), ['a.png', 'c.png']);
  const a = unstaged.files[unstaged.index]!;
  assert.equal(a.file, 'a.png');
  assert.deepEqual(await read(a.original), bytes('a-head')); assert.deepEqual(await read(a.modified), bytes('a-work'));
  const c = unstaged.files.find(row => row.file === 'c.png')!;
  assert.equal((await read(c.original))?.length ?? 0, 0); assert.deepEqual(await read(c.modified), bytes('c-new'));

  // A staged Source Control resource compares HEAD → index, not the working tree.
  const staged = await gitImageChanges({ resourceUri: file('b.png'), resourceGroupType: 1 });
  assert.deepEqual(staged.files.map(row => row.file), ['b.png']);
  assert.deepEqual(await read(staged.files[0]!.original), bytes('b-head')); assert.deepEqual(await read(staged.files[0]!.modified), bytes('b-index'));
  await assert.rejects(gitImageChanges(file('note.txt')), /image files/);
  await assert.rejects(gitImageChanges({ resourceUri: file('a.png'), resourceGroupType: 1 }), /no staged Git changes/);

  // The command opens AgentTandem's image view with file navigation, never VS Code's crashing binary diff.
  await vscode.commands.executeCommand('agentTandem.openImageChanges', { resourceUri: file('a.png'), resourceGroupType: 2 });
  const tab = await waitFor(() => { const active = vscode.window.tabGroups.activeTabGroup.activeTab; return active?.input instanceof vscode.TabInputWebview && active.label.startsWith('a.png') ? active : undefined; }, 'image changes open in AgentTandem');
  assert.match((tab.input as vscode.TabInputWebview).viewType, /agentTandem\.imageDiff$/);
  assert.deepEqual(api.changeNavigationState(), { file: 'a.png', index: 1, total: 2 });
  await vscode.commands.executeCommand('agentTandem.nextFile');
  await waitFor(() => api.changeNavigationState()?.file === 'c.png', 'Next file moves to the next changed image');
  assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(item => item.input instanceof vscode.TabInputTextDiff), false);

  // Git's own Open Changes (a Source Control click) and a restored staged diff are redirected to the image view.
  const activeImage = (name: string) => { const active = vscode.window.tabGroups.activeTabGroup.activeTab; return active?.input instanceof vscode.TabInputWebview && active.label.startsWith(name) ? active : undefined; };
  const textDiffs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(item => item.input instanceof vscode.TabInputTextDiff);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('git.openChange', file('a.png'));
  await waitFor(() => activeImage('a.png'), 'Source Control Open Changes redirects to the image view');
  await waitFor(() => !textDiffs().length, 'Git text diff tab is closed');
  assert.deepEqual(api.changeNavigationState(), { file: 'a.png', index: 1, total: 2 });
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.diff', gitApi.toGitUri(file('b.png'), 'HEAD'), gitApi.toGitUri(file('b.png'), ''), 'b.png (Index)');
  await waitFor(() => activeImage('b.png'), 'staged Git image diff redirects to the image view');
  await waitFor(() => !textDiffs().length, 'staged Git text diff tab is closed');
  assert.deepEqual(api.changeNavigationState(), { file: 'b.png', index: 1, total: 1 });
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(await selectionErrors(), 0, "redirected Git image diffs do not reach VS Code's failing binary image diff");
  await vscode.workspace.getConfiguration('agentTandem').update('openGitImageDiffs', false, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('git.openChange', file('a.png'));
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(item => item.input instanceof vscode.TabInputWebview), false, 'the setting turns redirection off');
  // Control: without redirection this VS Code build hits the crash, so the zero above is meaningful.
  const crashes = await selectionErrors();
  await writeFile(path.join(process.env.AGENT_TANDEM_GIT_IMAGES_RUNTIME!, 'report.json'), JSON.stringify({ success: true, builtInDiffCrashes: crashes }));
}
