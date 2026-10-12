import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { listSessions } from '../dist/claude-history.mjs';

// Read the real local history in an isolated VS Code profile; no inference or transcript writes.
delete process.env.ELECTRON_RUN_AS_NODE;
const root = process.cwd(), runtime = path.join(root, '.test-runtime', `history-local-${Date.now()}`);
const projects = process.argv.slice(2).filter(value => value !== '--installed');
if (!projects.length) projects.push(root);
const expected = [];
for (const project of projects) expected.push({ project, ids: (await listSessions({ dir: project, includeWorktrees: false })).map(session => session.sessionId) });
await mkdir(path.join(runtime, 'profile', 'User'), { recursive: true });
await mkdir(path.join(root, 'artifacts'), { recursive: true });
await writeFile(path.join(runtime, 'profile', 'User', 'settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'files.hotExit': 'off', 'agentTandem.codexExecutable': path.join(runtime, 'missing-codex.exe'), 'agentTandem.claudeExecutable': path.join(runtime, 'missing-claude.exe') }));
const workspace = path.join(runtime, 'history.code-workspace');
await writeFile(workspace, JSON.stringify({ folders: [{ path: projects[0] }] }));
const tests = path.join(runtime, 'tests.cjs');
await build({ entryPoints: ['tests/extension/history-local.ts'], outfile: tests, bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] });
await runTests({ vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
  extensionDevelopmentPath: process.argv.includes('--installed') ? path.join(process.env.USERPROFILE, '.vscode', 'extensions', 'agent-tandem-local.agent-tandem-0.1.0') : root,
  extensionTestsPath: tests, extensionTestsEnv: { AGENT_TANDEM_HISTORY_EXPECTED: JSON.stringify(expected), AGENT_TANDEM_REPORT_DIR: path.join(root, 'artifacts') },
  launchArgs: [workspace, '--user-data-dir', path.join(runtime, 'profile'), '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'] });
