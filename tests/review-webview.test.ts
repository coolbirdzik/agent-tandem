// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewWebviewHtml } from '../src/host/review-webview-html';
import { reviewHunks } from '../src/core/review-hunks';
import type { ReviewEditorState } from '../src/core/review-webview';

// Monaco rendering is exercised in the real VS Code host suite; keep bridge tests
// focused on revision-bound actions and complete model data at this boundary.
const editors = vi.hoisted(() => [] as Array<{ file: ReviewEditorState['file']; focus: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; scrollTop: number; dirty: boolean; text: string; setEditable: ReturnType<typeof vi.fn>; onEdit: () => void }>);
vi.mock('../src/review-monaco', () => ({ ReviewCodeEditor: class {
  focus = vi.fn(); dispose = vi.fn(); scrollTop = 0;
  dirty = false; text = ''; setEditable = vi.fn();
  markSaved() { this.dirty = false; }
  discard() { this.dirty = false; }
  update = vi.fn((file: ReviewEditorState['file'], sections: HTMLElement[]) => {
    this.file = file;
    this.container.replaceChildren(...sections);
  });
  constructor(private container: HTMLElement, public file: ReviewEditorState['file'], sections: HTMLElement[], _select: unknown, _scroll: unknown, public onEdit: () => void) {
    container.append(...sections); editors.push(this);
  }
} }));
const postMessage = vi.fn(), listeners: Array<[string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = [];
const before = 'first\n' + 'same\n'.repeat(10) + 'last\n';
const after = '<img src=x onerror=alert(1)>\n' + 'same\n'.repeat(10) + 'changed\n';
const fixture = (): ReviewEditorState => ({ project: '/project', revision: 'r1', busy: false,
  files: [{ path: 'first.ts', kind: 'modified' }, { path: 'second.ts', kind: 'added' }],
  file: { path: 'first.ts', kind: 'modified', binary: false, beforeSize: before.length, afterSize: after.length, beforeText: before, afterText: after, hunks: reviewHunks(before, after) } });
const render = (state: ReviewEditorState) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state } }));
beforeEach(async () => {
  vi.resetModules(); postMessage.mockClear(); editors.length = 0;
  document.write(reviewWebviewHtml({ script: 'review.js', style: 'style.css', icons: 'icons.css', monacoStyle: 'monaco.css', worker: 'worker.js', nonce: 'nonce', cspSource: 'https://resource.invalid' }).replace(/<link[^>]+>/g, '').replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''));
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage, getState: () => undefined, setState: vi.fn() }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => { listeners.push([type, listener, options]); add(type, listener, options); });
  await import('../src/review-webview.js'); render(fixture());
});
afterEach(() => { for (const [type, listener, options] of listeners.splice(0)) window.removeEventListener(type, listener, options); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
describe('Shared Webview review', () => {
  it('selects a changed file from the shared picker and keeps review shortcuts out of the list', () => {
    const trigger = document.querySelector<HTMLButtonElement>('#files-trigger')!, menu = document.getElementById('files-options')!;
    expect(trigger.textContent).toBe('first.ts');
    trigger.click(); expect(document.activeElement).toBe(menu);
    postMessage.mockClear();
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
    expect(postMessage).not.toHaveBeenCalled();
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'selectFile', revision: 'r1', file: 'second.ts', navigation: 'first' });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.textContent).toBe('second.ts');
    render({ ...fixture(), revision: 'r2', busy: true });
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toBe('first.ts');
  });
  it('saves a draft against the latest matching revision and retains it when a save fails', () => {
    const state = fixture();
    state.file = { ...state.file!, editable: true, after: 'snapshot' };
    render(state);
    const editor = editors.at(-1)!;
    expect(editor.setEditable).toHaveBeenLastCalledWith(true);
    editor.dirty = true; editor.text = 'edited text'; editor.onEdit();
    expect(document.querySelector<HTMLButtonElement>('#files-trigger')!.disabled).toBe(true);
    render({ ...state, revision: 'r2' });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'saveEdit', revision: 'r2', file: 'first.ts', after: 'snapshot', text: 'edited text' });
    expect(editor.setEditable).toHaveBeenLastCalledWith(false);
    render({ ...state, revision: 'r2', error: 'File has unsaved edits' });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'editResult', saved: false } }));
    expect(editor.dirty).toBe(true);
    expect(document.getElementById('error')!.textContent).toBe('File has unsaved edits');
    document.getElementById('save-edit')!.click();
    render({ ...state, revision: 'r3', file: { ...state.file, after: 'edited', afterText: editor.text } });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'editResult', saved: true } }));
    expect(editor.dirty).toBe(false);
    expect(editor.file?.afterText).toBe('edited text');
    expect(document.getElementById('save-edit')!.hidden).toBe(true);
  });
  it('holds a draft when its snapshot changes and loads the newer diff after discarding', () => {
    const state = fixture();
    state.file = { ...state.file!, editable: true, after: 'snapshot' };
    render(state);
    const editor = editors.at(-1)!;
    editor.dirty = true; editor.onEdit();
    render({ ...state, revision: 'r2', file: { ...state.file, after: 'newer' } });
    expect(editor.file?.after).toBe('snapshot');
    expect(document.querySelector<HTMLButtonElement>('#save-edit')!.disabled).toBe(true);
    document.getElementById('discard-edit')!.click();
    expect(editor.file?.after).toBe('newer');
    expect(document.getElementById('save-edit')!.hidden).toBe(true);
  });
  it('accepts all blocks in only the displayed file and rejects a stale captured handler', () => {
    const button = document.querySelector<HTMLButtonElement>('#accept-all-file')!, oldHandler = button.onclick!;
    button.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'accept', revision: 'r1', file: 'first.ts' });
    expect(button.disabled).toBe(true);
    render({ ...fixture(), revision: 'r2', file: { ...fixture().file!, path: 'second.ts' } });
    postMessage.mockClear(); Reflect.apply(oldHandler, button, [new MouseEvent('click')]); expect(postMessage).not.toHaveBeenCalled();
    button.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'accept', revision: 'r2', file: 'second.ts' });
    render({ files: [], busy: false }); expect(button.hidden).toBe(true); expect(button.disabled).toBe(true);
  });
  it('rejects all blocks in only the displayed file through the host confirmation and ignores stale handlers', () => {
    const button = document.querySelector<HTMLButtonElement>('#reject-all-file')!, oldHandler = button.onclick!;
    expect(button.hidden).toBe(false);
    button.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'reject', revision: 'r1', file: 'first.ts' });
    expect(button.disabled).toBe(true); expect(document.querySelector<HTMLButtonElement>('#accept-all-file')!.disabled).toBe(true);
    render({ ...fixture(), revision: 'r2', file: { ...fixture().file!, path: 'second.ts' } });
    postMessage.mockClear(); Reflect.apply(oldHandler, button, [new MouseEvent('click')]); expect(postMessage).not.toHaveBeenCalled();
    button.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'reject', revision: 'r2', file: 'second.ts' });
    render({ files: [], busy: false }); expect(button.hidden).toBe(true);
  });
  it('opens the native menu with the current file and conversation context', () => {
    render({ ...fixture(), context: { group: 'Codex:agent', title: 'Update artwork', conversation: { key: 'Codex:agent', id: 'agent', provider: 'Codex', title: 'Update artwork' }, canOpenConversation: true, files: [fixture().files[1]!] } });
    const more = document.querySelector<HTMLButtonElement>('#review-more')!;
    const contextMenu = vi.fn();
    more.addEventListener('contextmenu', contextMenu);
    more.click();
    expect(contextMenu).toHaveBeenCalledOnce();
    expect(JSON.parse(more.dataset.vscodeContext!)).toMatchObject({
      webviewSection: 'reviewActions', preventDefaultContextMenuItems: true, reviewMenuEnabled: true,
      reviewMenuHasFile: true, reviewMenuHasConversation: true, project: '/project', revision: 'r1', file: 'first.ts',
    });
  });
  it('disables the conversation action for shared edits and the menu while review is busy', () => {
    const context = { group: 'shared', title: 'Shared workspace changes', files: fixture().files };
    const more = document.querySelector<HTMLButtonElement>('#review-more')!;
    render({ ...fixture(), context });
    expect(JSON.parse(more.dataset.vscodeContext!)).toMatchObject({ reviewMenuEnabled: true, reviewMenuHasConversation: false });
    render({ ...fixture(), context, busy: true });
    expect(more.disabled).toBe(true);
  });
  it('shows before/after image snapshots and binds whole-file decisions to the revision', () => {
    render({ ...fixture(), revision: 'image', file: { ...fixture().file!, binary: true, hunks: [], notice: 'Image snapshots', images: { before: { size: 2, src: 'data:image/png;base64,AAE=' }, after: { size: 2, src: 'data:image/png;base64,AAI=' } } } });
    const images = [...document.querySelectorAll('.image-comparison img')];
    expect(images.map(image => image.getAttribute('src'))).toEqual(['data:image/png;base64,AAE=', 'data:image/png;base64,AAI=']);
    expect(document.querySelectorAll('.diff-block')).toHaveLength(0);
    document.querySelector<HTMLButtonElement>('.reject')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'reject', revision: 'image', file: 'first.ts' });
  });
  it('shows missing image sides and decode failures without hiding the other side or file actions', () => {
    render({ ...fixture(), revision: 'added-image', file: { ...fixture().file!, hunks: [], notice: 'Image snapshots', images: { before: { size: 0, missing: true }, after: { size: 2, src: 'data:image/png;base64,AAI=' } } } });
    expect(document.querySelector('.image-side')!.textContent).toContain('file added');
    document.querySelector('img')!.dispatchEvent(new Event('error'));
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(document.querySelector('.image-comparison')!.textContent).toContain('could not be displayed');
    expect(document.querySelector<HTMLButtonElement>('.accept')!.disabled).toBe(false);
  });
  it('renders code as text and binds an action to its own block, independently of the active block', () => {
    expect(document.querySelectorAll('.diff-block')).toHaveLength(2);
    expect(editors.at(-1)!.file!.beforeText).toBe(before);
    expect(editors.at(-1)!.file!.afterText).toBe(after);
    expect(document.querySelector('img')).toBeNull();
    document.querySelectorAll<HTMLButtonElement>('.reject')[1]!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'reject', file: 'first.ts', revision: 'r1', hunk: fixture().file!.hunks[1]!.id });
    expect(document.querySelector<HTMLButtonElement>('.accept')!.disabled).toBe(true);
  });
  it('navigates blocks, crosses file boundaries in both directions, and sends no decision on navigation', () => {
    document.querySelector<HTMLButtonElement>('.next-block')!.click();
    expect(document.getElementById('block-count')!.textContent).toBe('2 / 2');
    document.getElementById('next')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'selectFile', revision: 'r1', file: 'second.ts', navigation: 'first' });
    document.getElementById('previous')!.click(); document.getElementById('previous')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'selectFile', revision: 'r1', file: 'second.ts', navigation: 'last' });
    expect(postMessage.mock.calls.every(([message]) => !['accept', 'reject'].includes(message.type))).toBe(true);
  });
  it('skips remaining blocks with Next file and wraps in both directions with file shortcuts', () => {
    document.getElementById('next-file')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'selectFile', revision: 'r1', file: 'second.ts', navigation: 'first' });
    expect(document.getElementById('block-count')!.textContent).toBe('1 / 2');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', altKey: true, cancelable: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'selectFile', revision: 'r1', file: 'second.ts', navigation: 'first' });
    render({ ...fixture(), revision: 'one', files: [fixture().files[0]!] });
    expect(document.querySelector<HTMLButtonElement>('#next-file')!.disabled).toBe(true);
    document.getElementById('previous')!.click();
    expect(document.getElementById('block-count')!.textContent).toBe('2 / 2');
    document.getElementById('next')!.click();
    expect(document.getElementById('block-count')!.textContent).toBe('1 / 2');
  });
  it('keyboard decisions follow focus when tabbing into another block', () => {
    document.querySelectorAll<HTMLButtonElement>('.reject')[1]!.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, key: 'n', cancelable: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'reject', file: 'first.ts', revision: 'r1', hunk: fixture().file!.hunks[1]!.id });
  });
  it('preserves a selected block across passive busy updates and uses only fresh revision actions', () => {
    document.getElementById('next')!.click(); render({ ...fixture(), busy: true });
    expect(document.getElementById('block-count')!.textContent).toBe('2 / 2');
    expect(document.querySelector<HTMLButtonElement>('.reject')!.disabled).toBe(true);
    render({ ...fixture(), revision: 'r2' });
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, key: 'y', cancelable: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'accept', file: 'first.ts', revision: 'r2', hunk: fixture().file!.hunks[1]!.id });
  });
  it('keeps the diff editor when a new revision leaves the displayed file unchanged', () => {
    const editor = editors.at(-1)!, block = document.querySelector('.diff-block');
    render({ ...fixture(), revision: 'r2' });
    expect(editor.dispose).not.toHaveBeenCalled(); expect(editors.at(-1)).toBe(editor);
    expect(document.querySelector('.diff-block')).toBe(block);
    document.querySelector<HTMLButtonElement>('.accept')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'accept', file: 'first.ts', revision: 'r2', hunk: fixture().file!.hunks[0]!.id });
  });
  it('keeps delayed button handlers bound to the displayed file and revision even if another file has identical hunks', () => {
    const old = document.querySelector<HTMLButtonElement>('.reject')!.onclick!;
    render({ ...fixture(), revision: 'new-revision', file: { ...fixture().file!, path: 'second.ts' } });
    old.call(document.querySelector<HTMLButtonElement>('.reject')!, new PointerEvent('click'));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'reject', revision: 'r1', file: 'first.ts', hunk: fixture().file!.hunks[0]!.id });
  });
  it('updates the entire file in the existing editor without truncating source', () => {
    const original = 'first\n' + 'surrounding source\n'.repeat(12000) + 'last\n';
    const modified = original.replace('first', 'updated first').replace('last', 'updated last');
    const previous = editors.at(-1)!;
    render({ ...fixture(), revision: 'full-context', file: { ...fixture().file!, beforeText: original, afterText: modified, hunks: reviewHunks(original, modified) } });
    expect(previous.dispose).not.toHaveBeenCalled();
    expect(previous.update).toHaveBeenCalledOnce();
    expect(editors.at(-1)).toBe(previous);
    expect(editors.at(-1)!.file!.beforeText).toBe(original);
    expect(editors.at(-1)!.file!.afterText).toBe(modified);
    document.getElementById('next')!.click();
    expect(editors.at(-1)!.focus).toHaveBeenLastCalledWith(1);
  });
  it('keeps the editor and selects a remaining block after a review decision', () => {
    const editor = editors.at(-1)!;
    document.querySelector<HTMLButtonElement>('.accept')!.click();
    const baseline = before.replace('first', after.split('\n')[0]!);
    const remaining = reviewHunks(baseline, after);
    render({ ...fixture(), revision: 'accepted', file: { ...fixture().file!, beforeText: baseline, hunks: remaining } });
    expect(editors.at(-1)).toBe(editor);
    expect(editor.dispose).not.toHaveBeenCalled();
    expect(document.getElementById('block-count')!.textContent).toBe('1 / 1');
    expect(document.querySelector('.diff-block.current')?.getAttribute('data-hunk')).toBe(remaining[0]!.id);
    document.querySelector<HTMLButtonElement>('.reject')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'reject', revision: 'accepted', file: 'first.ts', hunk: remaining[0]!.id });
  });
  it('shows whole-file decisions for binary files and keeps workspace changes available when review is empty', () => {
    render({ ...fixture(), revision: 'binary', file: { ...fixture().file!, hunks: [], beforeText: undefined, afterText: undefined, binary: true, notice: 'Binary file. Review the whole file.' } });
    expect(document.querySelectorAll('.diff-block')).toHaveLength(0);
    document.querySelector<HTMLButtonElement>('.accept')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'accept', revision: 'binary', file: 'first.ts' });
    render({ project: '/project', revision: 'done', busy: false, files: [] });
    expect(JSON.parse(document.querySelector<HTMLButtonElement>('#review-more')!.dataset.vscodeContext!))
      .toMatchObject({ reviewMenuEnabled: true, reviewMenuHasFile: false, reviewMenuHasConversation: false });
  });
});
