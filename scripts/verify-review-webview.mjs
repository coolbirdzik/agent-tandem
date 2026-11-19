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
  const findTarget = async selector => until(async () => {
    const { targetInfos } = await call('Target.getTargets');
    for (const info of targetInfos.filter(info => info.type === 'iframe')) {
      if (!sessions.has(info.targetId)) sessions.set(info.targetId, (await call('Target.attachToTarget', { targetId: info.targetId, flatten: true })).sessionId);
      const session = sessions.get(info.targetId);
      const result = await call('Runtime.evaluate', { expression: `!!(document.querySelector('#active-frame')?.contentDocument||document).querySelector(${JSON.stringify(selector)})`, returnByValue: true }, session).catch(() => undefined);
      if (result?.result?.value) return session;
    }
  }, `Webview ${selector}`);
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
    await stage('menu');
    target = await findTarget('#review-more');
    await click('#review-more');
    const labels = await until(async () => {
      const { result } = await call('Runtime.evaluate', {
        expression: `(() => {
          const rows = [...document.querySelectorAll('.context-view .monaco-menu .action-item')];
          return rows.length && rows.map(row => row.querySelector('[role="menuitem"]')?.textContent.trim() ?? 'separator');
        })()`, returnByValue: true,
      });
      return result.value;
    }, 'VS Code review menu');
    assert.deepEqual(labels, ['Refresh', 'Native diff', 'separator', 'Open Workspace Changes', 'Open Conversation']);
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await done('menu');
    await stage('agent-list');
    const changesReviewTarget = target; target = await findTarget('#screen-changes');
    await until(() => evaluate(`const p=d.querySelector('#screen-changes');return p&&!p.hidden&&p.getBoundingClientRect().height>0&&p.querySelectorAll('.review-file').length===${process.argv.includes('--readme') ? 9 : 8};`), 'Extension sidebar shows workspace changes');
    const agentList = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(process.cwd(), 'artifacts', `review-agent-changes-${edition}.png`), Buffer.from(agentList.data, 'base64'));
    target = changesReviewTarget; await done('agent-list');
    await stage('conversation-link');
    const reviewTarget = target; target = await findTarget('.message-restore[data-checkpoint-available="true"]');
    const restore = await until(() => evaluate(`const b=d.querySelector('.message-restore[data-checkpoint-available="true"]');if(!b||b.disabled)return;return {text:b.textContent,height:b.getBoundingClientRect().height,background:d.defaultView.getComputedStyle(b).backgroundColor};`), 'Visible Restore code action');
    assert.equal(restore.text, 'Restore code'); assert.ok(restore.height>=28); assert.notEqual(restore.background,'rgba(0, 0, 0, 0)');
    await click('.message-restore[data-checkpoint-available="true"]');
    await until(() => evaluate(`return d.querySelector('#checkpoint-preview')?.textContent.includes('Restore checkpoint');`), 'Restore previews affected files');
    const conversationShot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(process.cwd(), 'artifacts', `review-conversation-restore-${edition}.png`), Buffer.from(conversationShot.data, 'base64'));
    target = reviewTarget; await done('conversation-link');
    await stage('dark');
    await until(() => evaluate(`return d.querySelector('#diff')?.dataset.diffReady==='true';`), 'Monaco worker computes the inline diff');
    const compactToolbar = await evaluate(`return {height:d.querySelector('.review-header').getBoundingClientRect().height,rows:d.querySelectorAll('body>.review-header,body>.review-context,body>.file-toolbar').length};`);
    assert.equal(compactToolbar.rows, 1, 'Review uses one consolidated toolbar');
    assert.ok(compactToolbar.height <= 56, 'Wide review toolbar stays within one compact row');
    const syntax = await until(() => evaluate(`const lines=[...d.querySelectorAll('.view-line')];const colors=[...new Set(lines.flatMap(line=>[...line.querySelectorAll('span')].filter(s=>s.textContent.trim()).map(s=>d.defaultView.getComputedStyle(s).color)))];return colors.length>1?{language:d.querySelector('#diff').dataset.language,colors}:undefined;`), 'syntax-highlighted source');
    assert.equal(syntax.language, 'typescript');
    await click('.next-block');
    await until(() => evaluate(`const block=d.querySelectorAll('.diff-block')[1],rect=block?.getBoundingClientRect();return d.querySelector('#block-count').textContent==='2 / 2'&&rect.top>=0&&rect.bottom<d.defaultView.innerHeight;`), 'Next change reveals its inline toolbar');
    await click('#previous');
    const colors = await until(() => evaluate(`const buttons=[...d.querySelectorAll('.diff-block.current .block-actions button')];if(!buttons.length||buttons.some(b=>!b.getBoundingClientRect().height))return;return buttons.map(b=>({text:b.textContent,background:d.defaultView.getComputedStyle(b).backgroundColor,color:d.defaultView.getComputedStyle(b).color,rect:b.getBoundingClientRect().toJSON()}));`), 'Current block toolbar is laid out');
    assert.ok(colors.some(button => /Accept/.test(button.text))); assert.ok(colors.some(button => /Revert/.test(button.text)));
    assert.equal(colors[0].background, 'rgba(0, 0, 0, 0)', 'Revert uses the sidebar’s quiet style');
    assert.notEqual(colors[1].background, colors[0].background, 'Accept uses the sidebar’s primary style');
    assert.equal(colors[2].background, 'rgba(0, 0, 0, 0)', 'Navigation stays neutral');
    assert.equal(colors[3].background, colors[2].background, 'Both navigation controls share the same style');
    assert.equal(await evaluate(`return d.querySelector('.decision-actions')?.getAttribute('role');`), 'group');
    assert.equal(await evaluate(`return d.querySelector('.block-navigation')?.querySelectorAll('button').length;`), 2);
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
    const compactLayout = async (minWidth, maxWidth, pickerIcon, picker) => {
      const layout = await until(() => evaluate(`
        const width=d.defaultView.innerWidth, block=d.querySelector('.diff-block');
        if(!block||width<=${minWidth}||width>${maxWidth})return;
        const visible=node=>!!node.getClientRects().length;
        const centers=nodes=>[...nodes].filter(visible).map(node=>{
          const {top,left,right,height}=node.getBoundingClientRect();
          return {center:top+height/2,left,right};
        });
        return {width, picker:visible(d.querySelector('.file-picker')), pickerIcon:visible(d.querySelector('.file-picker>.codicon')),
          labels:[...d.querySelectorAll('.file-toolbar .action-label,.diff-block .action-label')].some(visible),
          header:centers(d.querySelectorAll('.file-toolbar button,.file-toolbar #block-count')),
          change:centers(block.querySelectorAll('.block-meta,button'))};
      `), 'narrow Webview layout');
      assert.equal(layout.picker, picker);
      assert.equal(layout.pickerIcon, pickerIcon);
      assert.equal(layout.labels, false, 'Narrow action buttons show only icons');
      assert.equal(layout.header.length, picker ? 9 : 8);
      assert.equal(layout.change.length, 5);
      for (const row of [layout.header, layout.change]) {
        assert.ok(row.every(item => Math.abs(item.center - row[0].center) <= 1), 'Toolbar controls stay on one row');
        assert.ok(row.every(item => item.left >= 0 && item.right <= layout.width), `Toolbar controls fit at ${layout.width}px`);
      }
    };
    await compactLayout(480, 640, true, true);
    const narrow = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(process.cwd(), 'artifacts', `review-webview-${edition}-narrow.png`), Buffer.from(narrow.data, 'base64'));
    await call('Emulation.setDeviceMetricsOverride', { width: 510, height: 900, deviceScaleFactor: 1, mobile: false });
    await compactLayout(360, 480, false, true);
    await click('#files-trigger');
    assert.equal(await evaluate(`return d.querySelector('#files-options').hidden;`), false);
    await call('Emulation.setDeviceMetricsOverride', { width: 345, height: 900, deviceScaleFactor: 1, mobile: false });
    await compactLayout(0, 360, false, false);
    await until(() => evaluate(`return d.querySelector('#files-options').hidden;`), 'Hiding the picker closes its menu');
    await call('Emulation.clearDeviceMetricsOverride'); await done('narrow');
    await stage('accept');
    await click('.diff-block .next-block');
    const markerPosition = `const line=[...d.querySelectorAll('.editor.modified .view-line')].find(line=>line.textContent.replace(/\\s/g,'').includes('reviewviewportanchor'));const top=line?.getBoundingClientRect().top;if(top>=d.querySelector('#diff').getBoundingClientRect().top&&top<d.defaultView.innerHeight)return top;`;
    const markerTop = process.argv.includes('--readme') ? undefined : await until(() => evaluate(markerPosition), 'Source line below the first block is visible');
    await evaluate(`d.__staleReject=d.querySelector('.reject').onclick;d.__reviewEditor=d.querySelector('.editor.modified');return true;`);
    await click('.diff-block .accept');
    await until(() => evaluate(`return d.querySelector('#diff')?.dataset.diffReady==='true'&&d.querySelector('#block-count')?.textContent==='1 / 1'&&!d.querySelector('.diff-block .reject')?.disabled;`), 'Accepted block disappears from Monaco');
    assert.equal(await evaluate(`return d.querySelector('.editor.modified')===d.__reviewEditor;`), true, 'Accept keeps the current Monaco editor mounted');
    if (markerTop !== undefined) {
      const updatedTop = await until(() => evaluate(markerPosition), 'Source line stays visible after Accept');
      assert.ok(Math.abs(updatedTop - markerTop) <= 2, `Accept keeps the source line anchored (${markerTop} -> ${updatedTop})`);
    }
    await done('accept');
    await stage('stale'); await evaluate(`d.__staleReject();return true;`);
    await until(() => evaluate(`return d.querySelector('#error')?.textContent.includes('Changes updated');`), 'stale block error'); await done('stale');
    await stage('reject'); await click('.diff-block .reject'); await done('reject');
    await stage('undo');
    const undoReviewTarget = target; target = await findTarget('[data-focus-key="undo-revert"]');
    await click('[data-focus-key="undo-revert"]'); target = undoReviewTarget; await done('undo');
    await stage('external');
    await until(() => evaluate(`return d.querySelector('#files')?.value==='01-source.ts';`), 'Reopened source diff before checking newer disk edits');
    await click('.diff-block .reject');
    await until(() => evaluate(`return d.querySelector('#error')?.textContent.includes('changed after the agent');`), 'newer saved edit error'); await done('external');
    await stage('dirty'); await click('.diff-block .reject');
    await until(() => evaluate(`return d.querySelector('#error')?.textContent.includes('unsaved');`), 'readable dirty-buffer error'); await done('dirty');
    await stage('navigation'); await click('#next');
    await until(() => evaluate(`return d.querySelector('#files')?.value==='02-added.ts';`), 'next file');
    await until(() => evaluate(`return d.querySelector('#diff')?.dataset.diffReady==='true';`), 'large added file diff');
    await evaluate(`d.querySelector('.editor.modified .native-edit-context,.editor.modified textarea.inputarea').focus();return true;`);
    const findKey = { key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: process.platform === 'darwin' ? 4 : 2 };
    await call('Input.dispatchKeyEvent', { type: 'keyDown', ...findKey });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', ...findKey });
    await until(() => evaluate(`return !!d.activeElement?.closest('.find-widget');`), 'Find shortcut opens Monaco search');
    await call('Input.insertText', { text: 'tailMarker' });
    await until(() => evaluate(`return [...d.querySelectorAll('.view-line')].some(line=>line.textContent.includes('tailMarker')&&line.getBoundingClientRect().height>0);`), 'search reaches source beyond the first viewport');
    assert.equal(await evaluate(`return !!d.querySelector('#diff img');`), false, 'Source containing HTML stays inert');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await click('#next'); await until(() => evaluate(`return d.querySelector('#files')?.value==='03-deleted.ts';`), 'deleted file'); await done('navigation');
    await stage('binary'); await evaluate(`const select=d.querySelector('#files'); select.value='04-binary.dat';select.dispatchEvent(new d.defaultView.Event('change',{bubbles:true}));return true;`);
    await until(() => evaluate(`return d.querySelector('.file-review')?.textContent.includes('Binary');`), 'binary whole-file actions'); await done('binary');
    const selectImage = async file => {
      await evaluate(`const select=d.querySelector('#files');select.value=${JSON.stringify(file)};select.dispatchEvent(new d.defaultView.Event('change',{bubbles:true}));return true;`);
      await until(() => evaluate(`return d.querySelector('.file-review h2')?.textContent===${JSON.stringify(file)}&&d.querySelector('#diff')?.getAttribute('aria-busy')==='false';`), `Rendered ${file} snapshots`);
    };
    const decodedImages = count => until(() => evaluate(`const images=[...d.querySelectorAll('.image-comparison img')];return images.length===${count}&&images.every(i=>i.complete&&i.naturalWidth>0);`), `${count} decoded snapshot images`);
    await stage('image'); await selectImage('05-image.png'); await decodedImages(2);
    const imageSizes = await evaluate(`return [...d.querySelectorAll('.image-comparison img')].map(i=>[i.naturalWidth,i.naturalHeight]);`);
    assert.notDeepEqual(imageSizes[0], imageSizes[1], 'Old and new image bytes decode independently');
    const imageScreenshot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(process.cwd(), 'artifacts', `review-images-${edition}.png`), Buffer.from(imageScreenshot.data, 'base64')); await done('image');
    await stage('image-narrow'); await call('Emulation.setDeviceMetricsOverride', { width: 620, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(() => evaluate(`const panes=[...d.querySelectorAll('.image-side')].map(p=>p.getBoundingClientRect());return d.defaultView.innerWidth<=650&&panes[1]?.top>=panes[0].bottom&&panes.every(p=>p.left>=0&&p.right<=d.defaultView.innerWidth);`), 'Narrow image layout stacks both versions without clipping');
    await call('Emulation.clearDeviceMetricsOverride'); await done('image-narrow');
    await stage('added-image'); await selectImage('06-added.svg'); await decodedImages(1);
    assert.match(await evaluate(`return d.querySelector('.image-side').textContent;`), /file added/); await done('added-image');
    await stage('deleted-image'); await selectImage('07-deleted.svg'); await decodedImages(1);
    assert.match(await evaluate(`return d.querySelectorAll('.image-side')[1].textContent;`), /file deleted/); await done('deleted-image');
    await stage('broken-image'); await selectImage('08-broken.png'); await decodedImages(1);
    await until(() => evaluate(`return d.querySelectorAll('.image-side')[1]?.textContent.includes('could not be displayed');`), 'Decode failure retains the other image and file actions'); await done('broken-image');
    if (process.argv.includes('--readme')) {
      await stage('readme-image'); await selectImage('09-cover.svg'); await decodedImages(2);
      const screenshot = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(process.cwd(), 'artifacts', `readme-image-diff-${edition}.png`), Buffer.from(screenshot.data, 'base64')); await done('readme-image');
    }
    await stage('native-image');
    target = await findTarget('#images .image-comparison'); await decodedImages(2); await done('native-image');
    await stage('image-to-code'); await click('[data-action="previous"]'); await done('image-to-code');
    await stage('code-to-image'); target = await findTarget('#images .image-comparison'); await decodedImages(2); await done('code-to-image');
    await stage('native'); target = await findTarget('#files');
    await until(() => evaluate(`return d.querySelector('#files')?.value==='04-binary.dat';`), 'Return to binary review');
    await click('.file-review .block-navigation button'); await done('native');
    for (const name of ['saved-image', 'cumulative-image']) {
      await stage(name); target = await findTarget('#images .image-comparison'); await decodedImages(2);
      assert.deepEqual(await evaluate(`return [...d.querySelectorAll('.image-comparison img')].map(i=>[i.naturalWidth,i.naturalHeight]);`), imageSizes);
      await done(name);
    }
    await stage('saved-deleted-image'); target = await findTarget('#images .image-comparison'); await decodedImages(1);
    assert.match(await evaluate(`return d.querySelectorAll('.image-side')[1].textContent;`), /file deleted/); await done('saved-deleted-image');
    await stage('edit-file'); target = await findTarget('#accept-all-file');
    await until(() => evaluate(`return d.querySelector('#files')?.value==='01-source.ts'&&d.querySelector('#diff')?.dataset.diffReady==='true';`), 'Editable source in the review diff');
    await evaluate(`d.querySelector('.editor.modified .native-edit-context,.editor.modified textarea.inputarea').focus();return true;`);
    await call('Input.insertText', { text: '/* saved review draft */' });
    await until(() => evaluate(`const save=d.querySelector('#save-edit');return !save.hidden&&!save.disabled;`), 'Typing in the Monaco diff exposes an unsaved draft');
    const saveKey = { key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: findKey.modifiers };
    await call('Input.dispatchKeyEvent', { type: 'keyDown', ...saveKey });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', ...saveKey });
    await until(() => evaluate(`return d.querySelector('#save-edit').hidden&&!d.querySelector('#accept-all-file').disabled;`), 'Saving the draft restores the review actions');
    await done('edit-file');
    await stage('accept-file-all');
    await until(() => evaluate(`return d.querySelector('#files')?.value==='01-source.ts'&&!d.querySelector('#accept-all-file')?.disabled;`), 'Accept all is ready for the selected code file');
    await click('#accept-all-file'); await done('accept-file-all');
    await stage('complete');
  } finally { ws.close(); for (const name of ['menu', 'agent-list', 'conversation-link', 'dark', 'light', 'narrow', 'accept', 'stale', 'reject', 'undo', 'external', 'dirty', 'navigation', 'binary', 'image', 'image-narrow', 'added-image', 'deleted-image', 'broken-image', 'readme-image', 'native-image', 'image-to-code', 'code-to-image', 'native', 'saved-image', 'cumulative-image', 'saved-deleted-image', 'edit-file', 'accept-file-all']) await done(name); }
}
