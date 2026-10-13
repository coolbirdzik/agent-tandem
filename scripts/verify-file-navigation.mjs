import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function until(get, label) {
  const start = Date.now(); while (true) { const value = await get().catch(() => undefined); if (value) return value; if (Date.now() - start > 60_000) throw new Error(`Timed out: ${label}`); await pause(); }
}
/** Click stable editor-title actions and the real status-bar file picker. */
export async function verifyFileNavigation(runtime, port, edition) {
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.type === 'page' && page.url.includes('workbench')), 'VS Code renderer');
  const ws = new WebSocket(page.webSocketDebuggerUrl), pending = new Map(); let id = 0;
  ws.addEventListener('message', event => { const message = JSON.parse(String(event.data)), entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); ws.send(JSON.stringify({ id: next, method, params })); });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const toolbar = `Array.from(document.querySelectorAll('.editor-actions .action-label')).filter(e=>e.getBoundingClientRect().width)`;
  try {
    await until(async () => JSON.parse(await readFile(path.join(runtime, 'stage.json'), 'utf8')).stage === 'files', 'native file controls ready');
    const controls = await until(() => evaluate(`(()=>{const controls=(${toolbar}).map(e=>({label:e.getAttribute('aria-label')||e.title||'',text:e.textContent})).filter(e=>/^(Previous file|Next file|Choose changed file)/.test(e.label));return controls.length===3?controls:undefined;})()`), 'visible editor title buttons');
    assert.equal(controls.length, 3, 'All stable file-navigation actions are visible');
    const lenses = await until(() => evaluate(`Array.from(document.querySelectorAll('.codelens-decoration a')).filter(e=>e.getBoundingClientRect().width&&/Accept|Reject|Next change|Next file/.test(e.textContent)).map(e=>({text:e.textContent,fontSize:getComputedStyle(e).fontSize}))`)
      .then(rows => rows.length >= 4 ? rows : undefined), 'rendered inline review actions');
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(process.cwd(), 'artifacts', `file-navigation-${edition}.png`), Buffer.from(shot.data, 'base64'));
    for (const [name, count] of [['Next file', '2/4'], ['Next file', '3/4'], ['Previous file', '2/4']]) {
      await until(() => evaluate(`(()=>{const b=(${toolbar}).find(e=>(e.getAttribute('aria-label')||e.title||'').startsWith(${JSON.stringify(name)}));if(!b||b.getAttribute('aria-disabled')==='true')return;b.click();return true;})()`), `click ${name}`);
      await until(() => evaluate(`Array.from(document.querySelectorAll('.statusbar-item')).some(e=>e.textContent.includes('File ${count}'))`), `file counter ${count}`);
    }
    await evaluate(`(()=>{const item=Array.from(document.querySelectorAll('.statusbar-item')).find(e=>e.textContent.includes('File 2/4'));(item.querySelector('a')||item).click();})()`);
    await until(() => evaluate(`!!document.querySelector('.quick-input-widget .monaco-list-row')`), 'status-bar picker');
    await evaluate(`(()=>{const input=document.querySelector('.quick-input-widget input');input.value='03-deleted.ts';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(() => evaluate(`(()=>{const rows=Array.from(document.querySelectorAll('.quick-input-widget .monaco-list-row')).filter(e=>e.getBoundingClientRect().height);return !!document.activeElement?.closest('.quick-input-widget')&&rows.length===1&&rows[0].textContent.includes('03-deleted.ts');})()`), 'filtered picker is focused');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(() => evaluate(`Array.from(document.querySelectorAll('.statusbar-item')).some(e=>e.textContent.includes('File 3/4'))`), 'chosen file opens');
    console.log(`FILE_NAVIGATION_UI ${JSON.stringify({ edition, controls, lenses, clicks: ['next', 'next', 'previous', 'choose deleted file'] })}`);
  } finally { ws.close(); await writeFile(path.join(runtime, 'files.done'), 'clicked'); }
}
