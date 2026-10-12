import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';
import { providerTestHomes } from './provider-test-homes.mjs';

delete process.env.ELECTRON_RUN_AS_NODE;
const root = process.cwd(), reopenIndex = process.argv.indexOf('--reopen');
const runtime = reopenIndex >= 0 ? path.resolve(process.argv[reopenIndex + 1] ?? '') : path.join(root, '.test-runtime', `models-live-${Date.now()}`);
const relative = path.relative(path.join(root, '.test-runtime'), runtime);
if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(runtime).startsWith('models-live-')) throw new Error('Reopen requires an existing models-live runtime under .test-runtime.');
const workspace = path.join(runtime, 'workspace'), profile = path.join(runtime, 'profile');
if (reopenIndex < 0) {
  await mkdir(workspace, { recursive: true }); await mkdir(path.join(profile, 'User'), { recursive: true });
  await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'files.hotExit': 'off' }));
}
const providerHomes = await providerTestHomes(runtime, { reopen: reopenIndex >= 0 });
const options = {
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
  extensionDevelopmentPath: root, extensionTestsPath: path.join(root, 'dist/models-live-tests.js'),
  extensionTestsEnv: { ...providerHomes, AGENT_DOCK_MODEL_REPORT_DIR: path.join(root, 'artifacts'), ...(process.env.AGENT_DOCK_MODEL_CODEX ? { AGENT_DOCK_MODEL_CODEX: process.env.AGENT_DOCK_MODEL_CODEX } : {}) },
  launchArgs: [workspace, '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
};
if (reopenIndex < 0) await runTests(options);
await runTests({ ...options, extensionTestsEnv: { ...options.extensionTestsEnv, AGENT_DOCK_MODEL_PHASE: 'reopen' } });
