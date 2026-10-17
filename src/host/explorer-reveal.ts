import * as vscode from 'vscode';

let last: string | undefined;

/** Review files open from virtual snapshots, so Explorer's own auto-reveal never follows them. */
export async function revealInExplorer(uri: vscode.Uri): Promise<void> {
  if (!vscode.workspace.getConfiguration('agentTandem').get<boolean>('revealReviewFileInExplorer', true)) return;
  const key = uri.toString();
  if (key === last) return;
  last = key;
  try {
    await vscode.workspace.fs.stat(uri);
    await vscode.commands.executeCommand('revealInExplorer', uri);
    // The command moves keyboard focus to Explorer; return it so review shortcuts keep working.
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  } catch { /* Deleted by the agent or outside the workspace: nothing to show. */ }
}
