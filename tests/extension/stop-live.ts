import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '../../src/extension';

export async function run() {
  const api = await vscode.extensions.getExtension<ExtensionAPI>('agent-dock-local.agent-dock')!.activate();
  const project = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const file = (name: string) => path.join(project, name);
  const checks: string[] = [];
  const bounded = async <T>(promise: PromiseLike<T>, milliseconds: number) => {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Stop did not settle the active chat.')), milliseconds); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  for (const provider of ['Codex', 'Claude']) {
    await vscode.commands.executeCommand('agentDock.newChat', provider);
    const answerPrompts = setInterval(() => {
      for (const prompt of api.viewState().chat?.prompts ?? []) void vscode.commands.executeCommand('agentDock.answerAgent', { id: prompt.id, allow: true }).then(undefined, () => undefined);
    }, 100);
    const timeout = setTimeout(() => void vscode.commands.executeCommand('agentDock.stopChat'), 90_000);
    const run = Promise.resolve(vscode.commands.executeCommand('agentDock.sendChat', { requestId: randomUUID(), project, provider,
      text: 'In this disposable workspace, run `node stop-tool.mjs` once in the foreground and wait for it to exit. The script writes test heartbeat files and sleeps for 60 seconds. Do not modify any other files, do not run in the background and do not delegate. Use your terminal tool.' }));
    void run.catch(() => undefined);
    try {
      const started = Date.now();
      while (true) {
        try { await readFile(file('heartbeat.txt')); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (api.viewState().chat?.status === 'failed') throw new Error(api.viewState().error ?? 'Provider failed.');
        if (Date.now() - started > 85_000) throw new Error(`${provider} did not start the foreground tool.`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const stoppedAt = Date.now();
      await vscode.commands.executeCommand('agentDock.stopChat');
      assert.ok(['stopping', 'finishing'].includes(api.viewState().chat?.phase ?? ''), 'Stop gives immediate state feedback');
      await bounded(run, 8000);
      const stopMilliseconds = Date.now() - stoppedAt; clearTimeout(timeout);
      assert.equal(api.viewState().chat?.status, 'interrupted'); assert.equal(api.viewState().chat?.phase, undefined);
      assert.equal(api.viewState().chat?.prompts.length, 0);
      const heartbeat = await readFile(file('heartbeat.txt'), 'utf8');
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(await readFile(file('heartbeat.txt'), 'utf8'), heartbeat, 'Stopped descendant does not keep writing');
      await assert.rejects(readFile(file('finished.txt')), { code: 'ENOENT' });
      assert.ok(api.viewState().review?.files.some(change => change.path === 'partial.txt'), 'Partial edits remain pending review');
      const conversationKey = api.viewState().conversation!.conversation.key;
      await bounded(vscode.commands.executeCommand('agentDock.sendChat', { requestId: randomUUID(), project, provider, conversationKey, text: 'Reply only STOP_RESUME_OK. Do not use tools or modify files.' }), 60_000);
      assert.equal(api.viewState().chat?.status, 'completed', api.viewState().error);
      assert.equal(api.viewState().conversation?.conversation.key, conversationKey);
      assert.ok(api.viewState().conversation?.messages.some(message => message.role === 'assistant' && message.text?.includes('STOP_RESUME_OK')));
      await vscode.commands.executeCommand('agentDock.revertChanges', { project, revision: api.viewState().review!.revision });
      await assert.rejects(readFile(file('partial.txt')), { code: 'ENOENT' });
      await assert.rejects(readFile(file('heartbeat.txt')), { code: 'ENOENT' });
      checks.push(`${provider}: Stop interrupts real foreground tool, descendant heartbeat stops, partial edits stay reviewable, same conversation resumes and Revert succeeds (Stop ${stopMilliseconds} ms).`);
    } finally { clearTimeout(timeout); clearInterval(answerPrompts); await vscode.commands.executeCommand('agentDock.stopChat'); await bounded(run, 8000); }
  }
  const report = { success: true, vscode: vscode.version, checks };
  await writeFile(process.env.AGENT_DOCK_STOP_REPORT!, JSON.stringify(report, null, 2)); console.log(`AGENT_DOCK_STOP_LIVE ${JSON.stringify(report)}`);
}
