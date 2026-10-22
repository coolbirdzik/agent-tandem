import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd(), runtime = path.join(root, '.test-runtime', `quota-hover-${Date.now()}`), fixture = path.join(runtime, 'extension'), profile = path.join(runtime, 'profile');
const report = path.join(runtime, 'report.json');
const light = process.argv.includes('--light'), suffix = light ? '-light' : '';
await mkdir(fixture, { recursive: true }); await mkdir(path.join(profile, 'User'), { recursive: true }); await mkdir(path.join(root, 'artifacts'), { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir(path.join(fixture, 'media'), { recursive: true }); await copyFile('media/provider-icons.ttf', path.join(fixture, 'media', 'provider-icons.ttf'));
await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'quota-hover-fixture', publisher: 'agent-tandem-tests', version: '1.0.0', engines: { vscode: '^1.100.0' }, main: './main.cjs', activationEvents: ['onStartupFinished'], contributes: { icons: manifest.contributes.icons } }));
await writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({ 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none', 'window.zoomLevel': 0, 'workbench.colorTheme': light ? 'Default Light Modern' : 'Default Dark Modern', 'extensions.autoCheckUpdates': false, 'agentTandem.statusBarProviders': 'codex', 'agentTandem.statusBarFields': ['quota'] }));
await build({ entryPoints: ['tests/extension/quota-hover.ts'], outfile: path.join(fixture, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['vscode'] });
const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const env = { ...process.env, AGENT_TANDEM_HOVER_REPORT: report }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'), ['--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), '--extensionDevelopmentPath', fixture, `--remote-debugging-port=${port}`, '--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'], { env, windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(get, label) { const start = Date.now(); while (Date.now() - start < 30000) { const value = await get().catch(() => undefined); if (value) return value; await pause(150); } throw new Error(`Timed out: ${label}`); }
let ws;
try {
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.url.includes('workbench')), 'renderer');
  ws = new WebSocket(page.webSocketDebuggerUrl); const pending = new Map(); let id = 0;
  ws.onmessage = event => { const value = JSON.parse(String(event.data)), entry = pending.get(value.id); if (!entry) return; pending.delete(value.id); value.error ? entry.reject(value.error) : entry.resolve(value.result); };
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); ws.send(JSON.stringify({ id: next, method, params })); });
  const evaluate = async expression => { const data = await call('Runtime.evaluate', { expression, returnByValue: true }); if (data.exceptionDetails) throw new Error(JSON.stringify(data.exceptionDetails)); return data.result.value; };
  await until(async () => JSON.parse(await readFile(report, 'utf8')).ready, 'fixture');
  const statusSelector = `.statusbar-item[id*="agentTandem.quota.codex"]`;
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(statusSelector)})`), 'status item');
  const hover = async () => {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 100 }); await pause(250);
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(statusSelector)});if(!e)return;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    assert.ok(point, 'Codex quota status visible'); await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await until(() => evaluate(`document.querySelector('.monaco-hover')?.textContent?.includes('Open dashboard')`), 'hover menu');
  };
  const clickLink = async name => {
    const point = await evaluate(`(()=>{const e=[...document.querySelectorAll('.monaco-hover a')].find(e=>e.textContent.includes(${JSON.stringify(name)}));if(!e)return;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    assert.ok(point, name); await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  await hover();
  const text = await evaluate(`document.querySelector('.monaco-hover').innerText`); assert.match(text, /Reset usage/); assert.match(text, /Work/); assert.match(text, /24% left/);
  assert.equal(text.match(/24% left/g)?.length, 1, 'Current quota appears once');
  assert.doesNotMatch(text, /Work old copy|0% left/, 'Stale duplicate quota and saved profile are omitted');
  assert.match(text, /Extension storage/i); assert.match(text, /1.4 GB/); assert.match(text, /Above 1 GB/);
  const palette = await evaluate(`([...document.querySelectorAll('.monaco-hover span[style*="color"]')].map(e=>({text:e.textContent,color:getComputedStyle(e).color})))`);
  assert.ok(new Set(palette.map(row=>row.color)).size >= 3, 'Native hover renders theme colors');
  const layout = await evaluate(`(()=>{const hover=document.querySelector('.monaco-hover');return {bars:[...hover.querySelectorAll('td img')].map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,loaded:e.complete&&e.naturalWidth>0})),sections:[...hover.querySelectorAll('h5')].map(e=>e.textContent),overflow:[...hover.querySelectorAll('table')].some(e=>e.scrollWidth>e.clientWidth+1)}})()`);
  assert.equal(layout.bars.length, 2, 'Both quota meters survive native HTML sanitization');
  assert.ok(layout.bars.every(bar => bar.loaded && bar.width === 132 && bar.height === 6), 'Quota meters render as thin SVG bars');
  assert.equal(layout.overflow, false, 'Hover tables fit without horizontal overflow');
  assert.deepEqual(layout.sections, ['SWITCH ACCOUNT', 'EXTENSION STORAGE'], 'Switching and storage have section labels');
  const anchor = await evaluate(`(()=>{const r=document.querySelector('.monaco-hover').getBoundingClientRect();return{x:r.x+20,y:r.y+20}})()`);
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...anchor });
  const shot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(root, 'artifacts', `quota-hover-native${suffix}.png`), Buffer.from(shot.data, 'base64'));
  const hoverRect = await evaluate(`(()=>{const r=document.querySelector('.monaco-hover').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
  const crop = await call('Page.captureScreenshot', { format: 'png', clip: hoverRect }); await mkdir(path.join(root, 'media', 'screenshots'), { recursive: true });
  await writeFile(path.join(root, light ? 'artifacts' : 'media/screenshots', `account-hover${suffix}.png`), Buffer.from(crop.data, 'base64'));
  await clickLink('Open dashboard'); await until(async () => JSON.parse(await readFile(report, 'utf8')).actions.includes('dashboard'), 'dashboard link');
  await hover(); await clickLink('Manage storage'); await until(async () => JSON.parse(await readFile(report, 'utf8')).actions.includes('storage'), 'storage link');
  for (const [label, scope] of [['Clean accepted', 'accepted'], ['Clean all', 'all']]) {
    await hover(); await clickLink(label);
    await until(async () => JSON.parse(await readFile(report, 'utf8')).actions.includes(`review-preview:${scope}`), `${label} preview link`);
  }
  await hover(); await clickLink('Switch'); await until(async () => JSON.parse(await readFile(report, 'utf8')).actions.includes('switch:two'), 'switch link');
  await hover(); await clickLink('Reset usage'); await until(async () => JSON.parse(await readFile(report, 'utf8')).actions.includes('reset'), 'reset link');
  await hover(); assert.match(await evaluate(`document.querySelector('.monaco-hover').innerText`), /1 earned reset/);
  await clickLink('Search');
  await until(() => evaluate(`document.querySelector('.quick-input-widget')?.innerText.includes('Open dashboard')`), 'search popup with dashboard action');
  assert.doesNotMatch(await evaluate(`document.querySelector('.quick-input-widget').innerText`), /Work old copy/, 'Search popup also deduplicates saved identities');
  const popup = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(root, 'artifacts', `quick-accounts-native${suffix}.png`), Buffer.from(popup.data, 'base64'));
  const result = { ...(JSON.parse(await readFile(report, 'utf8'))), nativeHoverVerified: true, storageWarningVerified: true, colors: palette, realCreditsConsumed: false };
  await writeFile(path.join(root, 'artifacts', `quota-hover-native${suffix}.json`), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  ws.send(JSON.stringify({ id: ++id, method: 'Browser.close' }));
} finally { ws?.close(); child.kill(); }
