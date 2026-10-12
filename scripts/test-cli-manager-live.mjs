import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';
import { providerTestHomes } from './provider-test-homes.mjs';

delete process.env.ELECTRON_RUN_AS_NODE;
const root = process.cwd(), runtime = path.join(root, '.test-runtime', `cli-manager-${Date.now()}`);
const workspace = path.join(runtime, 'workspace'), profile = path.join(runtime, 'profile');
await mkdir(workspace, { recursive: true }); await mkdir(path.join(profile, 'User'), { recursive: true });
await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'files.hotExit': 'off' }));
const providerHomes = await providerTestHomes(runtime);
const options = {
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
  extensionDevelopmentPath: root, extensionTestsPath: path.join(root, 'dist/cli-manager-live-tests.js'),
  extensionTestsEnv: { ...providerHomes, AGENT_DOCK_CLI_REPORT_DIR: path.join(root, 'artifacts') },
  launchArgs: [workspace, '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
};
await runTests(options);
await runTests({ ...options, extensionTestsEnv: { ...options.extensionTestsEnv, AGENT_DOCK_CLI_PHASE: 'reopen' } });
