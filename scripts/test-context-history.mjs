import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';

delete process.env.ELECTRON_RUN_AS_NODE;
const root = process.cwd(), runtime = path.join(root, '.test-runtime', `context-history-${Date.now()}`);
const workspace = path.join(runtime, 'workspace'), profile = path.join(runtime, 'profile'), codexHome = path.join(runtime, 'codex'), claudeHome = path.join(runtime, 'claude');
for (const directory of [workspace, path.join(profile, 'User'), path.join(codexHome, 'sessions'), claudeHome]) await mkdir(directory, { recursive: true });
const fixture = path.join(codexHome, 'sessions', 'rollout-context.jsonl');
const context = '<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n- Dropbox (app-69b31dc2110c8191b8b47dc98fe5a052@openai-curated-remote)\n- GitHub (github@openai-curated-remote)\n</recommended_plugins>\n<environment_context><cwd>H:\\Code\\aot-new</cwd><shell>powershell</shell><current_date>2026-10-08</current_date><timezone>Asia/Saigon</timezone><filesystem><workspace_roots><root>H:\\Code\\aot-new</root></workspace_roots><permission_profile type="managed"><file_system type="restricted" /></permission_profile></filesystem></environment_context>';
await writeFile(fixture, [
  { type: 'session_meta', payload: { id: '11111111-1111-4111-8111-111111111111', cwd: workspace } },
  { type: 'response_item', payload: { type: 'message', role: 'user', id: 'context', content: [{ type: 'input_text', text: context }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', id: 'page-context', content: [{ type: 'input_text', text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: 'Fix context history display' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'a1', content: [{ type: 'output_text', text: `Example: \n\`\`\`xml\n${context}\n\`\`\`` }] } },
  { type: 'response_item', payload: { type: 'function_call_output', id: 't1', call_id: 'tool-1', output: context } },
].map(record => JSON.stringify(record)).join('\n') + '\n');
await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'files.hotExit': 'off' }));
const options = {
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
  extensionDevelopmentPath: root, extensionTestsPath: path.join(root, 'dist/context-history-tests.js'),
  extensionTestsEnv: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, AGENT_TANDEM_CONTEXT_FIXTURE: fixture, AGENT_TANDEM_CONTEXT_REPORT: path.join(root, 'artifacts/context-history-test.json') },
  launchArgs: [workspace, '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
};
await runTests(options);
await runTests({ ...options, extensionTestsEnv: { ...options.extensionTestsEnv, AGENT_TANDEM_CONTEXT_REOPEN: 'true', AGENT_TANDEM_CONTEXT_REPORT: path.join(root, 'artifacts/context-history-reopen-test.json') } });
