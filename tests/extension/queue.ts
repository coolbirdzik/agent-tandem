import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI } from '../../src/extension';
const attachments = [{ name: 'screen.png', mimeType: 'image/png', data: 'AQID' }, { name: 'notes.txt', mimeType: 'text/plain', data: 'aGk=' }];
async function waitFor(check: () => boolean | Promise<boolean>, description: string) {
  const start = Date.now(); while (!await check()) { if (Date.now() - start > 12000) throw new Error(`Timed out: ${description}`); await new Promise(resolve => setTimeout(resolve, 30)); }
}
export async function run() {
  const api = await vscode.extensions.getExtension<ExtensionAPI>('agent-tandem-local.agent-tandem')!.activate();
  const project = vscode.workspace.workspaceFolders![0]!.uri.fsPath, control = process.env.AGENT_TANDEM_QUEUE_CONTROL!;
  const calls = async (): Promise<Array<{ event: string; id: string; provider?: string; text?: string; conversation?: string; active: number; attachments: number; staged: boolean }>> => {
    try { return (await readFile(path.join(control, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); } catch { return []; }
  };
  const release = (id: string) => writeFile(path.join(control, `release-${id}`), 'release');
  const action = (action: string, id?: string, text?: string) => vscode.commands.executeCommand('agentTandem.queueAction', { project, action, id, text });
  if (process.env.AGENT_TANDEM_QUEUE_PHASE === 'reopen') {
    await api.syncConversations();
    assert.equal(api.viewState().chatQueue?.items[0]?.text, 'afterfailure'); assert.match(api.viewState().chatQueue?.paused ?? '', /Reloaded/);
    assert.deepEqual(api.viewState().chatQueue?.items[0]?.attachments, attachments);
    const before = (await calls()).length; await new Promise(resolve => setTimeout(resolve, 150)); assert.equal((await calls()).length, before, 'Reload does not auto-send queued messages');
    await action('remove', api.viewState().chatQueue!.items[0]!.requestId);
    console.log('QUEUE_REOPEN_OK'); return;
  }
  const checks = [];
  for (const provider of ['Codex', 'Claude'] as const) {
    await vscode.commands.executeCommand('agentTandem.newChat', provider);
    const first = `${provider}-first`, second = `${provider}-second`, third = `${provider}-third`, fourth = `${provider}-fourth`;
    const send = (id: string, text = id) => Promise.resolve(vscode.commands.executeCommand('agentTandem.sendChat', { requestId: id, project, provider, text, ...(id === fourth ? { attachments } : {}), conversationKey: api.conversation()?.conversation.id ? api.conversation()!.conversation.key : undefined }));
    const started = send(first); await waitFor(async () => (await calls()).some(row => row.id === first && row.event === 'start'), 'first turn');
    const key = api.conversation()!.conversation.key;
    await send(second); await send(third); await action('edit', second, 'second-edited'); await action('remove', third); await send(fourth);
    assert.deepEqual(api.viewState().chatQueue?.items.map(item => item.requestId), [second, fourth]);
    await release(first); await started;
    await waitFor(async () => (await calls()).some(row => row.id === second && row.event === 'start'), 'second turn'); await release(second);
    await waitFor(async () => (await calls()).some(row => row.id === fourth && row.event === 'start'), 'fourth turn'); await release(fourth);
    await waitFor(() => api.viewState().chat?.requestId === fourth && api.viewState().chat?.status === 'completed' && !api.viewState().chat?.phase, 'queue drained');
    assert.equal(api.conversation()!.conversation.key, key); assert.equal(api.viewState().chatQueue, undefined);
    const runs = (await calls()).filter(row => row.event === 'start' && row.provider === provider);
    assert.deepEqual(runs.map(row => row.text), [first, 'second-edited', fourth]); assert.ok(runs.every(row => row.active === 1 && `${provider}:${row.conversation}` === key));
    assert.ok(api.conversation()!.messages.some(message => message.text === `Reply: ${fourth}`));
    assert.equal(runs.find(row => row.id === fourth)?.attachments, 2); assert.equal(runs.find(row => row.id === fourth)?.staged, true);
    assert.equal(api.conversation()!.messages.find(message => message.id === fourth)?.attachments?.filter(item => item.mimeType === 'image/png').length, 1);
    assert.ok(api.viewState().checkpoints?.some(checkpoint => checkpoint.messageId === fourth), 'Attachment checkpoint matches refreshed native history');
    const stopping = send(`${provider}-stop`); await waitFor(async () => (await calls()).some(row => row.id === `${provider}-stop` && row.event === 'start'), 'stop turn');
    await send(`${provider}-follow`); await vscode.commands.executeCommand('agentTandem.stopChat'); await stopping;
    assert.equal(api.viewState().chat?.status, 'interrupted'); assert.ok(api.viewState().chatQueue?.paused); assert.ok(!(await calls()).some(row => row.id === `${provider}-follow`));
    await release(`${provider}-follow`); await action('resume'); await waitFor(() => api.viewState().chat?.requestId === `${provider}-follow` && api.viewState().chat?.status === 'completed' && !api.viewState().chat?.phase, 'resumed queue');
    checks.push(`${provider}: FIFO, edit/remove, same native session, no overlapping turns, staged attachments and refreshed checkpoints, Stop pauses and Resume continues.`);
  }
  await vscode.commands.executeCommand('agentTandem.newChat', 'Codex');
  const rootOwner = Promise.resolve(vscode.commands.executeCommand('agentTandem.sendChat', { requestId: 'root-owner', project, provider: 'Codex', text: 'root-owner' }));
  await waitFor(async () => (await calls()).some(row => row.id === 'root-owner' && row.event === 'start'), 'root owner');
  await vscode.commands.executeCommand('agentTandem.sendChat', { requestId: 'root-follow', project, provider: 'Codex', text: 'root-follow', conversationKey: api.conversation()!.conversation.key });
  const other = vscode.workspace.workspaceFolders![1]!.uri.fsPath;
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(other, 'anchor.txt'))));
  await waitFor(() => api.viewState().project === other, 'other root selected'); await rootOwner;
  assert.equal(api.viewState().chatQueue, undefined, 'The other root cannot see or run this queue');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(project, 'anchor.txt'))));
  await waitFor(() => api.viewState().project === project && !!api.viewState().chatQueue?.paused, 'original root queue restored');
  await api.syncConversations(); await release('root-follow'); await action('resume');
  await waitFor(() => api.viewState().chat?.requestId === 'root-follow' && api.viewState().chat?.status === 'completed' && !api.viewState().chat?.phase, 'queue resumed in original root');
  checks.push('Switching workspace roots pauses and isolates the queue; returning and resuming uses the original conversation.');
  await vscode.commands.executeCommand('agentTandem.newChat', 'Claude');
  const failure = Promise.resolve(vscode.commands.executeCommand('agentTandem.sendChat', { requestId: 'failure', project, provider: 'Claude', text: 'fail' }));
  await waitFor(async () => (await calls()).some(row => row.id === 'failure' && row.event === 'start'), 'failure turn');
  await vscode.commands.executeCommand('agentTandem.sendChat', { requestId: 'afterfailure', project, provider: 'Claude', text: 'afterfailure', attachments, conversationKey: api.conversation()!.conversation.key });
  await release('failure'); await failure; assert.equal(api.viewState().chat?.status, 'failed'); assert.ok(api.viewState().chatQueue?.paused);
  await assert.rejects(Promise.resolve(vscode.commands.executeCommand('agentTandem.queueAction', { project: '/wrong-root', action: 'resume' })));
  await waitFor(async () => {
    // workspaceState writes are async; wait for the saved paused snapshot before restarting.
    const extension = vscode.extensions.getExtension('agent-tandem-local.agent-tandem')!;
    return !!extension.isActive && !!api.viewState().chatQueue?.paused;
  }, 'paused queue saved');
  await new Promise(resolve => setTimeout(resolve, 200));
  await writeFile(path.join(process.env.AGENT_TANDEM_QUEUE_REPORT_DIR!, 'queue-host-test.json'), JSON.stringify({ success: true, vscode: vscode.version, simulatedProviders: true, checks }, null, 2));
  console.log(`QUEUE_HOST_OK ${JSON.stringify(checks)}`);
}
