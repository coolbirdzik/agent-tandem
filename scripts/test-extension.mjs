import path from 'node:path';
import { mkdir, writeFile, mkdtemp, readFile, access } from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';
const root = process.cwd();
// Codex can itself be hosted in Electron; do not launch Code in Node-only mode.
delete process.env.ELECTRON_RUN_AS_NODE;
await mkdir(path.join(root, '.test-runtime'), { recursive: true });
const runtime = await mkdtemp(path.join(root, '.test-runtime', 'extension-'));
const packaged = !!process.env.AGENT_TANDEM_EXTENSION_PATH;
const extensionManifest = JSON.parse(await readFile(path.join(process.env.AGENT_TANDEM_EXTENSION_PATH || root, 'package.json'), 'utf8'));
const extensionId = `${extensionManifest.publisher}.${extensionManifest.name}`;
const profile = path.join(runtime, 'test-profiles', `${packaged ? 'packaged' : 'source'}-${Date.now()}`);
await mkdir(path.join(profile, 'User'), { recursive: true });
// This suite covers the native editor option; test-review-webview covers the default.
await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'files.hotExit': 'off', 'agentTandem.reviewEditor': 'native' }));
const reportDirectory = path.join(root, 'artifacts', ...(packaged ? ['packaged'] : []));
await mkdir(path.join(runtime, 'workspace'), { recursive: true });
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const workspace = path.join(runtime, 'workspace');
const otherProject = path.join(runtime, 'other-project');
await mkdir(otherProject, { recursive: true });
const workspaceFile = path.join(runtime, 'test.code-workspace');
// This suite owns explicit capture boundaries; external tracking has its own suite.
await writeFile(workspaceFile, JSON.stringify({ folders: [{ path: workspace }, { path: otherProject }], settings: { 'agentTandem.autoTrackExternalChanges': false } }));
const codexHome = path.join(runtime, 'codex');
const claudeHome = path.join(runtime, 'claude');
await mkdir(path.join(codexHome, 'sessions'), { recursive: true });
const claudeProject = path.join(claudeHome, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
await mkdir(claudeProject, { recursive: true });
const codexId = '11111111-1111-4111-8111-111111111111';
const claudeId = '22222222-2222-4222-8222-222222222222';
const codexFile = path.join(codexHome, 'sessions', `rollout-${codexId}.jsonl`);
const stamp = new Date().toISOString();
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
await writeFile(codexFile, jsonl([
  { timestamp: stamp, type: 'session_meta', payload: { id: codexId, cwd: workspace, source: 'vscode' } },
  { timestamp: stamp, type: 'event_msg', payload: { type: 'user_message', client_id: 'u1', message: 'Existing Codex conversation' } },
  { timestamp: stamp, type: 'response_item', payload: { type: 'message', id: 'a1', role: 'assistant', content: [{ type: 'output_text', text: 'Codex reply' }] } },
]));
const claudeFile = path.join(claudeProject, `${claudeId}.jsonl`);
await writeFile(claudeFile, jsonl([
  { uuid: '33333333-3333-4333-8333-333333333333', parentUuid: null, type: 'user', sessionId: claudeId, cwd: workspace, timestamp: stamp, isSidechain: false, message: { role: 'user', content: 'Existing Claude conversation' } },
  { uuid: '44444444-4444-4444-8444-444444444444', parentUuid: '33333333-3333-4333-8333-333333333333', type: 'assistant', sessionId: claudeId, cwd: workspace, timestamp: stamp, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Claude reply' }] } },
]));
// Use a separate profile. Existing windows/extensions and the user's profile stay untouched.
let executable = process.env.VSCODE_EXECUTABLE_PATH || (process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe') : undefined);
if (executable && !process.env.VSCODE_EXECUTABLE_PATH) {
  try { await access(executable); } catch { executable = undefined; }
}
try {
  const options = {
    vscodeExecutablePath: executable || undefined,
    extensionDevelopmentPath: process.env.AGENT_TANDEM_EXTENSION_PATH || root,
    extensionTestsPath: path.join(root, 'dist/extension-tests.js'),
    extensionTestsEnv: { AGENT_TANDEM_EXTENSION_ID: extensionId, AGENT_TANDEM_REPORT_DIR: reportDirectory, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, AGENT_TANDEM_CODEX_FIXTURE: codexFile, AGENT_TANDEM_CLAUDE_FIXTURE: claudeFile },
    launchArgs: [workspaceFile, '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
  };
  await runTests(options);
  await runTests({ ...options, extensionTestsEnv: { ...options.extensionTestsEnv, AGENT_TANDEM_TEST_PHASE: 'reopen' } });
} catch (error) { console.error(error); process.exitCode = 1; }
