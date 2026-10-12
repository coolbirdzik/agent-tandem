import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI } from '../../src/extension';

export async function run() {
  const extension = vscode.extensions.getExtension<ExtensionAPI>('agent-dock-local.agent-dock'); assert.ok(extension);
  const api = await extension.activate();
  const expected = JSON.parse(process.env.AGENT_DOCK_HISTORY_EXPECTED!) as { project: string; ids: string[] }[];
  const results = [];
  for (const { project, ids } of expected) {
    if (api.viewState().project?.toLowerCase() !== project.toLowerCase()) {
      const changed = new Promise<void>(resolve => { const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { listener.dispose(); resolve(); }); });
      assert.ok(vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, { uri: vscode.Uri.file(project) }));
      await changed;
    }
    const index = await api.syncConversations();
    const found = index.conversations.filter(row => row.provider === 'Claude');
    assert.ok(ids.every(id => found.some(row => row.id === id)), `Claude sessions missing for ${project}: ${ids.filter(id => !found.some(row => row.id === id)).join(', ')}; ${index.errors.join('; ')}`);
    let messages = 0, opened = 0;
    for (const conversation of found) {
      const content = await api.openConversation(conversation.key);
      assert.ok(content, 'Conversation opens in the extension');
      assert.ok(content.messages.length, `Claude transcript unexpectedly empty: ${conversation.id}`);
      messages += content.messages.length; opened++;
    }
    results.push({ project, expected: ids.length, found: found.length, opened, messages, errors: index.errors });
  }
  const report = { success: true, vscode: vscode.version, results };
  await writeFile(path.join(process.env.AGENT_DOCK_REPORT_DIR!, 'history-local.json'), JSON.stringify(report, null, 2));
  console.log(`AGENT_DOCK_HISTORY_LOCAL ${JSON.stringify(report)}`);
}
