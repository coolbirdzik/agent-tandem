import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';
import { providerTestHomes } from './provider-test-homes.mjs';

delete process.env.ELECTRON_RUN_AS_NODE;
const root = process.cwd(), runtime = path.join(root, '.test-runtime', `edit-live-${Date.now()}`);
const workspace = path.join(runtime, 'workspace'), profile = path.join(runtime, 'profile');
await mkdir(workspace, { recursive: true }); await mkdir(path.join(profile, 'User'), { recursive: true });
await writeFile(path.join(workspace, 'sentinel.txt'), 'current project bytes\n');
await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'files.hotExit': 'off' }));
const providerHomes = await providerTestHomes(runtime);
await runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
  extensionDevelopmentPath: root, extensionTestsPath: path.join(root, 'dist/edit-live-tests.js'),
  extensionTestsEnv: { ...providerHomes, AGENT_TANDEM_EDIT_REPORT: path.join(root, 'artifacts/edit-live-test.json') },
  launchArgs: [workspace, '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
});
