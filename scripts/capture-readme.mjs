import { spawn } from 'node:child_process';
import { mkdir, stat, copyFile } from 'node:fs/promises';
import path from 'node:path';

// Run `npm run build` and `node scripts/test-review-webview.mjs
// --marketplace-only --readme` first for the real VS Code editor captures.
const root = process.cwd(), output = path.join(root, 'media/screenshots');
const runtime = path.join(root, '.test-runtime', `readme-screenshots-${Date.now()}`);
const chrome = process.env.CHROME_EXECUTABLE_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
await mkdir(output, { recursive: true }); await mkdir(runtime, { recursive: true });
const servers = [];
function preview(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(child);
    let log = '';
    const timeout = setTimeout(() => reject(new Error(`Preview startup timed out: ${script}`)), 15000);
    child.stdout.on('data', chunk => {
      log += chunk;
      const url = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) { clearTimeout(timeout); resolve(url); }
    });
    child.stderr.on('data', chunk => { log += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); if (code) reject(new Error(`${script} exited ${code}: ${log}`)); });
  });
}
async function capture(name, url, width, height) {
  const file = path.join(output, `${name}.png`);
  await new Promise((resolve, reject) => {
    const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      `--user-data-dir=${path.join(runtime, name)}`, `--window-size=${width},${height}`, '--force-device-scale-factor=1', '--virtual-time-budget=7000', `--screenshot=${file}`, url],
      { cwd: root, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Capture timed out: ${name}`)); }, 30000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Chrome capture failed: ${name} (${code})`)); });
  });
  const { size } = await stat(file); if (size < 1000) throw new Error(`Empty screenshot: ${name}`);
  console.log(`README_SCREENSHOT ${name}.png (${size} bytes)`);
}
try {
  const panel = await preview('scripts/preview-panel.mjs');
  const settings = await preview('scripts/preview-settings.mjs', ['--demo']);
  await capture('review', `${panel}/?groups=1`, 1100, 900);
  await capture('chat', `${panel}/`, 900, 1100);
  await capture('history', `${panel}/?history=1`, 900, 760);
  await capture('dashboard', `${settings}/?accounts=1`, 1440, 1680);
  await capture('storage', `${settings}/?storage=1`, 1440, 1280);
  await copyFile(path.join(root, 'artifacts/review-webview-marketplace.png'), path.join(output, 'editor-diff.png'));
  await copyFile(path.join(root, 'artifacts/readme-image-diff-marketplace.png'), path.join(output, 'image-diff.png'));
  await copyFile(path.join(root, 'artifacts/review-agent-changes-marketplace.png'), path.join(output, 'agent-changes.png'));
  console.log('README_SCREENSHOTS_DONE');
} finally { for (const server of servers) server.kill(); }
