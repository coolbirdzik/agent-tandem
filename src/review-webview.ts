import { ReviewCodeEditor } from './review-monaco';
import type { ReviewEditorState } from './core/review-webview';
import type { ReviewHunk } from './core/review-hunks';
import { renderImageComparison } from './image-comparison';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): { file?: string; line?: number; scroll?: number } | undefined; setState(value: unknown): void };
const api = acquireVsCodeApi();
const saved = api.getState();
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const create = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
};
const icon = (name: string) => { const node = create('span', '', `codicon codicon-${name}`); node.setAttribute('aria-hidden', 'true'); return node; };
let state: ReviewEditorState = { files: [], busy: true }, signature = '', active = 0;
let sections: HTMLElement[] = [];
let codeEditor: ReviewCodeEditor | undefined;
let contextSignature = '';
const send = (type: string, extra: Record<string, unknown> = {}) => {
  if (state.busy) return;
  api.postMessage({ type, revision: state.revision, file: state.file?.path, ...extra });
};
const save = () => api.setState({ file: state.file?.path, line: state.file?.hunks[active]?.newLine, scroll: codeEditor?.scrollTop ?? 0 });
function toggleChanges(open: boolean, focus = true) {
  element('agent-changes-panel').hidden = !open;
  element('agent-changes').setAttribute('aria-expanded', String(open));
  if (focus) { if (open) element('agent-change-list').querySelector<HTMLButtonElement>('button')?.focus(); else element('agent-changes').focus(); }
}
function renderContext() {
  const context = state.context;
  element('review-context').hidden = !context;
  if (!context) { toggleChanges(false, false); return; }
  element('context-provider').textContent = context.conversation?.provider === 'Claude' ? 'Claude Code' : context.conversation?.provider ?? 'Workspace';
  element('context-title').textContent = context.title;
  element('context-title').title = context.title;
  element('agent-changes-label').textContent = context.conversation ? 'Agent changes' : 'Workspace changes';
  element('agent-changes-count').textContent = String(context.files.length);
  element('agent-changes-heading').textContent = context.conversation ? 'Agent changes' : 'Workspace changes';
  element('agent-changes-title').textContent = context.title;
  const key = JSON.stringify([state.project, state.revision, state.file?.path, context.group]);
  if (key === contextSignature) return;
  contextSignature = key;
  const list = element('agent-change-list'); list.replaceChildren();
  const binding = { revision: state.revision, file: state.file?.path };
  for (const file of context.files) {
    const row = button('', 'file', 'agent-change-file', `Review ${file.path}`, () => send('selectAgentFile', { ...binding, target: file.path }));
    const copy = create('span', '', 'agent-change-copy'); copy.append(create('span', file.path, 'agent-change-path'), create('span', file.kind, 'agent-change-kind'));
    row.append(copy);
    if (file.additions !== undefined || file.deletions !== undefined) {
      const stats = create('span', '', 'agent-change-stats'); stats.append(create('span', `+${file.additions ?? 0}`, 'added-count'), create('span', `−${file.deletions ?? 0}`, 'deleted-count')); row.append(stats);
    }
    row.setAttribute('aria-current', String(file.path === state.file?.path)); row.dataset.path = file.path; list.append(row);
  }
}
function button(label: string, glyph: string, className: string, title: string, action: () => void) {
  const node = create('button', '', className); node.type = 'button'; node.title = title;
  node.append(icon(glyph), create('span', label)); node.onclick = action; return node;
}
function focusBlock(index: number, scroll = true) {
  active = Math.max(0, Math.min(index, sections.length - 1));
  sections.forEach((section, i) => section.classList.toggle('current', i === active));
  element('block-count').textContent = sections.length ? `${active + 1} / ${sections.length}` : 'File review';
  if (scroll) codeEditor?.focus(active);
  save();
}
function navigate(direction: number, from = active) {
  if (state.busy || !state.files.length) return;
  const next = from + direction;
  if (next >= 0 && next < sections.length) { focusBlock(next); return; }
  const index = state.files.findIndex(file => file.path === state.file?.path);
  const file = state.files[(index + direction + state.files.length) % state.files.length];
  if (file?.path === state.file?.path) { focusBlock(direction < 0 ? sections.length - 1 : 0); return; }
  if (file) send('selectFile', { file: file.path, navigation: direction < 0 ? 'last' : 'first' });
}
function navigateFile(direction: number) {
  if (state.busy || state.files.length < 2) return;
  const index = state.files.findIndex(file => file.path === state.file?.path);
  const file = state.files[(index + direction + state.files.length) % state.files.length];
  if (file) send('selectFile', { file: file.path, navigation: 'first' });
}
function block(hunk: ReviewHunk, index: number) {
  const binding = { revision: state.revision, file: state.file!.path };
  const section = create('section', '', 'diff-block'); section.tabIndex = -1;
  section.dataset.hunk = hunk.id; section.setAttribute('aria-label', `Change block ${index + 1}`);
  const header = create('header', '', 'block-toolbar');
  const metadata = create('div', '', 'block-meta'); metadata.append(create('span', `Block ${index + 1}/${state.file!.hunks.length}`, 'block-label'), create('span', `+${hunk.newLines}`, 'added-count'), create('span', `−${hunk.oldLines}`, 'deleted-count'));
  const actions = create('div', '', 'block-actions');
  const decisions = create('div', '', 'decision-actions');
  decisions.setAttribute('role', 'group'); decisions.setAttribute('aria-label', 'Review this change');
  decisions.append(
    button('Accept', 'check', 'accept', 'Keep this block and mark it reviewed (Alt+Y)', () => decide('accept', hunk.id, index, binding)),
    button('Reject', 'discard', 'reject', 'Restore the saved baseline for this block (Alt+N)', () => decide('reject', hunk.id, index, binding)));
  const navigation = create('div', '', 'block-navigation');
  if (state.file!.hunks.length > 1 || state.files.length > 1) navigation.append(button('Next change', 'arrow-down', 'next-block', 'Continue to the next block or file (Alt+Down)', () => { if (state.revision === binding.revision && state.file?.path === binding.file) navigate(1, index); }));
  if (state.files.length > 1) navigation.append(button('Next file', 'chevron-right', 'next-file-block', 'Skip to the next file (Alt+PageDown)', () => { if (state.revision === binding.revision && state.file?.path === binding.file) navigateFile(1); }));
  actions.append(decisions); if (navigation.childElementCount) actions.append(navigation);
  header.append(metadata, actions); section.append(header);
  section.addEventListener('focusin', () => focusBlock(index, false));
  section.onclick = event => { if (!(event.target instanceof Element && event.target.closest('button'))) focusBlock(index, false); }; return section;
}
function decide(type: string, hunk?: string, index = active, binding = { revision: state.revision, file: state.file?.path }) {
  focusBlock(index, false); send(type, { ...binding, ...(hunk ? { hunk } : {}) });
  // Disable immediately; the host independently rejects simultaneous actions.
  state = { ...state, busy: true }; controls();
}
function controls() {
  document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('.review-header button,.review-context button,.file-toolbar button,.file-toolbar select,.block-actions button,.agent-change-file').forEach(node => node.disabled = state.busy);
  element<HTMLButtonElement>('agent-changes').disabled = state.busy || !state.context?.files.length;
  element<HTMLButtonElement>('open-conversation').disabled = state.busy || !state.context?.canOpenConversation;
  element('open-conversation').title = state.context?.canOpenConversation ? 'Open this conversation in AgentTandem' : state.context?.conversation ? 'This recorded conversation is no longer available in AgentTandem.' : 'These changes do not belong to a single verified conversation.';
  element<HTMLButtonElement>('native').disabled = state.busy || !state.file;
  element<HTMLButtonElement>('next').disabled = state.busy || !state.files.length;
  element<HTMLButtonElement>('previous').disabled = state.busy || !state.files.length;
  element<HTMLSelectElement>('files').disabled = state.busy || !state.files.length;
  element<HTMLButtonElement>('next-file').disabled = state.busy || state.files.length < 2;
  element<HTMLButtonElement>('previous-file').disabled = state.busy || state.files.length < 2;
  element('undo').hidden = !state.undo;
  element('error').hidden = !state.error; element('error').textContent = state.error ?? '';
  element('status').textContent = state.busy ? 'Updating saved changes…' : state.notice ?? '';
  element('status').hidden = !element('status').textContent;
  element('diff').setAttribute('aria-busy', String(state.busy));
}
function render(next: ReviewEditorState) {
  const oldFile = state.file?.path, anchor = state.file?.hunks[active]?.newLine;
  const scroll = codeEditor?.scrollTop ?? 0;
  state = next;
  renderContext();
  const nextSignature = `${state.project}:${state.revision}:${state.file?.path}`;
  if (nextSignature === signature) { controls(); return; }
  signature = nextSignature;
  const picker = element<HTMLSelectElement>('files'); picker.replaceChildren();
  state.files.forEach(file => { const option = create('option', file.path); option.value = file.path; option.selected = file.path === state.file?.path; picker.append(option); });
  element('file-count').textContent = state.files.length ? `File ${state.files.findIndex(file => file.path === state.file?.path) + 1}/${state.files.length}` : '0 files';
  element('file-kind').textContent = state.file?.kind ?? '';
  const diff = element('diff'); codeEditor?.dispose(); codeEditor = undefined; diff.classList.remove('monaco-review'); diff.replaceChildren(); sections = [];
  if (!state.file) diff.append(create('div', state.notice ?? 'No pending changes. Saved edits will appear in Review.', 'empty'));
  else if (state.file.notice) {
    const binding = { revision: state.revision, file: state.file.path };
    const empty = create('section', '', `file-review${state.file.images ? ' image-file-review' : ''}`);
    const metadata = create('div', '', 'file-review-meta');
    const heading = create('div', '', 'file-review-heading'); heading.append(icon(state.file.images ? 'file-media' : state.file.binary ? 'file-binary' : 'file'), create('h2', state.file.path));
    metadata.append(heading, create('p', state.file.notice), create('p', `Before: ${state.file.beforeSize.toLocaleString()} bytes · After: ${state.file.afterSize.toLocaleString()} bytes`, 'file-size'));
    const actions = create('div', '', 'block-actions');
    const decisions = create('div', '', 'decision-actions'); decisions.setAttribute('role', 'group'); decisions.setAttribute('aria-label', 'Review this file');
    decisions.append(button('Accept file', 'check', 'accept', 'Keep all pending changes in this file', () => decide('accept', undefined, active, binding)), button('Reject file', 'discard', 'reject', 'Preview the scope before restoring this file', () => decide('reject', undefined, active, binding)));
    const navigation = create('div', '', 'block-navigation'); navigation.append(button('Native diff', 'go-to-file', '', 'Open full saved snapshots', () => send('native', binding)));
    actions.append(decisions, navigation); empty.append(metadata, actions); diff.append(empty);
    if (state.file.images) diff.append(renderImageComparison(state.file.images, state.file.path));
  } else {
    sections = state.file.hunks.map((hunk, index) => block(hunk, index));
    codeEditor = new ReviewCodeEditor(diff, state.file, sections, index => focusBlock(index, false), save);
  }
  controls();
  const targetLine = oldFile === state.file?.path ? anchor : saved?.file === state.file?.path ? saved?.line : undefined;
  const target = targetLine === undefined ? 0 : state.file?.hunks.findIndex(hunk => hunk.newLine >= targetLine) ?? 0;
  focusBlock(state.navigation === 'last' ? sections.length - 1 : state.navigation === 'first' ? 0 : target < 0 ? sections.length - 1 : target, false);
  if (state.navigation || oldFile !== state.file?.path) { if (sections.length) focusBlock(active); }
  else if (codeEditor) codeEditor.scrollTop = scroll;
}
element<HTMLSelectElement>('files').onchange = event => send('selectFile', { file: (event.target as HTMLSelectElement).value, navigation: 'first' });
element('next').onclick = () => navigate(1); element('previous').onclick = () => navigate(-1);
element('next-file').onclick = () => navigateFile(1); element('previous-file').onclick = () => navigateFile(-1);
element('native').onclick = () => send('native'); element('refresh').onclick = () => send('refresh'); element('undo').onclick = () => send('undo');
element('agent-changes').onclick = () => toggleChanges(element('agent-changes-panel').hidden);
element('close-agent-changes').onclick = () => toggleChanges(false);
element('open-conversation').onclick = () => send('conversation');
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !element('agent-changes-panel').hidden) { event.preventDefault(); toggleChanges(false); return; }
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.target instanceof Element && !event.target.closest('.monaco-editor .inputarea,.monaco-editor .native-edit-context') && event.target.closest('input,textarea,select,[contenteditable="true"]'))) return;
  const key = event.key.toLowerCase();
  if (!['arrowdown', 'arrowup', 'pagedown', 'pageup', 'y', 'n'].includes(key)) return;
  event.preventDefault();
  event.stopPropagation();
  if (key === 'pagedown' || key === 'pageup') navigateFile(key === 'pagedown' ? 1 : -1);
  else if (key === 'arrowdown' || key === 'arrowup') navigate(key === 'arrowdown' ? 1 : -1);
  else { const hunk = state.file?.hunks[active]; if (hunk && !state.busy) decide(key === 'y' ? 'accept' : 'reject', hunk.id); }
}, { capture: true });
window.addEventListener('pagehide', () => codeEditor?.dispose());
window.addEventListener('message', event => { if (event.data?.type === 'state') render(event.data.state as ReviewEditorState); });
api.postMessage({ type: 'ready' });
