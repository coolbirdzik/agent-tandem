import path from 'node:path';
import { mkdir, writeFile, open } from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';
import { providerTestHomes } from './provider-test-homes.mjs';
delete process.env.ELECTRON_RUN_AS_NODE;
const root = process.cwd();
const runtime = path.join(root, '.test-runtime', `review-live-${Date.now()}`);
const workspace = path.join(runtime, 'workspace'), profile = path.join(runtime, 'profile');
await mkdir(workspace, { recursive: true }); await mkdir(path.join(profile, 'User'), { recursive: true });
const large = process.argv.includes('--large');
const largeFile = process.argv.includes('--large-file');
if (largeFile) {
  await mkdir(path.join(workspace, 'src'));
  const core = await open(path.join(workspace, 'src/core'), 'w');
  try { await core.truncate(105 * 1024 * 1024); } finally { await core.close(); }
  console.log('Prepared a 105 MiB src/core file for the per-file snapshot regression.');
}
if (large) {
  const sources = path.join(workspace, 'sources'); await mkdir(sources);
  let next = 0;
  await Promise.all(Array.from({ length: 16 }, async () => { while (next < 20_001) { const index = next++; await writeFile(path.join(sources, `${index}.txt`), 'unchanged source fixture\n'); } }));
  console.log('Prepared 20,001 source files for the large workspace chat regression.');
}
await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'files.hotExit': 'off', ...(process.env.AGENT_DOCK_REVIEW_CODEX_EXECUTABLE ? { 'agentDock.codexExecutable': process.env.AGENT_DOCK_REVIEW_CODEX_EXECUTABLE } : {}) }));
const providerHomes = await providerTestHomes(runtime);
const options = {
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
  extensionDevelopmentPath: root, extensionTestsPath: path.join(root, 'dist/review-live-tests.js'),
  extensionTestsEnv: { ...providerHomes, AGENT_DOCK_REVIEW_REPORT: path.join(root, `artifacts/${largeFile ? 'review-large-file-test' : large ? 'review-large-test' : 'review-live-test'}.json`), AGENT_DOCK_REVIEW_LARGE: large ? '1' : '0', AGENT_DOCK_REVIEW_LARGE_FILE: largeFile ? '1' : '0' },
  launchArgs: [workspace, '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
};
await runTests(options);
await runTests({ ...options, extensionTestsEnv: { ...options.extensionTestsEnv, AGENT_DOCK_TEST_PHASE: 'reopen' } });
