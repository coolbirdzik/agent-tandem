import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';
delete process.env.ELECTRON_RUN_AS_NODE;
const root = process.cwd(), runtime = path.join(root, '.test-runtime', `git-image-changes-${Date.now()}`);
const workspace = path.join(runtime, 'workspace'), profile = path.join(runtime, 'profile');
for (const folder of [workspace, path.join(profile, 'User'), path.join(runtime, 'codex'), path.join(runtime, 'claude')]) await mkdir(folder, { recursive: true });
await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'files.hotExit': 'off', 'workbench.startupEditor': 'none', 'git.openRepositoryInParentFolders': 'never', 'agentTandem.autoTrackExternalChanges': false }));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const extensionId = `${manifest.publisher}.${manifest.name}`;
await runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'dist/git-image-changes-tests.js'),
  extensionTestsEnv: { CODEX_HOME: path.join(runtime, 'codex'), CLAUDE_CONFIG_DIR: path.join(runtime, 'claude'), AGENT_TANDEM_EXTENSION_ID: extensionId, AGENT_TANDEM_GIT_IMAGES_RUNTIME: runtime },
  launchArgs: [workspace, '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
});
console.log(`GIT_IMAGE_CHANGES_TEST ${await readFile(path.join(runtime, 'report.json'), 'utf8')}`);
