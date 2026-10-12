import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';
delete process.env.ELECTRON_RUN_AS_NODE;
const root = process.cwd(), runtime = path.join(root, '.test-runtime', `checkpoints-${Date.now()}`);
const workspace = path.join(runtime, 'workspace'), profile = path.join(runtime, 'profile');
// Fixture-only histories: no login material, inference, or writes to native user homes.
const codexHome = path.join(runtime, 'codex'), claudeHome = path.join(runtime, 'claude');
const claudeProject = path.join(claudeHome, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
for (const folder of [workspace, path.join(profile, 'User'), path.join(codexHome, 'sessions'), claudeProject, path.join(root, 'artifacts')]) await mkdir(folder, { recursive: true });
const codexId = '11111111-1111-4111-8111-111111111111', claudeId = '22222222-2222-4222-8222-222222222222';
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n', timestamp = new Date().toISOString();
await writeFile(path.join(codexHome, 'sessions', `rollout-${codexId}.jsonl`), jsonl([
  { timestamp, type: 'session_meta', payload: { id: codexId, cwd: workspace } },
  ...[1, 2].flatMap(i => [
    { timestamp, type: 'event_msg', payload: { type: 'user_message', client_id: `u${i}`, message: 'Update file' } },
    { timestamp, type: 'response_item', payload: { type: 'message', id: `a${i}`, role: 'assistant', content: [{ type: 'output_text', text: `Updated ${i}` }] } },
  ]),
]));
const uuids = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'];
await writeFile(path.join(claudeProject, `${claudeId}.jsonl`), jsonl(uuids.map((uuid, i) => ({ uuid, parentUuid: uuids[i - 1] ?? null, type: i % 2 ? 'assistant' : 'user', sessionId: claudeId, cwd: workspace, timestamp, isSidechain: false, message: { role: i % 2 ? 'assistant' : 'user', content: i % 2 ? [{ type: 'text', text: `Updated ${i}` }] : 'Update file' } }))));
await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'files.hotExit': 'off' }));
const options = {
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
  extensionDevelopmentPath: root, extensionTestsPath: path.join(root, 'dist/checkpoint-tests.js'),
  extensionTestsEnv: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, AGENT_TANDEM_CHECKPOINT_STORAGE: path.join(profile, 'User/globalStorage/agent-tandem-local.agent-tandem'), AGENT_TANDEM_CHECKPOINT_REPORT: path.join(root, 'artifacts/checkpoint-extension-test.json') },
  launchArgs: [workspace, '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
};
await runTests(options);
await runTests({ ...options, extensionTestsEnv: { ...options.extensionTestsEnv, AGENT_TANDEM_CHECKPOINT_REOPEN: 'true', AGENT_TANDEM_CHECKPOINT_REPORT: path.join(root, 'artifacts/checkpoint-extension-reopen-test.json') } });
