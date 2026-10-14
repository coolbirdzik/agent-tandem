import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';
delete process.env.ELECTRON_RUN_AS_NODE;
const root = process.cwd(), runtime = path.join(root, '.test-runtime', `settings-host-${Date.now()}`), workspace = path.join(runtime, 'workspace'), profile = path.join(runtime, 'profile');
const codex = path.join(runtime, 'codex'), claude = path.join(runtime, 'claude'), stamp = new Date(Date.now() - 60000).toISOString();
for (const folder of [workspace, path.join(profile, 'User'), path.join(codex, 'sessions'), path.join(codex, 'archived_sessions'), path.join(claude, 'projects', 'another-project'), path.join(root, 'artifacts')]) await mkdir(folder, { recursive: true });
// No inference/auth needed: make provider discovery fail locally, keeping this a host/UI test.
await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'files.hotExit': 'off', 'agentTandem.codexExecutable': path.join(runtime, 'missing-codex.exe'), 'agentTandem.claudeExecutable': path.join(runtime, 'missing-claude.exe') }));
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const meta = { timestamp: stamp, type: 'session_meta', payload: { id: '11111111-1111-4111-8111-111111111111', cwd: workspace, creator_account_id: 'fixture-account' } };
await writeFile(path.join(codex, 'sessions', 'rollout.jsonl'), jsonl([meta, { type: 'turn_context', payload: { turn_id: 'turn', model: 'gpt-5.3-codex' } }, { timestamp: stamp, type: 'token_usage_record', payload: { response_id: 'codex1', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 } } }]));
await writeFile(path.join(codex, 'archived_sessions', 'other.jsonl'), jsonl([{ ...meta, payload: { ...meta.payload, id: '33333333-3333-4333-8333-333333333333' } }, { timestamp: stamp, type: 'token_usage_record', payload: { response_id: 'codex2', model: 'another-model', usage: { input_tokens: 100, output_tokens: 10 } } }]));
const message = { timestamp: stamp, type: 'assistant', sessionId: '22222222-2222-4222-8222-222222222222', message: { id: 'claude1', role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 400, output_tokens: 40 } } };
await writeFile(path.join(claude, 'projects', 'another-project', 'session.jsonl'), jsonl([message, message]));
await runTests({ vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
  extensionDevelopmentPath: process.env.AGENT_TANDEM_EXTENSION_PATH || root, extensionTestsPath: path.join(root, 'dist/settings-host-tests.js'), extensionTestsEnv: { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude, AGENT_TANDEM_REPORT_DIR: path.join(root, 'artifacts') },
  launchArgs: [workspace, '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'] });
