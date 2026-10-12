import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExtensionAPI } from '../../src/extension';
import type { ConversationProvider } from '../../src/providers/conversations';
import type { SelectedModels } from '../../src/providers/models';

export async function run() {
  const extension = vscode.extensions.getExtension<ExtensionAPI>('agent-dock-local.agent-dock')!;
  const api = await extension.activate(), project = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const reportPath = path.join(process.env.AGENT_DOCK_MODEL_REPORT_DIR!, 'models-live-test.json');
  const reopening = process.env.AGENT_DOCK_MODEL_PHASE === 'reopen';
  if (reopening) {
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.deepEqual(api.viewState().selectedModels, report.selectedModels, 'Selections survive a real Extension Host restart');
    assert.deepEqual(api.viewState().selectedEfforts, report.selectedEfforts, 'Per-model effort survives a real Extension Host restart');
    await api.syncConversations();
    for (const check of report.checks.filter((check: any) => check.conversationKey)) {
      const content = await api.openConversation(check.conversationKey);
      assert.deepEqual(JSON.parse(JSON.stringify(content?.usage)), check.efforts.at(-1).usage, `${check.provider}: context and original cache estimate survive reopening without a reset`);
    }
    for (const provider of ['Codex', 'Claude'] as const) {
      await vscode.commands.executeCommand('agentDock.newChat', provider);
      assert.equal(api.viewState().selectedModels?.[provider], report.selectedModels[provider]);
    }
    await writeFile(path.join(process.env.AGENT_DOCK_MODEL_REPORT_DIR!, 'models-reopen-test.json'), JSON.stringify({ success: true, vscode: vscode.version, selectedModels: api.viewState().selectedModels, selectedEfforts: api.viewState().selectedEfforts }, null, 2));
    return;
  }
  const checks: unknown[] = [];
  await vscode.commands.executeCommand('agentDock.newChat', 'Codex');
  await vscode.commands.executeCommand('agentDock.refreshModels', { project, provider: 'Codex', model: '' });
  const terminalCatalog = api.viewState().modelCatalogs?.Codex;
  assert.equal(terminalCatalog?.status, 'ready', terminalCatalog?.error);
  if (process.platform === 'win32') {
    const terminal = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', 'codex --version'], { timeout: 10_000, windowsHide: true });
    assert.equal(terminalCatalog!.cli!.version, terminal.stdout.trim(), 'Default model catalog uses the same Codex CLI version as a terminal');
  }
  checks.push({ terminalCLI: terminalCatalog?.cli, terminalModels: terminalCatalog?.choices.map(choice => choice.id) });
  // Exercise an explicit alternate CLI without changing the user's real settings.
  if (process.env.AGENT_DOCK_MODEL_CODEX) {
    await vscode.workspace.getConfiguration('agentDock', vscode.Uri.file(project)).update('codexExecutable', process.env.AGENT_DOCK_MODEL_CODEX, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  for (const provider of ['Codex', 'Claude'] as const) {
    await vscode.commands.executeCommand('agentDock.newChat', provider);
    await vscode.commands.executeCommand('agentDock.refreshModels', { project, provider, model: '' });
    const catalog = api.viewState().modelCatalogs?.[provider];
    assert.equal(catalog?.status, 'ready', catalog?.error);
    const choices = catalog!.choices;
    assert.ok(choices.length >= 2, `${provider} has native model choices`);
    const historyBefore = await api.syncConversations();
    assert.equal(historyBefore.conversations.filter(c => c.provider === provider).length, 0, 'Catalog discovery does not create a conversation');
    const first = provider === 'Claude' ? choices.find(c => c.id === 'sonnet') ?? choices[0]! : choices.find(c => /luna|mini/i.test(c.id)) ?? choices[0]!;
    const second = provider === 'Claude' ? choices.find(c => c.id === 'haiku') ?? choices.find(c => c.id !== first.id)! : choices.find(c => c.id !== first.id && /sol|gpt/i.test(c.id)) ?? choices.find(c => c.id !== first.id)!;
    let key: string | undefined;
    const actualModels: string[] = [];
    const efforts: unknown[] = [];
    for (const model of [first.id, second.id]) {
      await vscode.commands.executeCommand('agentDock.setModel', { project, provider, model });
      const levels = choices.find(choice => choice.id === model)?.reasoningEfforts ?? [];
      const effort = levels.find(choice => choice.id === (model === first.id ? 'low' : 'medium'))?.id ?? levels[0]?.id ?? '';
      await vscode.commands.executeCommand('agentDock.setReasoningEffort', { project, provider, model, effort });
      const timer = setTimeout(() => void vscode.commands.executeCommand('agentDock.stopChat'), 90_000);
      let nativeClaudeEffort: string | undefined;
      try {
        const result = await Promise.all([
          vscode.commands.executeCommand('agentDock.sendChat', { requestId: randomUUID(), project, provider, conversationKey: key,
            text: 'Reply with exactly MODEL_OK. Do not call tools, read or change files, or delegate.' }),
          provider === 'Claude' && effort && process.platform === 'win32' ? nativeClaudeChildEffort() : Promise.resolve(undefined),
        ]);
        nativeClaudeEffort = result[1];
        if (provider === 'Claude' && effort && process.platform === 'win32') assert.equal(nativeClaudeEffort, effort, 'Owned Claude process receives the selected --effort flag');
      } finally { clearTimeout(timer); }
      assert.equal(api.viewState().chat?.status, 'completed', api.viewState().error);
      assert.equal(api.viewState().chat?.model, model, 'Send uses saved selection when model is omitted');
      assert.equal(api.viewState().selectedModels?.[provider], model);
      assert.equal(api.viewState().chat?.reasoningEffort, effort, 'Send uses saved per-model effort when omitted');
      assert.equal(api.viewState().selectedEfforts?.[provider]?.[model], effort);
      const content = api.conversation()!;
      assert.ok((content.usage?.usedTokens ?? 0) > 0, `${provider}: native CLI reports current context tokens`);
      assert.ok((content.usage?.windowTokens ?? 0) > 0, `${provider}: native CLI reports context capacity`);
      assert.ok(content.messages.some(message => message.role === 'assistant' && message.text.includes('MODEL_OK')));
      if (key) assert.equal(content.conversation.key, key, 'Changing model on resume retains the same conversation');
      key = content.conversation.key;
      const actual = await nativeModel(provider, content.conversation.id, project, extension.extensionPath);
      assert.ok(actual.includes(model.replace(/\[.*\]$/, '')), `${provider}: native history model ${actual} matches selected ${model}`);
      actualModels.push(actual);
      const native = provider === 'Codex' ? await nativeCodexEffort(content.conversation.id) : undefined;
      if (provider === 'Codex') assert.equal(native, effort, 'Native Codex rollout records the selected effort');
      efforts.push({ model, requested: effort || 'Auto', nativeCodexEffort: native, nativeClaudeEffort, supported: levels.map(row => row.id), usage: content.usage, completed: true });
    }
    await assert.rejects(async () => vscode.commands.executeCommand('agentDock.setReasoningEffort', { project, provider, model: second.id, effort: 'unsupported-effort' }), /unavailable/);
    await assert.rejects(async () => vscode.commands.executeCommand('agentDock.setModel', { project, provider, model: 'does-not-exist' }), /unavailable/);
    checks.push({ provider, cli: catalog?.cli, catalog: choices.map(c => c.id), selected: [first.id, second.id], conversationKey: key, actualModels, efforts, resumed: true, discoveryCreatedNoConversation: true });
  }
  const selectedModels: SelectedModels = { ...api.viewState().selectedModels! };
  await writeFile(reportPath, JSON.stringify({ success: true, vscode: vscode.version, selectedModels, selectedEfforts: api.viewState().selectedEfforts, checks }, null, 2));
  console.log(`AGENT_DOCK_MODELS_LIVE ${JSON.stringify({ success: true, checks })}`);
}

async function nativeCodexEffort(id: string) {
  const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
  const files = await readdir(root, { recursive: true });
  const file = files.find(file => file.endsWith(`${id}.jsonl`)); assert.ok(file);
  const records = (await readFile(path.join(root, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return records.filter(row => row.type === 'turn_context').at(-1)?.payload.effort;
}

async function nativeClaudeChildEffort(): Promise<string | undefined> {
  const deadline = Date.now() + 15_000;
  const command = `$taskChildren = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid}"; foreach ($taskChild in $taskChildren) { if ($taskChild.CommandLine -match '--effort\\s+"?(low|medium|high|xhigh|max)\\b') { $Matches[1] } }`;
  while (Date.now() < deadline) {
    const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', command], { timeout: 10_000, windowsHide: true });
    const effort = result.stdout.trim(); if (effort) return effort;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return undefined;
}

async function nativeModel(provider: ConversationProvider, id: string, project: string, extensionPath: string) {
  if (provider === 'Claude') {
    const nativeImport = new Function('url', 'return import(url)') as (url: string) => Promise<typeof import('../../src/providers/claude-history')>;
    const sdk = await nativeImport(pathToFileURL(path.join(extensionPath, 'dist/claude-history.mjs')).href);
    const messages = await sdk.getSessionMessages(id, { dir: project });
    return (messages.filter(row => row.type === 'assistant').at(-1)?.message as { model: string }).model;
  }
  const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
  const files = await readdir(root, { recursive: true });
  const file = files.find(file => file.endsWith(`${id}.jsonl`)); assert.ok(file, 'Native Codex rollout is saved');
  const records = (await readFile(path.join(root, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return String(records.filter(row => row.type === 'turn_context').at(-1)?.payload.model);
}
