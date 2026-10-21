import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { copyFile, link, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '../../src/extension';
import type { CLIRequest } from '../../src/providers/cli-registry';

export async function run() {
  const api = await vscode.extensions.getExtension<ExtensionAPI>('agent-tandem-local.agent-tandem')!.activate();
  const project = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const reportPath = path.join(process.env.AGENT_TANDEM_CLI_REPORT_DIR!, 'cli-manager-live-test.json');
  const deadline = Date.now() + 30_000;
  while (!api.viewState().cliManager?.registry.initialized || api.viewState().cliManager?.busy) {
    assert.ok(Date.now() < deadline, api.viewState().cliManager?.error ?? 'CLI initialization timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const action = async (provider: 'Codex' | 'Claude', operation: CLIRequest['action'], details: Partial<CLIRequest> = {}) => {
    await vscode.commands.executeCommand('agentTandem.cliAction', { project, provider, action: operation, revision: api.viewState().cliManager!.registry.revision, ...details });
  };
  const refreshModels = async (provider: 'Codex' | 'Claude') => {
    await vscode.commands.executeCommand('agentTandem.refreshModels', { project, provider, model: '' });
    return api.viewState().modelCatalogs?.[provider];
  };
  if (process.env.AGENT_TANDEM_CLI_PHASE === 'reopen') {
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    process.env.PATH = [report.terminalDirectory, process.env.PATH].join(path.delimiter);
    for (const row of report.checks) {
      const provider = row.provider as 'Codex' | 'Claude';
      assert.equal(api.viewState().cliManager!.registry.defaults[provider], row.id);
      assert.equal(api.viewState().cliManager!.active[provider]?.id, row.id, 'Project selection survives restart');
      assert.equal((await refreshModels(provider))?.cli?.executable, row.executable);
      await action(provider, 'remove', { id: row.id });
      assert.ok((await stat(row.executable)).isFile(), 'Remove preserves executable on disk');
      assert.equal(api.viewState().modelCatalogs?.[provider]?.status, 'error', 'Removed selected CLI does not silently fall back');
      await action(provider, 'use', { id: '' });
      assert.equal(api.viewState().modelCatalogs?.[provider]?.status, 'error', 'Removed default does not silently fall back');
      await action(provider, 'default', { id: '' });
      const recovered = await refreshModels(provider);
      assert.equal(recovered?.status, 'ready', recovered?.error);
      assert.equal(api.viewState().cliManager!.active[provider]?.source, provider === 'Codex' ? 'automatic-path' : 'default', 'Inherited terminal default remains Use default CLI');
      await action(provider, 'use', { id: 'path' });
      assert.equal(api.viewState().cliManager!.active[provider]?.source, 'path', 'Explicit terminal choice is distinct from inherited default');
      await unlink(row.executable);
    }
    for (const name of ['codex', 'claude']) await unlink(path.join(report.terminalDirectory, `${name}.exe`));
    await writeFile(path.join(process.env.AGENT_TANDEM_CLI_REPORT_DIR!, 'cli-manager-reopen-test.json'), JSON.stringify({ success: true, vscode: vscode.version, persistedSelection: true, removalKeptExecutable: true, removedDefaultBlocked: true, recoveredTerminalCLI: true }, null, 2));
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-cli-manager-'));
  // Use real native CLIs on an isolated terminal PATH, even if the machine's
  // npm launcher is broken. Persist these fixtures for the reopen checks.
  const terminalDirectory = path.join(directory, 'terminal'); await mkdir(terminalDirectory);
  for (const provider of ['Codex', 'Claude'] as const) {
    const manager = api.viewState().cliManager!;
    const original = manager.registry.entries.find(row => row.id === manager.active[provider]?.id) ?? manager.registry.entries.find(row => row.provider === provider && row.enabled && !row.error);
    assert.ok(original, `${provider} is installed`);
    const executable = path.join(terminalDirectory, `${provider.toLowerCase()}.exe`);
    await link(original.executable, executable);
    await action(provider, 'add', { name: `Terminal ${provider}`, executable });
  }
  process.env.PATH = [terminalDirectory, process.env.PATH].join(path.delimiter);
  const checks = [];
  for (const provider of ['Codex', 'Claude'] as const) {
    await vscode.commands.executeCommand('agentTandem.newChat', provider);
    await vscode.commands.executeCommand('agentTandem.refreshCLIs');
    const manager = api.viewState().cliManager!;
    const original = manager.registry.entries.find(row => row.id === manager.active[provider]?.id) ?? manager.registry.entries.find(row => row.provider === provider && row.enabled && !row.error)!;
    assert.ok(original, `${provider} is installed`);
    if (provider === 'Codex') {
      // A native desktop/daemon update can arrive after the registry was initialized.
      const scannedExecutable = path.join(process.env.CODEX_HOME!, 'packages/app-server-daemon/releases/scan-regression/bin/codex.exe');
      await mkdir(path.dirname(scannedExecutable), { recursive: true });
      await copyFile(original.executable, scannedExecutable);
      await action(provider, 'scan');
      const scanned = api.viewState().cliManager!.registry.entries.find(row => row.executable === scannedExecutable);
      assert.ok(scanned, 'Scan discovers a newly installed daemon release');
      assert.equal(scanned.enabled, false, 'New scan results require explicit enabling');
      assert.equal(scanned.version, original.version);
      await action(provider, 'scan');
      assert.equal(api.viewState().cliManager!.registry.entries.filter(row => row.executable === scannedExecutable).length, 1, 'Rescan does not duplicate the executable');
      await action(provider, 'remove', { id: scanned.id });
      await unlink(scannedExecutable);
    }
    const executable = path.join(directory, `${provider.toLowerCase()}-managed.exe`);
    await link(original.executable, executable);
    await action(provider, 'add', { name: `Managed ${provider}`, executable });
    const entry = api.viewState().cliManager!.registry.entries.find(row => row.executable === executable)!;
    assert.ok(entry?.enabled);
    await action(provider, 'edit', { id: entry.id, name: `Renamed ${provider}`, executable });
    assert.equal(api.viewState().cliManager!.registry.entries.find(row => row.id === entry.id)!.name, `Renamed ${provider}`);
    await action(provider, 'default', { id: entry.id });
    await action(provider, 'use', { id: entry.id });
    assert.equal(api.viewState().cliManager!.active[provider]?.source, 'project');
    assert.equal((await refreshModels(provider))?.cli?.executable, executable, 'Catalog comes from selected executable');
    // Simulate a different project retaining its old executable setting after a global path edit.
    const movedExecutable = path.join(directory, `${provider.toLowerCase()}-moved.exe`);
    await link(original.executable, movedExecutable);
    await action(provider, 'edit', { id: entry.id, name: `Renamed ${provider}`, executable: movedExecutable });
    await vscode.workspace.getConfiguration('agentTandem', vscode.Uri.file(project)).update(provider === 'Codex' ? 'codexExecutable' : 'claudeExecutable', executable, vscode.ConfigurationTarget.WorkspaceFolder);
    assert.equal((await refreshModels(provider))?.cli?.executable, movedExecutable, 'Managed selection follows its ID despite old path settings');
    await unlink(executable);
    await action(provider, 'toggle', { id: entry.id, enabled: false });
    assert.match(api.viewState().modelCatalogs?.[provider]?.error ?? '', /disabled/i);
    assert.match(api.viewState().cliManager!.active[provider]?.error ?? '', /disabled/i);
    await vscode.commands.executeCommand('agentTandem.sendChat', { requestId: randomUUID(), project, provider, model: '', text: 'This disabled CLI must never run an agent.' });
    assert.equal(api.viewState().chat?.status, 'failed');
    assert.match(api.viewState().error ?? '', /disabled/i);
    assert.equal(api.conversation()?.conversation.id, '', 'Blocked before native session creation');
    await vscode.commands.executeCommand('agentTandem.newChat', provider);
    await action(provider, 'toggle', { id: entry.id, enabled: true });
    await action(provider, 'refresh', { id: entry.id });
    assert.equal((await refreshModels(provider))?.status, 'ready');
    assert.ok((await stat(original.executable)).isFile());
    checks.push({ provider, id: entry.id, executable: movedExecutable, version: entry.version, registered: true, renamed: true, pathEditPreservedSelection: true, disabledCatalogAndChat: true, enabledCatalog: true, ...(provider === 'Codex' ? { scanDiscoveredNewRelease: true, rescanDidNotDuplicate: true } : {}) });
  }
  await writeFile(reportPath, JSON.stringify({ success: true, vscode: vscode.version, terminalDirectory, checks }, null, 2));
  console.log('AGENT_TANDEM_CLI_MANAGER_LIVE success');
}
