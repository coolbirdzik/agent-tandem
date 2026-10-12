import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';
import { createServer } from 'node:net';
import { verifyFloatingNavigation } from './verify-floating-navigation.mjs';
delete process.env.ELECTRON_RUN_AS_NODE;
const root = process.cwd(), runtime = path.join(root, '.test-runtime', `change-navigation-${Date.now()}`);
const workspace = path.join(runtime, 'navigation-workspace'), profile = path.join(runtime, 'profile');
for (const folder of [workspace, path.join(profile, 'User'), path.join(runtime, 'codex'), path.join(runtime, 'claude'), path.join(root, 'artifacts')]) await mkdir(folder, { recursive: true });
await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'files.hotExit': 'off', 'editor.accessibilitySupport': 'on', 'workbench.startupEditor': 'none', 'git.openRepositoryInParentFolders': 'never', 'diffEditor.hideUnchangedRegions.enabled': false }));
console.log(`Navigation runtime: ${runtime}`);
const visual = process.argv.includes('--visual');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const debugPort = server.address().port;
await new Promise(resolve => server.close(resolve));
const options = {
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
  extensionDevelopmentPath: process.env.AGENT_DOCK_EXTENSION_PATH || root,
  extensionTestsPath: path.join(root, 'dist/change-navigation-tests.js'),
  extensionTestsEnv: { CODEX_HOME: path.join(runtime, 'codex'), CLAUDE_CONFIG_DIR: path.join(runtime, 'claude'), AGENT_DOCK_NAV_RUNTIME: runtime, AGENT_DOCK_NAV_VISUAL: process.argv.includes('--visual') ? '1' : '' },
  launchArgs: [workspace, '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--enable-proposed-api', 'agent-dock-local.agent-dock', ...(visual ? [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'] : [])],
};
const tests = runTests(options);
if (visual) await Promise.all([tests, verifyFloatingNavigation(runtime, debugPort)]);
else await tests;
await runTests({ ...options, extensionTestsEnv: { ...options.extensionTestsEnv, AGENT_DOCK_NAV_REOPEN: '1', AGENT_DOCK_NAV_VISUAL: '' }, launchArgs: options.launchArgs.filter(arg => !arg.startsWith('--remote-debugging-')) });
