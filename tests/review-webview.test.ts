// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewWebviewHtml } from '../src/host/review-webview-html';
import { reviewHunks } from '../src/core/review-hunks';
import type { ReviewEditorState } from '../src/core/review-webview';

// Monaco rendering is exercised in the real VS Code host suite; keep bridge tests
// focused on revision-bound actions and complete model data at this boundary.
const editors = vi.hoisted(() => [] as Array<{ file: ReviewEditorState['file']; focus: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; scrollTop: number }>);
vi.mock('../src/review-monaco', () => ({ ReviewCodeEditor: class {
  focus = vi.fn(); dispose = vi.fn(); scrollTop = 0;
  constructor(container: HTMLElement, public file: ReviewEditorState['file'], sections: HTMLElement[]) {
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
  it('opens the agent file list and binds file/conversation shortcuts to the current review', () => {
    render({ ...fixture(), context: { group: 'Codex:agent', title: 'Update artwork', conversation: { key: 'Codex:agent', id: 'agent', provider: 'Codex', title: 'Update artwork' }, canOpenConversation: true, files: [fixture().files[1]!] } });
    document.getElementById('agent-changes')!.click();
    expect(document.getElementById('agent-changes-panel')!.hidden).toBe(false);
    expect(document.getElementById('agent-changes')!.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('.agent-change-file')).toHaveLength(1);
    document.querySelector<HTMLButtonElement>('.agent-change-file')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'selectAgentFile', revision: 'r1', file: 'first.ts', target: 'second.ts' });
    document.getElementById('open-conversation')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'conversation', revision: 'r1', file: 'first.ts' });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(document.getElementById('agent-changes-panel')!.hidden).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('agent-changes'));
  });
  it('disables conversation navigation for shared edits and while review is busy', () => {
    const context = { group: 'shared', title: 'Shared workspace changes', files: fixture().files };
    render({ ...fixture(), context });
    expect(document.querySelector<HTMLButtonElement>('#open-conversation')!.disabled).toBe(true);
    expect(document.getElementById('agent-changes-label')!.textContent).toBe('Workspace changes');
    document.getElementById('agent-changes')!.click(); render({ ...fixture(), context, busy: true });
    expect(document.querySelector<HTMLButtonElement>('.agent-change-file')!.disabled).toBe(true);
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
    render({ ...fixture(), revision: 'r2', undo: { id: 'u1', createdAt: 1, files: ['first.ts'] } });
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, key: 'y', cancelable: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'accept', file: 'first.ts', revision: 'r2', hunk: fixture().file!.hunks[1]!.id });
    expect(document.getElementById('undo')!.hidden).toBe(false);
  });
  it('keeps delayed button handlers bound to the displayed file and revision even if another file has identical hunks', () => {
    const old = document.querySelector<HTMLButtonElement>('.reject')!.onclick!;
    render({ ...fixture(), revision: 'new-revision', file: { ...fixture().file!, path: 'second.ts' } });
    old.call(document.querySelector<HTMLButtonElement>('.reject')!, new PointerEvent('click'));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'reject', revision: 'r1', file: 'first.ts', hunk: fixture().file!.hunks[0]!.id });
  });
  it('passes the entire file and all changed lines to Monaco without truncating source', () => {
    const original = 'first\n' + 'surrounding source\n'.repeat(12000) + 'last\n';
    const modified = original.replace('first', 'updated first').replace('last', 'updated last');
    const previous = editors.at(-1)!;
    render({ ...fixture(), revision: 'full-context', file: { ...fixture().file!, beforeText: original, afterText: modified, hunks: reviewHunks(original, modified) } });
    expect(previous.dispose).toHaveBeenCalledOnce();
    expect(editors.at(-1)!.file!.beforeText).toBe(original);
    expect(editors.at(-1)!.file!.afterText).toBe(modified);
    document.getElementById('next')!.click();
    expect(editors.at(-1)!.focus).toHaveBeenLastCalledWith(1);
  });
  it('shows explicit whole-file decisions for binary/large files and retains Undo after the review is empty', () => {
    render({ ...fixture(), revision: 'binary', file: { ...fixture().file!, hunks: [], beforeText: undefined, afterText: undefined, binary: true, notice: 'Binary file. Review the whole file.' } });
    expect(document.querySelectorAll('.diff-block')).toHaveLength(0);
    document.querySelector<HTMLButtonElement>('.accept')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'accept', revision: 'binary', file: 'first.ts' });
    render({ project: '/project', revision: 'done', busy: false, files: [], undo: { id: 'undo', createdAt: 1, files: ['first.ts'] } });
    document.getElementById('undo')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'undo', revision: 'done', file: undefined });
    expect(document.querySelector<HTMLButtonElement>('#native')!.disabled).toBe(true);
  });
});
