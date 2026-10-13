import path from 'node:path';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runTests } from '@vscode/test-electron';
import { marketplaceManifest } from './marketplace-manifest.mjs';
import { verifyReviewWebview } from './verify-review-webview.mjs';
delete process.env.ELECTRON_RUN_AS_NODE;
const root = process.cwd(), manifest = JSON.parse(await readFile('package.json', 'utf8'));
const packaged = process.argv.includes('--packaged');
const editions = packaged || process.argv.includes('--marketplace-only') ? ['marketplace'] : ['local', 'marketplace'];
for (const edition of editions) {
  const runtime = path.join(root, '.test-runtime', `review-webview-${edition}-${Date.now()}`), project = path.join(runtime, 'workspace'), profile = path.join(runtime, 'profile');
  for (const folder of [project, path.join(profile, 'User'), path.join(root, 'artifacts')]) await mkdir(folder, { recursive: true });
  const codexSessions = path.join(runtime, 'codex', 'sessions'); await mkdir(codexSessions, { recursive: true });
  for (const [id, title] of [['11111111-1111-4111-8111-111111111111', 'Review new code and image changes'], ['22222222-2222-4222-8222-222222222222', 'Other agent conversation']]) {
    const timestamp = new Date().toISOString();
    await writeFile(path.join(codexSessions, `rollout-${id}.jsonl`), [
      { timestamp, type: 'session_meta', payload: { id, cwd: project } },
      { timestamp, type: 'event_msg', payload: { type: 'user_message', client_id: 'review-demo-user', message: title } },
      { timestamp, type: 'response_item', payload: { type: 'message', id: 'review-demo-assistant', role: 'assistant', content: [{ type: 'output_text', text: 'Saved changes are ready to review. Restore code previews the checkpoint before your message.' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  await promisify(execFile)('git', ['init', '-q'], { cwd: project, windowsHide: true });
  let extensionPath = root, extensionManifest = manifest;
  if (packaged) {
    extensionPath = JSON.parse(await readFile(path.join(root, 'artifacts/marketplace-build.json'), 'utf8')).stage;
    extensionManifest = JSON.parse(await readFile(path.join(extensionPath, 'package.json'), 'utf8'));
  } else if (edition === 'marketplace') {
    extensionPath = path.join(runtime, 'marketplace-extension'); extensionManifest = marketplaceManifest(manifest, { publisher: 'agent-tandem-preview' });
    await mkdir(extensionPath);
    for (const folder of ['dist', 'media', 'docs']) await cp(path.join(root, folder), path.join(extensionPath, folder), { recursive: true });
    await writeFile(path.join(extensionPath, 'package.json'), JSON.stringify(extensionManifest));
  }
  await writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'files.hotExit': 'off', 'window.zoomLevel': 0, 'editor.accessibilitySupport': 'off', 'workbench.startupEditor': 'none', 'agentTandem.autoTrackExternalChanges': false, 'agentTandem.codexExecutable': path.join(runtime, 'missing-codex.exe'), 'agentTandem.claudeExecutable': path.join(runtime, 'missing-claude.exe') }));
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve));
  console.log(`Review Webview runtime (${edition}): ${runtime}`);
  // No --enable-proposed-api: both editions exercise only the stable Webview APIs.
  const tests = runTests({ vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'), extensionDevelopmentPath: extensionPath, extensionTestsPath: path.join(root, 'dist/review-webview-tests.js'),
    extensionTestsEnv: { AGENT_TANDEM_EXTENSION_ID: `${extensionManifest.publisher}.${extensionManifest.name}`, AGENT_TANDEM_REVIEW_RUNTIME: runtime, AGENT_TANDEM_REVIEW_EDITION: edition, AGENT_TANDEM_README_SCREENSHOTS: process.argv.includes('--readme') ? '1' : '', CODEX_HOME: path.join(runtime, 'codex'), CLAUDE_CONFIG_DIR: path.join(runtime, 'claude') },
    launchArgs: [project, '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'] });
  await Promise.all([tests, verifyReviewWebview(runtime, port, edition)]);
}
