import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function until(get, description) {
  const start = Date.now(); while (true) { const value = await get().catch(() => undefined); if (value) return value; if (Date.now() - start > 60_000) throw new Error(`Timed out: ${description}`); await pause(); }
}
export async function verifyReviewWebview(runtime, port, edition) {
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.type === 'page' && page.url.includes('workbench')), 'VS Code workbench');
  const ws = new WebSocket(page.webSocketDebuggerUrl), pending = new Map(), sessions = new Map(); let id = 0;
  ws.addEventListener('message', event => { const message = JSON.parse(String(event.data)), entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); ws.send(JSON.stringify({ id: next, method, params, sessionId })); });
  let target;
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression: `(()=>{const d=document.querySelector('#active-frame')?.contentDocument||document;${expression}})()`, returnByValue: true, awaitPromise: true }, target);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const done = name => writeFile(path.join(runtime, `${name}.done`), 'clicked');
  const stage = name => until(async () => JSON.parse(await readFile(path.join(runtime, 'stage.json'), 'utf8')).stage === name, `${edition} ${name} stage`);
  const click = async selector => {
    await until(() => evaluate(`const b=d.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)return; b.click();return true;`), `click ${selector}`);
  };
  try {
    await stage('dark');
    target = await until(async () => {
      const { targetInfos } = await call('Target.getTargets');
      for (const info of targetInfos.filter(info => info.type === 'iframe')) {
        if (!sessions.has(info.targetId)) sessions.set(info.targetId, (await call('Target.attachToTarget', { targetId: info.targetId, flatten: true })).sessionId);
        const session = sessions.get(info.targetId);
        const result = await call('Runtime.evaluate', { expression: `!!(document.querySelector('#active-frame')?.contentDocument||document).querySelector('.diff-block .accept')`, returnByValue: true }, session);
        if (result.result?.value) return session;
      }
    }, 'rendered review Webview');
    await until(() => evaluate(`return d.querySelector('#diff')?.dataset.diffReady==='true';`), 'Monaco worker computes the inline diff');
    const syntax = await until(() => evaluate(`const lines=[...d.querySelectorAll('.view-line')];const colors=[...new Set(lines.flatMap(line=>[...line.querySelectorAll('span')].filter(s=>s.textContent.trim()).map(s=>d.defaultView.getComputedStyle(s).color)))];return colors.length>1?{language:d.querySelector('#diff').dataset.language,colors}:undefined;`), 'syntax-highlighted source');
    assert.equal(syntax.language, 'typescript');
    await click('.next-block');
    await until(() => evaluate(`const block=d.querySelectorAll('.diff-block')[1],rect=block?.getBoundingClientRect();return d.querySelector('#block-count').textContent==='2 / 2'&&rect.top>=0&&rect.bottom<d.defaultView.innerHeight;`), 'Next change reveals its inline toolbar');
    await click('#previous');
    const colors = await evaluate(`return [...d.querySelectorAll('.diff-block:first-of-type .block-actions button')].map(b=>({text:b.textContent,background:d.defaultView.getComputedStyle(b).backgroundColor,color:d.defaultView.getComputedStyle(b).color,rect:b.getBoundingClientRect().toJSON()}));`);
    assert.ok(colors.some(button => /Accept/.test(button.text))); assert.ok(colors.some(button => /Reject/.test(button.text)));
    assert.notEqual(colors[0].background, colors[1].background, 'Accept and Reject have distinct filled colors');
    assert.notEqual(colors[1].background, colors[2].background, 'Next change has its own filled color');
    assert.ok(colors.every(button => button.rect.height >= 30));
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(process.cwd(), 'artifacts', `review-webview-${edition}.png`), Buffer.from(screenshot.data, 'base64'));
    console.log(`REVIEW_WEBVIEW_COLORS ${edition} ${JSON.stringify({colors,syntax})}`);
    await done('dark');
    await stage('light');
    await until(() => evaluate(`return d.body.classList.contains('vscode-light');`), 'light theme');
    const light = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(process.cwd(), 'artifacts', `review-webview-${edition}-light.png`), Buffer.from(light.data, 'base64')); await done('light');
    await stage('narrow');
    await call('Emulation.setDeviceMetricsOverride', { width: 620, height: 900, deviceScaleFactor: 1, mobile: false });
    const layout = await until(() => evaluate(`const b=d.querySelector('.diff-block');if(!b||d.defaultView.innerWidth>650)return;return {width:d.defaultView.innerWidth,buttons:[...b.querySelectorAll('button')].map(b=>b.getBoundingClientRect().toJSON())};`), 'narrow Webview layout');
    assert.ok(layout.buttons.every(rect => rect.left >= 0 && rect.right <= layout.width), 'Narrow layout retains every action without clipping');
    const narrow = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(process.cwd(), 'artifacts', `review-webview-${edition}-narrow.png`), Buffer.from(narrow.data, 'base64'));
    await call('Emulation.clearDeviceMetricsOverride'); await done('narrow');
    await stage('accept');
    await evaluate(`d.__staleReject=d.querySelector('.reject').onclick;return true;`);
    await click('.diff-block .accept'); await done('accept');
    await stage('stale'); await evaluate(`d.__staleReject();return true;`);
    await until(() => evaluate(`return d.querySelector('#error')?.textContent.includes('Changes updated');`), 'stale block error'); await done('stale');
    await stage('reject'); await click('.diff-block .reject'); await done('reject');
    await stage('undo'); await click('#undo'); await done('undo');
    await stage('external'); await click('.diff-block .reject');
    await until(() => evaluate(`return d.querySelector('#error')?.textContent.includes('changed after the agent');`), 'newer saved edit error'); await done('external');
    await stage('dirty'); await click('.diff-block .reject');
    await until(() => evaluate(`return d.querySelector('#error')?.textContent.includes('unsaved');`), 'readable dirty-buffer error'); await done('dirty');
    await stage('navigation'); await click('#next');
    await until(() => evaluate(`return d.querySelector('#files')?.value==='02-added.ts';`), 'next file');
    await until(() => evaluate(`return d.querySelector('#diff')?.dataset.diffReady==='true';`), 'large added file diff');
    await evaluate(`d.querySelector('.editor.modified .native-edit-context,.editor.modified textarea.inputarea').focus();return true;`);
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 });
    await until(() => evaluate(`return !!d.activeElement?.closest('.find-widget');`), 'Ctrl+F opens Monaco search');
    await call('Input.insertText', { text: 'tailMarker' });
    await until(() => evaluate(`return [...d.querySelectorAll('.view-line')].some(line=>line.textContent.includes('tailMarker')&&line.getBoundingClientRect().height>0);`), 'search reaches source beyond the first viewport');
    assert.equal(await evaluate(`return !!d.querySelector('#diff img');`), false, 'Source containing HTML stays inert');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await click('#next'); await until(() => evaluate(`return d.querySelector('#files')?.value==='03-deleted.ts';`), 'deleted file'); await done('navigation');
    await stage('binary'); await evaluate(`const select=d.querySelector('#files'); select.value='04-binary.dat';select.dispatchEvent(new d.defaultView.Event('change',{bubbles:true}));return true;`);
    await until(() => evaluate(`return d.querySelector('.file-review')?.textContent.includes('Binary');`), 'binary whole-file actions'); await done('binary');
    await stage('native'); await click('#native'); await done('native');
    await stage('complete');
  } finally { ws.close(); for (const name of ['dark', 'light', 'narrow', 'accept', 'stale', 'reject', 'undo', 'external', 'dirty', 'navigation', 'binary', 'native']) await done(name); }
}
