import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';
import { createServer } from 'node:net';
import { verifyFloatingNavigation } from './verify-floating-navigation.mjs';
import { verifyFileNavigation } from './verify-file-navigation.mjs';
delete process.env.ELECTRON_RUN_AS_NODE;
const root = process.cwd(), runtime = path.join(root, '.test-runtime', `change-navigation-${Date.now()}`);
const workspace = path.join(runtime, 'navigation-workspace'), profile = path.join(runtime, 'profile');
for (const folder of [workspace, path.join(profile, 'User'), path.join(runtime, 'codex'), path.join(runtime, 'claude'), path.join(root, 'artifacts')]) await mkdir(folder, { recursive: true });
await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'files.hotExit': 'off', 'editor.accessibilitySupport': 'on', 'workbench.startupEditor': 'none', 'git.openRepositoryInParentFolders': 'never', 'diffEditor.hideUnchangedRegions.enabled': false, 'agentTandem.autoTrackExternalChanges': false, 'agentTandem.reviewEditor': 'native' }));
console.log(`Navigation runtime: ${runtime}`);
const visual = process.argv.includes('--visual'), filesVisual = process.argv.includes('--files-visual'), filesOnly = process.argv.includes('--files-only');
const edition = process.argv.includes('--marketplace') ? 'marketplace' : 'local';
const extensionPath = edition === 'marketplace' ? JSON.parse(await readFile(path.join(root, 'artifacts', 'marketplace-build.json'), 'utf8')).stage : process.env.AGENT_TANDEM_EXTENSION_PATH || root;
const manifest = JSON.parse(await readFile(path.join(extensionPath, 'package.json'), 'utf8'));
const extensionId = `${manifest.publisher}.${manifest.name}`;
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const debugPort = server.address().port;
await new Promise(resolve => server.close(resolve));
const options = {
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
  extensionDevelopmentPath: extensionPath,
  extensionTestsPath: path.join(root, 'dist/change-navigation-tests.js'),
  extensionTestsEnv: { CODEX_HOME: path.join(runtime, 'codex'), CLAUDE_CONFIG_DIR: path.join(runtime, 'claude'), AGENT_TANDEM_EXTENSION_ID: extensionId, AGENT_TANDEM_NAV_EDITION: edition, AGENT_TANDEM_NAV_RUNTIME: runtime, AGENT_TANDEM_NAV_VISUAL: visual ? '1' : '', AGENT_TANDEM_NAV_FILES_VISUAL: filesVisual ? '1' : '', AGENT_TANDEM_NAV_FILES_ONLY: filesOnly ? '1' : '' },
  launchArgs: [workspace, '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', ...(!filesOnly && manifest.enabledApiProposals?.length ? ['--enable-proposed-api', extensionId] : []), ...(visual || filesVisual ? [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'] : [])],
};
const tests = runTests(options);
if (visual) await Promise.all([tests, verifyFloatingNavigation(runtime, debugPort)]);
else if (filesVisual) await Promise.all([tests, verifyFileNavigation(runtime, debugPort, edition)]);
else await tests;
if (!filesOnly) await runTests({ ...options, extensionTestsEnv: { ...options.extensionTestsEnv, AGENT_TANDEM_NAV_REOPEN: '1', AGENT_TANDEM_NAV_VISUAL: '', AGENT_TANDEM_NAV_FILES_VISUAL: '' }, launchArgs: options.launchArgs.filter(arg => !arg.startsWith('--remote-debugging-')) });
