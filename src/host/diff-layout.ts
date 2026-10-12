import * as vscode from 'vscode';

export type BlockActionsStyle = 'auto' | 'lens' | 'off';

/** Cards need the editor-inset API; the lens row is the released-API fallback. */
export function blockActionsStyle(): BlockActionsStyle {
  const value = vscode.workspace.getConfiguration('agentDock').get<string>('blockActionsStyle', 'auto');
  return value === 'lens' || value === 'off' ? value : 'auto';
}

/** Use VS Code's native inline layout for both single and multi-file reviews. */
export async function useReviewDiffLayout(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('diffEditor');
  // Avoid creating a workspace settings change just by opening a tracked diff.
  // An existing workspace override still needs updating at its original scope.
  const target = (key: string) => configuration.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  if (configuration.get<boolean>('renderSideBySide') !== false) await configuration.update('renderSideBySide', false, target('renderSideBySide'));
  // Diff editors hide code lenses by default, including the per-block fallback row.
  if (blockActionsStyle() !== 'off' && configuration.get<boolean>('codeLens') !== true) await configuration.update('codeLens', true, target('codeLens'));
}
