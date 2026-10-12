import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '../../src/extension';

export async function run() {
  const api = await vscode.extensions.getExtension<ExtensionAPI>('agent-dock-local.agent-dock')!.activate();
  const project = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const reopening = process.env.AGENT_DOCK_ACCESS_PHASE === 'reopen';
  const checks: string[] = [];
  if (reopening) assert.deepEqual(api.viewState().accessModes, { Codex: 'full-access', Claude: 'full-access' }, 'Native access selection survives Extension Host restart');
  let hits = 0;
  const server = createServer((_request, response) => { hits++; response.end('ACCESS_HTTP_OK'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  try {
    for (const provider of ['Codex', 'Claude']) {
      await vscode.commands.executeCommand('agentDock.newChat', provider);
      if (!reopening) await vscode.commands.executeCommand('agentDock.setAccessMode', { project, provider, mode: 'full-access' });
      assert.equal(api.viewState().accessModes?.[provider as 'Codex' | 'Claude'], 'full-access');
      let key: string | undefined;
      for (let turn = 0; turn < (reopening ? 1 : 2); turn++) {
        const marker = `${provider}-${reopening ? 'reopen' : 'initial'}-${turn}-${randomUUID()}`;
        const outside = path.join(process.env.AGENT_DOCK_ACCESS_OUTSIDE!, `${marker}.txt`);
        const hitsBefore = hits;
        let prompts = 0;
        const watch = setInterval(() => {
          if (api.viewState().chat?.prompts.length) { prompts++; void vscode.commands.executeCommand('agentDock.stopChat'); }
        }, 20);
        const timer = setTimeout(() => void vscode.commands.executeCommand('agentDock.stopChat'), 90_000);
        try {
          await vscode.commands.executeCommand('agentDock.sendChat', { requestId: randomUUID(), project, provider, conversationKey: key,
            text: `Run this exact foreground command once with your terminal tool: node full-access-tool.mjs "${outside}" "http://127.0.0.1:${port}/" "${marker}". It writes one test file in this project, one file in the disposable sibling directory, and calls the local HTTP test server. Do not change other files, do not delegate. After it succeeds reply only ACCESS_OK.` });
          assert.equal(prompts, 0, `${provider}: native Full access must not present normal tool approvals`);
          assert.equal(api.viewState().chat?.status, 'completed', api.viewState().error);
          assert.equal(api.viewState().chat?.accessMode, 'full-access');
          assert.equal(await readFile(path.join(project, 'full-access.txt'), 'utf8'), marker);
          assert.equal(await readFile(outside, 'utf8'), marker);
          assert.ok(hits > hitsBefore, 'Native tool has working network access');
          const session = api.conversation()!.conversation.key;
          if (key) assert.equal(session, key, 'Resume keeps the same session with Full access');
          key = session;
          assert.ok(api.viewState().review?.files.some(file => file.path === 'full-access.txt'));
          await vscode.commands.executeCommand('agentDock.revertChanges', { project, revision: api.viewState().review!.revision });
          await assert.rejects(readFile(path.join(project, 'full-access.txt')), { code: 'ENOENT' });
          assert.equal(await readFile(outside, 'utf8'), marker, 'Review remains scoped to the selected project');
        } finally { clearInterval(watch); clearTimeout(timer); }
      }
      checks.push(`${provider}: Full access ${reopening ? 'restored after restart' : 'selected and retained on resume'}; real tool writes inside/outside the project and reaches HTTP without any approval answers; in-project review/Revert works.`);
    }
    const report = { success: true, vscode: vscode.version, phase: reopening ? 'reopen' : 'initial', checks };
    await writeFile(path.join(process.env.AGENT_DOCK_ACCESS_REPORT_DIR!, `access-${report.phase}-test.json`), JSON.stringify(report, null, 2));
    console.log(`AGENT_DOCK_ACCESS_LIVE ${JSON.stringify(report)}`);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
