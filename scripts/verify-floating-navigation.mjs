import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const pause = () => new Promise(resolve => setTimeout(resolve, 150));
async function until(get, label) {
  const start = Date.now();
  while (true) { const value = await get().catch(() => undefined); if (value) return value; if (Date.now() - start > 60_000) throw new Error(`Timed out: ${label}`); await pause(); }
}
/** Exercise the actual rendered native menu in an isolated VS Code test window. */
export async function verifyFloatingNavigation(runtime, port) {
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page' && p.url.includes('workbench')), 'VS Code renderer');
  const ws = new WebSocket(page.webSocketDebuggerUrl), pending = new Map(); let id = 0;
  ws.addEventListener('message', event => { const result = JSON.parse(String(event.data)); if (!result.id) return; const callback = pending.get(result.id); if (!callback) return; pending.delete(result.id); result.error ? callback.reject(new Error(JSON.stringify(result.error))) : callback.resolve(result.result); });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); ws.send(JSON.stringify({ id: next, method, params, sessionId })); });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const menu = `Array.from(document.querySelectorAll('.floating-menu-overlay-widget .action-label, .floating-menu .action-label')).filter(e => e.getBoundingClientRect().width && /^(Previous change|Next change)/.test(e.getAttribute('aria-label') || e.textContent || e.title || '') )`;
  try {
    await until(async () => JSON.parse(await readFile(path.join(runtime, 'stage.json'), 'utf8')).stage === 'badge', 'count button ready');
    const sessions = new Map();
    const findBadge = async () => {
      const { targetInfos } = await call('Target.getTargets');
      for (const target of targetInfos.filter(t => t.type === 'iframe' || t.type === 'page')) {
        if (target.targetId === page.id) continue;
        if (!sessions.has(target.targetId)) sessions.set(target.targetId, (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId);
        const session = sessions.get(target.targetId);
        const result = await call('Runtime.evaluate', { expression: `(()=>{const b=(document.querySelector('#active-frame')?.contentDocument||document).querySelector('#change-file-count');if(!b)return;return {text:b.textContent,html:b.outerHTML,rect:b.getBoundingClientRect().toJSON()};})()`, returnByValue: true }, session);
        if (result.result?.value?.text) return { session, url: target.url, ...result.result.value };
      }
    };
    const badge = await until(findBadge, 'rendered File 1/4 inset button');
    assert.equal(badge.text, 'File 1/4');
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(process.cwd(), 'artifacts/change-file-badge.png'), Buffer.from(screenshot.data, 'base64'));
    const frame = await evaluate(`(()=>{const f=Array.from(document.querySelectorAll('iframe')).find(f=>f.src===${JSON.stringify(badge.url)});return f?.getBoundingClientRect().toJSON();})()`);
    assert.ok(frame, 'Count button iframe visible');
    const point = { x: frame.x + badge.rect.x + badge.rect.width / 2, y: frame.y + badge.rect.y + badge.rect.height / 2 };
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await until(() => evaluate(`document.querySelector('.quick-input-widget')?.textContent?.includes('AgentTandem · Changed files')`), 'count button opens changed-file picker');
    // The rendered list takes focus after the widget text, so keystrokes must wait for a row.
    await until(() => evaluate(`!!document.querySelector('.quick-input-widget .monaco-list-row') && document.activeElement?.closest('.quick-input-widget')!==null`), 'changed-file picker takes focus');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(() => evaluate(`Array.from(document.querySelectorAll('.statusbar-item')).find(e=>e.id.includes('changeCount'))?.textContent?.includes('File 2/4')`), 'count button picker opens second file');
    const updatedBadge = await until(async () => { const b = await findBadge(); return b?.text === 'File 2/4' ? b : undefined; }, 'rendered inset count changes to File 2/4');
    const afterBadge = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(process.cwd(), 'artifacts/change-file-badge-after.png'), Buffer.from(afterBadge.data, 'base64'));
    console.log(`CHANGE_FILE_BADGE ${JSON.stringify({ before: badge.text, after: updatedBadge.text, physicalClick: true })}`);
    await writeFile(path.join(runtime, 'badge.done'), 'clicked');
    for (const stage of ['single', 'multi']) {
      await until(async () => JSON.parse(await readFile(path.join(runtime, 'stage.json'), 'utf8')).stage === stage, `${stage} editor ready`);
      const info = await until(async () => {
        const result = await evaluate(`(${menu}).map(e=>({text:e.textContent,title:e.title,aria:e.getAttribute('aria-label'),html:e.outerHTML,rect:{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width}}))`);
        return result.length === 2 ? result : undefined;
      }, `${stage} floating previous/next buttons`);
      await writeFile(path.join(runtime, `${stage}-buttons.json`), JSON.stringify(info, null, 2));
      const screenshot = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(process.cwd(), 'artifacts', `change-navigation-${stage}.png`), Buffer.from(screenshot.data, 'base64'));
      const counters = [];
      const directions = stage === 'single' ? ['Next change', 'Next change', 'Previous change'] : [...Array(8).fill('Next change'), 'Previous change'];
      for (const direction of directions) {
        const rect = await evaluate(`(()=>{const el=(${menu}).find(e=>(e.getAttribute('aria-label')||e.textContent||e.title||'').startsWith(${JSON.stringify(direction)}));if(!el)return;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        assert.ok(rect, `${stage}: ${direction} visible`);
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect });
        await new Promise(resolve => setTimeout(resolve, 350));
        const counter = await evaluate(`Array.from(document.querySelectorAll('.statusbar-item')).find(e=>e.id.includes('changeCount'))?.textContent?.trim()`);
        assert.match(counter, /File [1-4]\/4/);
        counters.push(counter);
        if (stage === 'single') {
          const expected = [2, 3, 2][counters.length - 1];
          assert.match(counter, new RegExp('File ' + expected + '/4'));
        }
      }
      const afterScreenshot = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(process.cwd(), 'artifacts', `change-navigation-${stage}-after.png`), Buffer.from(afterScreenshot.data, 'base64'));
      await writeFile(path.join(runtime, `${stage}.done`), 'clicked');
      const selections = await until(async () => JSON.parse(await readFile(path.join(runtime, `${stage}-clicks.json`), 'utf8')), `${stage} click results`);
      if (stage === 'multi') assert.ok(selections.length >= 3, 'Multi-file toolbar clicks navigate code selections');
      if (stage === 'multi') assert.equal(new Set(counters).size, 4, 'Rendered multi-file counter reaches all four files');
      console.log(`FLOATING_NAV_${stage.toUpperCase()} ${JSON.stringify({ buttons: info.map(e => e.text || e.aria), counters, selections })}`);
    }
    const card = `(()=>{const d=document.querySelector('#active-frame')?.contentDocument;if(!d?.body?.dataset.reviewBlock)return;const c=d.querySelector('.card'),s=d.defaultView.getComputedStyle(c);return {id:d.body.dataset.reviewBlock,line:Number(d.body.dataset.blockLine),index:Number(d.body.dataset.blockIndex),chip:d.querySelector('.chip')?.textContent,box:{...c.getBoundingClientRect().toJSON(),radius:s.borderRadius,border:s.borderWidth,background:s.backgroundColor},buttons:Array.from(d.querySelectorAll('button')).map(b=>({action:b.dataset.action,text:b.textContent,disabled:b.disabled,rect:b.getBoundingClientRect().toJSON()}))};})()`;
    for (const [stage, action] of [['hunkAccept', 'accept'], ['hunkRevert', 'revert']]) {
      await until(async () => JSON.parse(await readFile(path.join(runtime, 'stage.json'), 'utf8')).stage === stage, `${action} target hunk ready`);
      const stageInfo = JSON.parse(await readFile(path.join(runtime, 'stage.json'), 'utf8'));
      const blocks = await until(async () => {
        const { targetInfos } = await call('Target.getTargets'), found = [];
        for (const target of targetInfos.filter(t => t.type === 'iframe')) {
          if (!sessions.has(target.targetId)) sessions.set(target.targetId, (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId);
          const result = await call('Runtime.evaluate', { expression: card, returnByValue: true }, sessions.get(target.targetId));
          if (result.result?.value?.id) found.push({ url: target.url, ...result.result.value });
        }
        return found.some(b => b.line === stageInfo.line && b.buttons.every(button => !button.disabled)) ? found : undefined;
      }, `${action} card rendered at each block`);
      assert.ok(blocks.length >= 2, 'More than one block has its own card');
      assert.ok(blocks.every(b => /Accept/.test(b.buttons.find(button => button.action === 'accept')?.text ?? '')
        && /Reject/.test(b.buttons.find(button => button.action === 'revert')?.text ?? '')
        && /Next change/.test(b.buttons.find(button => button.action === 'next')?.text ?? '')), 'Each card offers Accept, Reject and Next change');
      const target = blocks.find(b => b.line === stageInfo.line);
      assert.equal(target.chip, `Block ${stageInfo.blockIndex}/${stageInfo.blockCount}`, 'Card names the block it decides');
      assert.ok(target.box.height >= 20 && target.box.width >= 180, `Card is a readable box: ${JSON.stringify(target.box)}`);
      assert.notEqual(target.box.radius, '0px', 'Card keeps rounded corners');
      assert.notEqual(target.box.border, '0px', 'Card keeps its border');
      const layout = await evaluate(`Array.from(document.querySelectorAll('.monaco-diff-editor')).map(e=>({classes:e.className,originalWidth:e.querySelector('.editor.original')?.getBoundingClientRect().width,modifiedWidth:e.querySelector('.editor.modified')?.getBoundingClientRect().width}))`);
      assert.ok(layout.length, 'Native diff editors rendered');
      console.log(`NATIVE_DIFF_LAYOUT ${JSON.stringify(layout)}`);
      const layoutShot = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(process.cwd(), 'artifacts/inline-layout.png'), Buffer.from(layoutShot.data, 'base64'));
      // The native inline renderer retains a narrow original-side gutter.
      assert.ok(layout.every(e => e.modifiedWidth > 0 && e.originalWidth < e.modifiedWidth / 10), 'Every native diff has one inline code pane');
      assert.notEqual(stageInfo.cursorLine, stageInfo.line, 'Cursor stays outside the target block');
      const button = target.buttons.find(item => item.action === action);
      const frame = await evaluate(`(()=>{const f=Array.from(document.querySelectorAll('iframe')).find(f=>f.src===${JSON.stringify(target.url)});return f?.getBoundingClientRect().toJSON();})()`);
      assert.ok(frame?.height, 'Card occupies its own editor row');
      const point = { x: frame.x + button.rect.x + button.rect.width / 2, y: frame.y + button.rect.y + button.rect.height / 2 };
      assert.ok(point.y > 60 && point.y < 850, 'Target card button is on screen');
      const navigation = await evaluate(`(${menu}).map(e=>e.getBoundingClientRect().toJSON())`);
      assert.ok(navigation.every(r=>point.x < r.x || point.x > r.right || point.y < r.y || point.y > r.bottom), 'Block action does not overlap floating navigation');
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(process.cwd(), 'artifacts', `${stage}.png`), Buffer.from(shot.data, 'base64'));
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      await writeFile(path.join(runtime, `${stage}.done`), 'clicked');
      const result = await until(async () => JSON.parse(await readFile(path.join(runtime, `${stage}-result.json`), 'utf8')), `${action} byte verification`);
      assert.equal(result.success, true); assert.equal(result.cursorWasOutsideBlock, true);
      console.log(`BLOCK_BUTTON_${stage.toUpperCase()} ${JSON.stringify({ ...result, blockCount: blocks.length, targetLine: stageInfo.line, inline: true, layout })}`);
    }
  } finally {
    ws.close();
    // Release the owned test host even when a visual assertion fails.
    for (const stage of ['badge', 'single', 'multi', 'hunkAccept', 'hunkRevert']) await writeFile(path.join(runtime, `${stage}.done`), 'finished');
  }
}
