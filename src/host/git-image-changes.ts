import * as vscode from 'vscode';
import { imageMime } from '../core/media-preview';
import type { ChangeComparison } from './change-navigation';

// Subset of the built-in Git extension API (version 1) used here.
interface GitChange { uri: vscode.Uri; originalUri: vscode.Uri }
interface GitRepository { state: { indexChanges: GitChange[]; workingTreeChanges: GitChange[]; untrackedChanges?: GitChange[] } }
interface GitAPI { toGitUri(uri: vscode.Uri, ref: string): vscode.Uri; getRepository(uri: vscode.Uri): GitRepository | null }

/** Git's ResourceGroupType: Merge, Index, WorkingTree, Untracked. */
const indexGroup = 1;

async function gitApi(): Promise<GitAPI> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPI }>('vscode.git');
  if (!extension) throw new Error('The built-in Git extension is not available.');
  return (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
}
function targetUri(target: unknown): vscode.Uri | undefined {
  if (target instanceof vscode.Uri) return target;
  const resource = (target as { resourceUri?: unknown } | undefined)?.resourceUri;
  if (resource instanceof vscode.Uri) return resource;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText ? input.uri : undefined;
}

/** The Source Control resource behind a Git diff tab: working tree when the right side is the file, else staged. */
export function gitDiffResource(original: vscode.Uri, modified: vscode.Uri): { resourceUri: vscode.Uri; resourceGroupType: number } | undefined {
  if (original.scheme !== 'git' || !imageMime(modified.path)) return;
  if (modified.scheme === 'file') return { resourceUri: modified, resourceGroupType: 2 };
  if (modified.scheme !== 'git') return;
  try {
    const { path } = JSON.parse(modified.query) as { path?: unknown };
    return typeof path === 'string' ? { resourceUri: vscode.Uri.file(path), resourceGroupType: indexGroup } : undefined;
  } catch { return; }
}

/**
 * Replaces Git's own image diffs (Source Control clicks and tabs restored after reload) with AgentTandem's
 * image view. VS Code swaps a binary text diff for a side-by-side Image Preview whose original pane fails
 * with "Cannot read properties of undefined (reading 'selection')" and closes.
 */
export function redirectGitImageDiffs(open: (resource: { resourceUri: vscode.Uri; resourceGroupType: number }) => Promise<void>,
  report: (error: unknown) => void): vscode.Disposable {
  const pending = new Set<string>();
  const redirect = async (tab: vscode.Tab) => {
    if (!vscode.workspace.getConfiguration('agentTandem').get<boolean>('openGitImageDiffs', true)) return;
    const input = tab.input;
    if (!(input instanceof vscode.TabInputTextDiff)) return;
    const resource = gitDiffResource(input.original, input.modified), key = resource && `${resource.resourceGroupType}:${resource.resourceUri}`;
    if (!resource || !key || pending.has(key)) return;
    pending.add(key);
    try {
      // The tab may already have been replaced or closed by VS Code's failed binary fallback.
      await Promise.resolve(vscode.window.tabGroups.close(tab, true)).catch(() => undefined);
      await open(resource);
    } catch (error) { report(error); } finally { pending.delete(key); }
  };
  for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs)) void redirect(tab);
  return vscode.window.tabGroups.onDidChangeTabs(event => { for (const tab of [...event.opened, ...event.changed]) void redirect(tab); });
}

/**
 * Image changes in the Source Control group of `target`, compared like Git's own
 * Open Changes: staged as HEAD → index, otherwise index (or HEAD) → working tree.
 * VS Code's built-in image diff crashes its original pane, so these open in AgentTandem's image view.
 */
export async function gitImageChanges(target: unknown): Promise<{ files: ChangeComparison[]; index: number }> {
  const uri = targetUri(target);
  if (!uri || !imageMime(uri.path)) throw new Error('Open Image Changes works on image files with Git changes.');
  const api = await gitApi(), repository = api.getRepository(uri);
  if (!repository) throw new Error(`${vscode.workspace.asRelativePath(uri)} is not in a Git repository.`);
  const same = (change: GitChange) => change.uri.toString() === uri.toString();
  const { indexChanges, workingTreeChanges, untrackedChanges = [] } = repository.state;
  const group = (target as { resourceGroupType?: unknown } | undefined)?.resourceGroupType;
  // From an editor, prefer unstaged edits, like clicking the file in Changes.
  const staged = group === indexGroup || (group === undefined && indexChanges.some(same) && ![...workingTreeChanges, ...untrackedChanges].some(same));
  const changes = (staged ? indexChanges : [...workingTreeChanges, ...untrackedChanges]).filter(change => imageMime(change.uri.path));
  const files = changes.map(change => ({
    file: vscode.workspace.asRelativePath(change.uri),
    original: staged ? api.toGitUri(change.originalUri, 'HEAD') : api.toGitUri(change.uri, '~'),
    modified: staged ? api.toGitUri(change.uri, '') : change.uri,
  }));
  const index = changes.findIndex(same);
  if (index < 0) throw new Error(`${vscode.workspace.asRelativePath(uri)} has no ${staged ? 'staged' : 'unstaged'} Git changes.`);
  return { files, index };
}
