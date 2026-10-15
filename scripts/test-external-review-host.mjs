import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runTests } from '@vscode/test-electron';

delete process.env.ELECTRON_RUN_AS_NODE;
const root = process.cwd(), runtime = path.join(root, '.test-runtime', `external-review-${Date.now()}`);
const workspace = path.join(runtime, 'workspace'), profile = path.join(runtime, 'profile');
const otherWorkspace = path.join(runtime, 'other-workspace'), workspaceFile = path.join(runtime, 'review.code-workspace');
await mkdir(otherWorkspace, { recursive: true });
await writeFile(workspaceFile, JSON.stringify({ folders: [{ path: workspace }, { path: otherWorkspace }] }));
for (const folder of [workspace, path.join(profile, 'User'), path.join(root, 'artifacts')]) await mkdir(folder, { recursive: true });
await promisify(execFile)('git', ['init', '-q'], { cwd: workspace, windowsHide: true });
// Git exposes a submodule as a directory in ls-files; it must not stop tracking.
await mkdir(path.join(workspace, 'MemOS'));
await promisify(execFile)('git', ['init', '-q'], { cwd: path.join(workspace, 'MemOS'), windowsHide: true });
await promisify(execFile)('git', ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},MemOS`], { cwd: workspace, windowsHide: true });
await writeFile(path.join(workspace, 'source.ts'), 'user edits before tracking\n');
await writeFile(path.join(workspace, 'deleted.ts'), 'original deleted file\n');
await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'files.hotExit': 'off', 'window.restoreWindows': 'none', 'agentTandem.reviewEditor': 'native', 'agentTandem.codexExecutable': path.join(runtime, 'missing-codex.exe'), 'agentTandem.claudeExecutable': path.join(runtime, 'missing-claude.exe') }));
for (const stage of ['first', 'resume']) await runTests({ vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'), extensionDevelopmentPath: root, extensionTestsPath: path.join(root, 'dist/external-review-host-tests.js'),
  extensionTestsEnv: { CODEX_HOME: path.join(runtime, 'codex'), CLAUDE_CONFIG_DIR: path.join(runtime, 'claude'), AGENT_TANDEM_TEST_NODE: process.execPath, AGENT_TANDEM_EXTERNAL_STAGE: stage, AGENT_TANDEM_REPORT_DIR: path.join(root, 'artifacts') },
  launchArgs: [workspaceFile, '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'] });
