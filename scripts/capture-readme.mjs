import { spawn } from 'node:child_process';
import { mkdir, stat, copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Run `npm run build` first. Use --usage-only for dashboards or --review-storage-only for review cleanup.
// Full capture also needs `node scripts/test-review-webview.mjs --marketplace-only --readme`
// for the real VS Code editor captures.
const root = process.cwd(), output = path.join(root, 'media/screenshots');
const runtime = path.join(root, '.test-runtime', `readme-screenshots-${Date.now()}`);
const chrome = process.env.CHROME_EXECUTABLE_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
await mkdir(output, { recursive: true }); await mkdir(runtime, { recursive: true });
const servers = [];
const usageOnly = process.argv.includes('--usage-only');
const reviewStorageOnly = process.argv.includes('--review-storage-only');
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
// Crops one dashboard section (or the union of several) through the DevTools
// protocol; `setup` runs in the page first, e.g. to open a conversation.
async function captureSection(name, url, width, selectors, setup = '', view = 'all', exactTargets = false) {
  const profile = path.join(runtime, name), file = path.join(output, `${name}.png`);
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, `--window-size=${width},1200`, '--force-device-scale-factor=1', 'about:blank'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(get, label) { const start = Date.now(); while (true) { const value = await get().catch(() => undefined); if (value) return value; if (Date.now() - start > 30000) throw new Error(`Timed out: ${name} ${label}`); await pause(150); } }
  try {
    const port = await until(async () => (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0], 'DevTools port');
    const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.type === 'page'), 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl), pending = new Map(); let id = 0;
    ws.addEventListener('message', event => { const message = JSON.parse(String(event.data)), entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); });
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); ws.send(JSON.stringify({ id: next, method, params })); });
    const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
    await call('Page.navigate', { url });
    const targets = `${JSON.stringify(selectors)}.map(s=>{const e=document.querySelector(s);return ${exactTargets ? 'e' : "e?.closest('section:not(#dashboard-detail):not(#dashboard)')??e"}})`;
    await until(() => evaluate(view === 'storage' ? `!document.getElementById('storage').hidden && !!document.querySelector('[data-review-cleanup]')` : `document.getElementById('dashboard-view').value===${JSON.stringify(view)}&&!!document.querySelector('#account-groups .account-group')`), 'dashboard');
    await pause(800); if (setup) await evaluate(setup);
    await until(() => evaluate(`${targets}.every(e=>e&&e.getBoundingClientRect().height>40)`), 'dashboard sections');
    await evaluate('scrollTo(0,0)'); await pause(800);
    const pad = 24, gap = 12, rect = await evaluate(`(()=>{const r=${targets}.map(e=>e.getBoundingClientRect());const top=Math.min(...r.map(b=>b.top))+scrollY,left=Math.min(...r.map(b=>b.left)),bottom=Math.max(...r.map(b=>b.bottom))+scrollY,right=Math.max(...r.map(b=>b.right));return{top,left,bottom,right}})()`);
    const clip = { x: Math.max(0, rect.left - pad), y: Math.max(0, rect.top - gap), width: Math.min(width, rect.right + pad) - Math.max(0, rect.left - pad), height: rect.bottom - rect.top + gap * 2, scale: 1 };
    const shot = await call('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    await writeFile(file, Buffer.from(shot.data, 'base64')); ws.close();
  } finally { child.kill(); }
  const { size } = await stat(file); if (size < 1000) throw new Error(`Empty screenshot: ${name}`);
  console.log(`README_SCREENSHOT ${name}.png (${size} bytes)`);
}
try {
  const panel = usageOnly || reviewStorageOnly ? undefined : await preview('scripts/preview-panel.mjs');
  const settings = await preview('scripts/preview-settings.mjs', ['--demo']);
  if (reviewStorageOnly) {
    await captureSection('review-storage', `${settings}/?storage=1`, 1200, ['#storage'], `document.querySelector('[data-storage-page="unused"]').click()`, 'storage', true);
  } else {
    if (!usageOnly) {
      await capture('review', `${panel}/?groups=1`, 1100, 900);
      await capture('chat', `${panel}/`, 900, 1100);
      await capture('history', `${panel}/?history=1`, 900, 760);
    }
    await capture('dashboard', `${settings}/?accounts=1`, 1440, 1400);
    const all = `${settings}/?accounts=1&view=all&range=month`;
    await capture('token-dashboard', all, 1440, 1696);
    await captureSection('account-detail', `${settings}/?accounts=1`, 1440, ['#account-detail-bar', '.dashboard-grid'], `document.querySelector('.account-group-open').click()`, 'accounts');
    await captureSection('quota-burn-down', all, 1440, ['#quota-pace']);
    await captureSection('tokens-per-quota', all, 1440, ['#quota-estimates > .quota-estimate-provider:first-child'], '', 'all', true);
    await captureSection('quota-cycle-tokens', all, 1440, ['#quota-estimates > .quota-estimate-provider:first-child'], `document.querySelectorAll('#quota-estimates > .quota-estimate-provider:first-child .quota-chart-control select').forEach((select, index) => { select.value = index ? 'capacityTokens' : 'observedTokens'; select.dispatchEvent(new Event('change')); })`, 'all', true);
    await captureSection('conversations', all, 1440, ['#conversation-breakdown'], `document.querySelector('#conversation-breakdown button').click()`);
    await captureSection('usage-breakdown', all, 1440, ['#period-breakdown', '#account-breakdown'], `document.getElementById('period-toggle-all').click()`);
    if (!usageOnly) {
      await capture('accounts', `${settings}/?accounts=1&page=accounts`, 1440, 1080);
      await capture('account-switch', `${settings}/?accounts=1&switch=1`, 1440, 1080);
      await capture('preferences', `${settings}/?page=preferences`, 1200, 900);
      await capture('storage', `${settings}/?storage=1`, 1440, 1260);
      await capture('storage-cleanup', `${settings}/?storage=1&nativeMatching=1&age=30`, 1440, 1000);
      await copyFile(path.join(root, 'artifacts/review-webview-marketplace.png'), path.join(output, 'editor-diff.png'));
      await copyFile(path.join(root, 'artifacts/readme-image-diff-marketplace.png'), path.join(output, 'image-diff.png'));
      await copyFile(path.join(root, 'artifacts/review-agent-changes-marketplace.png'), path.join(output, 'agent-changes.png'));
    }
  }
  console.log('README_SCREENSHOTS_DONE');
} finally { for (const server of servers) server.kill(); }
