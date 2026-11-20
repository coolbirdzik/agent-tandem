import { hoverHints } from './ui/hover-hints';
import { isMacKeyboard, shortcuts } from './ui/keyboard-shortcuts';
import { autoHideScrollbars } from './ui/scrollbars';
import { ReviewCodeEditor } from './review-monaco';
import type { ReviewEditorState } from './core/review-webview';
import type { ReviewHunk } from './core/review-hunks';
import { renderImageComparison } from './image-comparison';
import { Dropdowns } from './ui/dropdown';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): { file?: string; line?: number; scroll?: number } | undefined; setState(value: unknown): void };
autoHideScrollbars();
hoverHints();
const api = acquireVsCodeApi();
const saved = api.getState();
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const dropdowns = new Dropdowns(document.body);
const filePicker = element<HTMLSelectElement>('files');
const mac = isMacKeyboard(navigator.platform);
const create = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
};
const icon = (name: string) => { const node = create('span', '', `codicon codicon-${name}`); node.setAttribute('aria-hidden', 'true'); return node; };
let state: ReviewEditorState = { files: [], busy: true }, signature = '', listSignature = '', active = 0;
// Rendered actions share this binding. A new revision that leaves the shown
// file's snapshots unchanged updates it in place instead of rebuilding the diff.
let bound: { revision: string | undefined; file: string | undefined } = { revision: undefined, file: undefined };
let sections: HTMLElement[] = [];
let codeEditor: ReviewCodeEditor | undefined;
let deferred: ReviewEditorState | undefined;
let savingEdit = false;
const send = (type: string, extra: Record<string, unknown> = {}) => {
  if (state.busy || codeEditor?.dirty) return;
  api.postMessage({ type, revision: state.revision, file: state.file?.path, ...extra });
};
const save = () => api.setState({ file: state.file?.path, line: state.file?.hunks[active]?.newLine, scroll: codeEditor?.scrollTop ?? 0 });
function button(label: string, glyph: string, className: string, title: string, action: () => void, shortcut?: string) {
  const node = create('button', '', className); node.type = 'button'; node.title = title;
  if (shortcut) node.dataset.shortcut = shortcut;
  node.setAttribute('aria-label', label);
  node.append(icon(glyph), create('span', label, 'action-label')); node.onclick = action; return node;
}
function focusBlock(index: number, scroll = true) {
  active = Math.max(0, Math.min(index, sections.length - 1));
  sections.forEach((section, i) => section.classList.toggle('current', i === active));
  element('block-count').textContent = sections.length ? `${active + 1} / ${sections.length}` : 'File review';
  if (scroll) codeEditor?.focus(active);
  save();
}
function navigate(direction: number, from = active) {
  if (state.busy || codeEditor?.dirty || !state.files.length) return;
  const next = from + direction;
  if (next >= 0 && next < sections.length) { focusBlock(next); return; }
  const index = state.files.findIndex(file => file.path === state.file?.path);
  const file = state.files[(index + direction + state.files.length) % state.files.length];
  if (file?.path === state.file?.path) { focusBlock(direction < 0 ? sections.length - 1 : 0); return; }
  if (file) send('selectFile', { file: file.path, navigation: direction < 0 ? 'last' : 'first' });
}
function navigateFile(direction: number) {
  if (state.busy || codeEditor?.dirty || state.files.length < 2) return;
  const index = state.files.findIndex(file => file.path === state.file?.path);
  const file = state.files[(index + direction + state.files.length) % state.files.length];
  if (file) send('selectFile', { file: file.path, navigation: 'first' });
}
function block(hunk: ReviewHunk, index: number) {
  const binding = bound;
  const section = create('section', '', 'diff-block'); section.tabIndex = -1;
  section.dataset.hunk = hunk.id; section.setAttribute('aria-label', `Change block ${index + 1}`);
  const header = create('header', '', 'block-toolbar');
  const metadata = create('div', '', 'block-meta'); metadata.append(create('span', `Block ${index + 1}/${state.file!.hunks.length}`, 'block-label'), create('span', `+${hunk.newLines}`, 'added-count'), create('span', `−${hunk.oldLines}`, 'deleted-count'));
  const actions = create('div', '', 'block-actions');
  const decisions = create('div', '', 'decision-actions');
  decisions.setAttribute('role', 'group'); decisions.setAttribute('aria-label', 'Review this change');
  decisions.append(
    button('Revert', 'discard', 'reject', 'Restore the saved baseline for this block', () => decide('reject', hunk.id, index, binding), shortcuts.reject),
    button('Accept', 'check', 'accept', 'Keep this block and mark it reviewed', () => decide('accept', hunk.id, index, binding), shortcuts.accept));
  const navigation = create('div', '', 'block-navigation');
  if (state.file!.hunks.length > 1 || state.files.length > 1) navigation.append(button('Next change', 'arrow-down', 'next-block', 'Continue to the next block or file', () => { if (state.revision === binding.revision && state.file?.path === binding.file) navigate(1, index); }, shortcuts.next));
  if (state.files.length > 1) navigation.append(button('Next file', 'chevron-right', 'next-file-block', 'Skip to the next file', () => { if (state.revision === binding.revision && state.file?.path === binding.file) navigateFile(1); }, shortcuts.nextFile));
  actions.append(decisions); if (navigation.childElementCount) actions.append(navigation);
  header.append(metadata, actions); section.append(header);
  section.addEventListener('focusin', () => focusBlock(index, false));
  section.onclick = event => { if (!(event.target instanceof Element && event.target.closest('button'))) focusBlock(index, false); }; return section;
}
function decide(type: string, hunk?: string, index = active, binding = { revision: state.revision, file: state.file?.path }) {
  if (state.busy || codeEditor?.dirty) return;
  focusBlock(index, false); send(type, { ...binding, ...(hunk ? { hunk } : {}) });
  // Disable immediately; the host independently rejects simultaneous actions.
  state = { ...state, busy: true }; controls();
}
function draftCurrent() {
  const latest = deferred ?? state;
  return latest.project === state.project && latest.group === state.group && latest.file?.path === state.file?.path
    && latest.file?.before === state.file?.before && latest.file?.after === state.file?.after && !!latest.file?.editable;
}
function finishDraft() {
  if (codeEditor?.dirty) { controls(); return; }
  const next = deferred;
  deferred = undefined;
  if (next) render(next);
  else controls();
}
function saveEdit() {
  if (!codeEditor?.dirty || savingEdit || (deferred ?? state).busy || !draftCurrent()) return;
  savingEdit = true;
  api.postMessage({ type: 'saveEdit', revision: (deferred ?? state).revision, file: state.file?.path, after: state.file?.after, text: codeEditor.text });
  controls();
}
function controls(refreshPicker = false) {
  const draft = !!codeEditor?.dirty, latest = deferred ?? state;
  const busy = savingEdit || latest.busy, locked = busy || draft;
  codeEditor?.setEditable(!!state.file?.editable && !busy);
  document.querySelectorAll<HTMLButtonElement>('.file-toolbar button:not(.dropdown-trigger),.block-actions button').forEach(node => node.disabled = locked);
  const more = element<HTMLButtonElement>('review-more');
  more.disabled = locked || !state.project;
  more.dataset.vscodeContext = JSON.stringify({
    webviewSection: 'reviewActions', preventDefaultContextMenuItems: true,
    reviewMenuEnabled: !more.disabled, reviewMenuHasFile: !!state.file, reviewMenuHasConversation: !!state.context?.canOpenConversation,
    project: state.project, group: state.group, revision: state.revision, file: state.file?.path,
  });
  element<HTMLButtonElement>('next').disabled = locked || !state.files.length;
  element<HTMLButtonElement>('previous').disabled = locked || !state.files.length;
  const pickerDisabled = locked || !state.files.length;
  if (refreshPicker || filePicker.disabled !== pickerDisabled) {
    filePicker.disabled = pickerDisabled;
    dropdowns.sync();
  }
  for (const id of ['accept-all-file', 'reject-all-file']) { element<HTMLButtonElement>(id).disabled = locked || !state.file; element(id).hidden = !state.file || draft; }
  element<HTMLButtonElement>('next-file').disabled = locked || state.files.length < 2;
  element<HTMLButtonElement>('previous-file').disabled = locked || state.files.length < 2;
  element<HTMLButtonElement>('save-edit').disabled = busy || !draftCurrent();
  element<HTMLButtonElement>('discard-edit').disabled = savingEdit;
  for (const id of ['save-edit', 'discard-edit']) element(id).hidden = !draft;
  const error = latest.error ?? (draft && !savingEdit && !draftCurrent() ? 'The saved diff changed. Copy any edits you want to keep, then discard the draft to load the latest diff.' : undefined);
  element('error').hidden = !error; element('error').textContent = error ?? '';
  element('status').textContent = savingEdit ? 'Saving review edits…' : busy ? 'Updating saved changes…' : draft ? '' : state.notice ?? '';
  element('status').hidden = !element('status').textContent;
  element('status').classList.toggle('updating', busy && !!state.file);
  element('diff').setAttribute('aria-busy', String(busy));
}
function render(next: ReviewEditorState) {
  if (codeEditor?.dirty || savingEdit) { deferred = next; controls(); return; }
  const oldFile = state.file?.path, anchor = state.file?.hunks[active]?.newLine;
  const sameFile = state.project === next.project && oldFile === next.file?.path;
  state = next;
  const fileBinding = { revision: state.revision, file: state.file?.path };
  // The host asks before a whole-file reject, naming the file it restores.
  for (const [id, type] of [['accept-all-file', 'accept'], ['reject-all-file', 'reject']] as const) element(id).onclick = () => {
    if (!state.busy && fileBinding.file && state.revision === fileBinding.revision && state.file?.path === fileBinding.file) decide(type, undefined, active, fileBinding);
  };
  filePicker.title = state.context?.title ?? '';
  const nextList = state.files.map(file => file.path).join('\0');
  if (nextList !== listSignature) {
    listSignature = nextList;
    filePicker.replaceChildren(...state.files.map(file => new Option(file.path, file.path)));
  }
  filePicker.value = state.file?.path ?? state.files[0]?.path ?? '';
  // A revision can change while the displayed snapshots stay the same.
  const nextSignature = JSON.stringify([state.project, state.file?.path, state.file?.before, state.file?.after, state.file?.beforeText?.length, state.file?.afterText?.length,
    state.file?.hunks.map(hunk => hunk.id), state.file?.notice, state.file ? undefined : state.notice, Math.min(state.files.length, 2)]);
  if (nextSignature === signature) { bound.revision = state.revision; controls(true); return; }
  signature = nextSignature; bound = { revision: state.revision, file: state.file?.path };
  const diff = element('diff');
  const reuseEditor = sameFile && codeEditor && state.file && !state.file.notice;
  if (!reuseEditor) {
    codeEditor?.dispose(); codeEditor = undefined;
    diff.classList.remove('monaco-review'); diff.replaceChildren(); sections = [];
  }
  if (!state.file) diff.append(create('div', state.notice ?? 'No pending changes. Saved edits will appear in Review.', 'empty'));
  else if (state.file.notice) {
    const binding = bound;
    const empty = create('section', '', `file-review${state.file.images ? ' image-file-review' : ''}`);
    const metadata = create('div', '', 'file-review-meta');
    const heading = create('div', '', 'file-review-heading'); heading.append(icon(state.file.images ? 'file-media' : state.file.binary ? 'file-binary' : 'file'), create('h2', state.file.path));
    metadata.append(heading, create('p', state.file.notice), create('p', `Before: ${state.file.beforeSize.toLocaleString()} bytes · After: ${state.file.afterSize.toLocaleString()} bytes`, 'file-size'));
    const actions = create('div', '', 'block-actions');
    const decisions = create('div', '', 'decision-actions'); decisions.setAttribute('role', 'group'); decisions.setAttribute('aria-label', 'Review this file');
    decisions.append(button('Revert file', 'discard', 'reject', 'Preview the scope before restoring this file', () => decide('reject', undefined, active, binding)), button('Accept file', 'check', 'accept', 'Keep all pending changes in this file', () => decide('accept', undefined, active, binding)));
    const navigation = create('div', '', 'block-navigation'); navigation.append(button('Native diff', 'go-to-file', '', 'Open full saved snapshots', () => send('native', binding)));
    actions.append(decisions, navigation); empty.append(metadata, actions); diff.append(empty);
    if (state.file.images) diff.append(renderImageComparison(state.file.images, state.file.path));
  } else {
    sections = state.file.hunks.map((hunk, index) => block(hunk, index));
    if (codeEditor) codeEditor.update(state.file, sections);
    else codeEditor = new ReviewCodeEditor(diff, state.file, sections, index => focusBlock(index, false), save, finishDraft);
  }
  controls(true);
  const targetLine = sameFile ? anchor : saved?.file === state.file?.path ? saved?.line : undefined;
  const target = targetLine === undefined ? 0 : state.file?.hunks.findIndex(hunk => hunk.newLine >= targetLine) ?? 0;
  focusBlock(state.navigation === 'last' ? sections.length - 1 : state.navigation === 'first' ? 0 : target < 0 ? sections.length - 1 : target, false);
  if (sections.length && (state.navigation || !sameFile)) focusBlock(active);
}
filePicker.onchange = () => send('selectFile', { file: filePicker.value, navigation: 'first' });
window.addEventListener('resize', () => {
  const picker = filePicker.closest<HTMLElement>('.file-picker');
  if (picker && !picker.getClientRects().length) dropdowns.closeWithin(picker);
});
element('next').onclick = () => navigate(1); element('previous').onclick = () => navigate(-1);
element('next-file').onclick = () => navigateFile(1); element('previous-file').onclick = () => navigateFile(-1);
element('save-edit').onclick = saveEdit;
element('discard-edit').onclick = () => {
  codeEditor?.discard();
  finishDraft();
};
const more = element<HTMLButtonElement>('review-more');
more.addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  const { left, bottom } = more.getBoundingClientRect();
  more.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: left, clientY: bottom }));
});
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's' && codeEditor?.dirty) {
    event.preventDefault(); event.stopPropagation(); saveEdit(); return;
  }
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.target instanceof Element && !event.target.closest('.monaco-editor .inputarea,.monaco-editor .native-edit-context') && event.target.closest('input,textarea,select,[contenteditable="true"],.tandem-dropdown'))) return;
  let key = event.key.toLowerCase();
  // Option can produce a symbol or a dead key on macOS.
  if (mac && !/^[a-z]$/.test(key) && ['KeyN', 'KeyY'].includes(event.code)) key = event.code.at(-1)!.toLowerCase();
  if (!['arrowdown', 'arrowup', 'pagedown', 'pageup', 'y', 'n'].includes(key)) return;
  event.preventDefault();
  event.stopPropagation();
  if (key === 'pagedown' || key === 'pageup') navigateFile(key === 'pagedown' ? 1 : -1);
  else if (key === 'arrowdown' || key === 'arrowup') navigate(key === 'arrowdown' ? 1 : -1);
  else { const hunk = state.file?.hunks[active]; if (hunk && !state.busy) decide(key === 'y' ? 'accept' : 'reject', hunk.id); }
}, { capture: true });
window.addEventListener('pagehide', () => codeEditor?.dispose());
window.addEventListener('message', event => {
  if (event.data?.type === 'state') render(event.data.state as ReviewEditorState);
  if (event.data?.type === 'chooseFile' && state.files.length) send('chooseFile');
  if (event.data?.type === 'editResult' && savingEdit) {
    savingEdit = false;
    if (event.data.saved) codeEditor?.markSaved();
    finishDraft();
  }
});
controls(true);
api.postMessage({ type: 'ready' });
