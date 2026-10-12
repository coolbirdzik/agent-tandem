import { build } from 'esbuild';
import { mkdir, copyFile, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
delete process.env.ELECTRON_RUN_AS_NODE;
const root = process.cwd(), runtime = path.join(root, '.test-runtime', `queue-host-${Date.now()}`), extension = path.join(runtime, 'extension'), workspace = path.join(runtime, 'workspace'), profile = path.join(runtime, 'profile'), control = path.join(runtime, 'control');
const other = path.join(runtime, 'other'), workspaceFile = path.join(runtime, 'test.code-workspace');
for (const dir of [path.join(extension, 'dist'), workspace, other, path.join(profile, 'User'), control, path.join(runtime, 'codex'), path.join(runtime, 'claude'), path.join(root, 'artifacts')]) await mkdir(dir, { recursive: true });
await writeFile(workspaceFile, JSON.stringify({ folders: [{ path: workspace }, { path: other }] }));
for (const dir of [workspace, other]) await writeFile(path.join(dir, 'anchor.txt'), 'Queue test root');
await copyFile(path.join(root, 'package.json'), path.join(extension, 'package.json')); await cp(path.join(root, 'media'), path.join(extension, 'media'), { recursive: true });
for (const file of ['webview.js', 'claude-history.mjs']) await copyFile(path.join(root, 'dist', file), path.join(extension, 'dist', file));
await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'files.hotExit': 'off' }));
const providers = path.join(root, 'tests/fixtures/queue-provider.ts');
await build({ entryPoints: ['src/extension.ts'], outfile: path.join(extension, 'dist/extension.js'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], plugins: [{ name: 'controlled-test-providers', setup(build) {
  build.onLoad({ filter: /[\\/]src[\\/]providers[\\/](codex-chat|claude-chat|probe|model-catalog|account-status)\.ts$/ }, args => {
    const name = path.basename(args.path);
    if (name === 'codex-chat.ts' || name === 'claude-chat.ts') return { contents: `export { runCodexChat, runClaudeChat } from ${JSON.stringify(providers)};`, loader: 'ts', resolveDir: root };
    if (name === 'probe.ts') return { contents: `export const findExecutable=async(name,configured)=>configured||process.execPath;export const cliInfo=async(name,configured)=>({executable:configured||process.execPath,version:name==='codex'?'codex-cli fixture':'fixture (Claude Code)'});export const installedCLIs=async(name)=>[await cliInfo(name)];export const probeCodex=async()=>({});export const probeClaude=probeCodex;`, loader: 'js' };
    if (name === 'model-catalog.ts') return { contents: 'export const codexModels=async()=>[];export const claudeModels=codexModels;', loader: 'js' };
    return { contents: "export const readCodexAccount=async()=>({status:'ready',account:{signedIn:false,method:'Not signed in'},quota:{status:'unavailable',windows:[]}});export const readClaudeAccount=readCodexAccount;", loader: 'js' };
  });
} }] });
await build({ entryPoints: ['tests/extension/queue.ts'], outfile: path.join(extension, 'dist/queue-tests.js'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'] });
const options = { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'), extensionDevelopmentPath: extension, extensionTestsPath: path.join(extension, 'dist/queue-tests.js'), extensionTestsEnv: { CODEX_HOME: path.join(runtime, 'codex'), CLAUDE_CONFIG_DIR: path.join(runtime, 'claude'), AGENT_TANDEM_QUEUE_CONTROL: control, AGENT_TANDEM_QUEUE_REPORT_DIR: path.join(root, 'artifacts') }, launchArgs: [workspaceFile, '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'] };
await runTests(options);
await runTests({ ...options, extensionTestsEnv: { ...options.extensionTestsEnv, AGENT_TANDEM_QUEUE_PHASE: 'reopen' } });
