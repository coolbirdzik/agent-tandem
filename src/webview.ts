import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Selection } from './core/change-preview';
import type { ViewState } from './core/types';
import type { ConversationProvider } from './providers/conversations';
import type { ChatEdit, ChatRequest, PromptAnswer } from './providers/chat';
import type { ReviewRequest, ReviewFile } from './core/review';
import { fileConversations, reviewGroup } from './core/review-groups';
import { CLIManagerView } from './cli-manager-view';
import { Dropdowns } from './ui/dropdown';
import { ContextStatus } from './ui/context-status';
import { ProviderAccounts } from './ui/provider-accounts';
import { ChatQueueView, type QueueAction } from './ui/chat-queue';
import type { CLIRequest } from './providers/cli-registry';
import type { ModelSelection } from './providers/models';
import { effortLabel, type EffortSelection } from './providers/effort';
import type { FastModeSelection } from './providers/fast-mode';
import { accessChoices, type AccessMode, type AccessSelection } from './providers/access';
import type { ChatAttachment } from './core/attachments';
import { ChatAttachments, attachmentCards } from './ui/chat-attachments';
interface EditDraft extends ChatEdit { previousDraft: string; previousAttachments?: ChatAttachment[] }
declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState?(): { reviewCollapsed?: boolean; collapsedReviewGroups?: string[] }; setState?(value: unknown): void };
const api = acquireVsCodeApi();
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dropdowns = new Dropdowns(document.body);
const contextStatus = new ContextStatus(element('chat-context'));
const send = (type: string, selection?: Selection | string | ChatRequest | PromptAnswer | ReviewRequest | AccessSelection | ModelSelection | EffortSelection | FastModeSelection | CLIRequest | QueueAction | { project: string; provider: ConversationProvider } | { project: string; id: string; token?: string } | { token: string }) => api.postMessage({ type, selection });
let lastState: ViewState | undefined;
const providerAccounts = new ProviderAccounts(element('provider-accounts'), provider => { if (lastState?.project) send('refreshAccount', { project: lastState.project, provider }); });
const queueView = new ChatQueueView(element('chat-queue'), action => send('queueAction', action));
let conversationRevision = '';
let changeRevision = '';
const screenScroll = new Map<string, number>();
let currentScreen = 'conversations';
let historyVisible = false;
let providerFilter = 'all';
let pendingConversation: string | undefined;
let pendingAccess: AccessSelection | undefined;
let pendingModel: ModelSelection | undefined;
let pendingEffort: EffortSelection | undefined;
let pendingFastMode: FastModeSelection | undefined;
let effortRevision = '';
let modelRevision = "";
let currentProject: string | undefined;
// Composer text/edit state belongs to this view lifetime, never an earlier opening.
const drafts = new Map<string, string>();
const edits = new Map<string, EditDraft>();
let reviewCollapsed = api.getState?.()?.reviewCollapsed ?? false;
let draftKey = '';
let submitted: { id: string; key: string; text: string; attachments: ChatAttachment[]; edit?: EditDraft } | undefined;
let accepted: { id: string; key: string; text: string; attachments: ChatAttachment[]; project?: string; edit?: EditDraft } | undefined;
let promptRevision = '';
let reviewRevision = '';
let reviewPreviewRevision = '';
let revertPreviewToken: string | undefined;
const savedGroups = api.getState?.()?.collapsedReviewGroups;
const collapsedReviewGroups = new Set<string>(Array.isArray(savedGroups) ? savedGroups.filter(item => typeof item === 'string').slice(-200) : []);
let checkpointPreviewRevision = '';
const chatInput = element<HTMLTextAreaElement>('chat-input');
const chatProvider = element<HTMLSelectElement>('chat-provider');
const chatAccess = element<HTMLSelectElement>('chat-access');
const chatModel = element<HTMLSelectElement>('chat-model');
const chatEffort = element<HTMLSelectElement>('chat-effort');
const reasoningSlider = element<HTMLInputElement>('reasoning-slider');
function renderReasoningSlider() {
  reasoningSlider.max = String(Math.max(0, chatEffort.options.length - 1));
  reasoningSlider.value = String(Math.max(0, chatEffort.selectedIndex));
  reasoningSlider.disabled = chatEffort.disabled;
  element('reasoning-ticks').parentElement!.style.setProperty('--reasoning-fill', `${chatEffort.options.length > 1 ? Math.max(0, chatEffort.selectedIndex) / (chatEffort.options.length - 1) * 100 : 0}%`);
  const label = chatEffort.selectedOptions[0]?.textContent ?? 'Auto';
  reasoningSlider.setAttribute('aria-valuetext', label);
  reasoningSlider.title = chatEffort.title;
  const output = element('reasoning-value');
  if (output.textContent !== label) output.replaceChildren(create('span', label, 'reasoning-value-change'));
  const ticks = element('reasoning-ticks');
  if (ticks.childElementCount !== chatEffort.options.length) ticks.replaceChildren(...[...chatEffort.options].map(() => create('span')));
  reasoningSlider.closest<HTMLElement>('.reasoning-control')!.dataset.disabled = String(chatEffort.disabled);
}
reasoningSlider.oninput = () => {
  if (reasoningSlider.disabled) return;
  const option = chatEffort.options[Number(reasoningSlider.value)];
  if (!option || option.disabled) { renderReasoningSlider(); return; }
  chatEffort.value = option.value;
  chatEffort.dispatchEvent(new Event('change'));
};
const chatFastMode = element<HTMLButtonElement>('chat-fast-mode');
const modelTrigger = element<HTMLButtonElement>('model-trigger');
const modelPopover = element('model-popover');
const attachmentComposer = new ChatAttachments(element('chat-attachments'), chatInput, element('chat-form'), element<HTMLInputElement>('attachment-picker'), () => draftKey, composerControls);
element('attach-files').onclick = () => element<HTMLInputElement>('attachment-picker').click();
function closeModelPopover(restoreFocus = false) {
  dropdowns.closeWithin(modelPopover);
  const wasOpen = !modelPopover.hidden;
  modelPopover.hidden = true; modelTrigger.setAttribute('aria-expanded', 'false');
  if (wasOpen && restoreFocus) modelTrigger.focus();
}
function positionModelPopover() {
  if (modelPopover.hidden) return;
  const anchor = modelTrigger.getBoundingClientRect(), bounds = modelPopover.getBoundingClientRect();
  modelPopover.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`;
  const above = anchor.top - bounds.height - 7;
  modelPopover.style.top = `${Math.max(8, above >= 8 ? above : Math.min(anchor.bottom + 7, window.innerHeight - bounds.height - 8))}px`;
}
modelTrigger.onclick = () => {
  if (modelTrigger.disabled) return;
  if (!modelPopover.hidden) { closeModelPopover(); return; }
  closeMenu(); modelPopover.hidden = false; modelTrigger.setAttribute('aria-expanded', 'true');
  positionModelPopover(); dropdowns.focus(chatModel);
};
element('model-popover-close').onclick = () => closeModelPopover(true);
window.addEventListener('resize', positionModelPopover);
window.addEventListener('focusin', event => {
  if (!modelPopover.hidden && !modelPopover.contains(event.target as Node) && !modelTrigger.contains(event.target as Node)) closeModelPopover();
});
const cliManagerView = new CLIManagerView(element('cli-manager'), element('cli-manager-status'), request => send('cliAction', request));
element('cli-refresh').onclick = () => send('refreshCLIs');
function invalidModel() {
  const provider = chatProvider.value as ConversationProvider;
  const catalog = lastState?.modelCatalogs?.[provider];
  return (!!chatModel.value && (catalog?.status !== 'ready' || !catalog.choices.some(choice => choice.id === chatModel.value))) ||
    (!!chatEffort.value && (catalog?.status !== 'ready' || !catalog.choices.find(choice => choice.id === chatModel.value)?.reasoningEfforts?.some(choice => choice.id === chatEffort.value)));
}
const draftIdentity = (state: ViewState) => `${state.project ?? ''}:${state.conversation?.conversation.id ? state.conversation.conversation.key : `new:${state.composeProvider ?? 'Codex'}`}`;
function persistDrafts() { api.setState?.({ reviewCollapsed, collapsedReviewGroups: [...collapsedReviewGroups].slice(-200) }); }
function saveDraft() { if (draftKey) drafts.set(draftKey, chatInput.value); persistDrafts(); }
function composerControls() {
  const running = lastState?.chat?.status === 'running' || lastState?.chat?.phase === 'finishing';
  const edit = edits.get(draftKey);
  const stale = !!edit && (edit.revision !== lastState?.conversation?.conversation.revision || !lastState.conversation.messages.some(message => message.id === edit.messageId && message.role === 'user'));
  const submit = element<HTMLButtonElement>('chat-send');
  chatFastMode.disabled = !lastState?.project || chatProvider.value !== 'Codex' || !!running || !!lastState?.review?.busy || !!lastState?.reviewBusy || !!submitted || !!lastState?.cliManager?.busy;
  const queue = canQueue();
  submit.disabled = !lastState?.project || (running && !queue) || (!queue && lastState.review?.busy) || lastState.reviewBusy || !!submitted || lastState.cliManager?.busy || (!chatInput.value.trim() && !attachmentComposer.items.length) || attachmentComposer.busy || stale || (!queue && invalidModel());
  submit.title = queue ? 'Queue message (Enter)' : edit ? 'Send edited message in a new branch (Enter)' : 'Send message (Enter)'; submit.setAttribute('aria-label', queue ? 'Queue message' : edit ? 'Send edited message' : 'Send message');
  submit.querySelector('.codicon')?.setAttribute('class', `codicon codicon-${queue ? 'add' : 'arrow-up'}`);
  element('chat-edit-banner').hidden = !edit;
  element('chat-edit-label').textContent = stale ? 'Conversation changed. Cancel and edit the message again.' : 'Editing message · send creates a new branch';
  element<HTMLButtonElement>('chat-edit-cancel').disabled = !!submitted;
  element<HTMLButtonElement>('attach-files').disabled = !lastState?.project || !!submitted;
}
function canQueue() {
  return !!lastState?.chat && (lastState.chat.status === 'running' || lastState.chat.phase === 'finishing') && lastState.chat.phase !== 'stopping' && lastState.conversation?.conversation.key === lastState.chat.conversationKey && !edits.has(draftKey);
}
function cancelEdit() {
  const edit = edits.get(draftKey); if (!edit || submitted) return;
  edits.delete(draftKey); chatInput.value = edit.previousDraft; attachmentComposer.set(edit.previousAttachments ?? []); saveDraft(); composerControls(); chatInput.focus();
}
element('chat-edit-cancel').onclick = cancelEdit;
function editMessage(messageId: string) {
  if (!lastState?.conversation?.conversation.id || lastState.chat?.status === 'running' || lastState.chat?.phase === 'finishing' || lastState.review?.busy || lastState.reviewBusy || submitted) return;
  const message = lastState.conversation.messages.find(message => message.id === messageId && message.role === 'user');
  if (!message) return;
  const previousDraft = edits.get(draftKey)?.previousDraft ?? chatInput.value;
  const previousAttachments = edits.get(draftKey)?.previousAttachments ?? attachmentComposer.items;
  edits.set(draftKey, { messageId, revision: lastState.conversation.conversation.revision, previousDraft, previousAttachments });
  attachmentComposer.set(message.attachments ?? []);
  chatInput.value = message.text; saveDraft(); composerControls(); chatInput.focus(); chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
}
chatInput.addEventListener('input', () => { saveDraft(); composerControls(); });
chatInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); submitChat(); }
});
element('chat-form').addEventListener('submit', event => { event.preventDefault(); submitChat(); });
function submitChat() {
  const queue = canQueue();
  if (!lastState?.project || (!queue && (lastState.chat?.status === 'running' || lastState.chat?.phase === 'finishing' || lastState.review?.busy || invalidModel())) || lastState.reviewBusy || submitted || lastState.cliManager?.busy || attachmentComposer.busy || (!chatInput.value.trim() && !attachmentComposer.items.length)) return;
  const edit = edits.get(draftKey);
  if (edit && edit.revision !== lastState.conversation?.conversation.revision) return;
  const id = crypto.randomUUID(); submitted = { id, key: draftKey, text: chatInput.value, attachments: [...attachmentComposer.items], edit };
  closeModelPopover();
  send('sendChat', { requestId: id, project: lastState.project, provider: chatProvider.value as ConversationProvider,
    text: chatInput.value, model: chatModel.value, reasoningEffort: chatEffort.value, accessMode: chatAccess.value as AccessMode, conversationKey: lastState.conversation?.conversation.id ? lastState.conversation.conversation.key : undefined,
    ...(submitted.attachments.length ? { attachments: submitted.attachments } : {}),
    ...(chatProvider.value === 'Codex' ? { fastMode: chatFastMode.getAttribute('aria-checked') === 'true' } : {}),
    ...(edit ? { edit: { messageId: edit.messageId, revision: edit.revision } } : {}) });
  composerControls();
}
function newChat() { closeModelPopover(); saveDraft(); historyVisible = false; send('newChat', chatProvider.value); chatInput.focus(); }
element('new-chat').onclick = newChat;
chatProvider.onchange = newChat;
chatAccess.onchange = () => {
  if (!lastState?.project || chatAccess.disabled) return;
  pendingAccess = { project: lastState.project, provider: chatProvider.value as ConversationProvider, mode: chatAccess.value as AccessMode };
  send('setAccessMode', pendingAccess);
  if (lastState) render({ ...lastState, error: undefined });
};
chatModel.onchange = () => {
  if (!lastState?.project || chatModel.disabled || submitted) return;
  pendingModel = { project: lastState.project, provider: chatProvider.value as ConversationProvider, model: chatModel.value };
  send('setModel', pendingModel);
  render({ ...lastState, error: undefined });
};
chatEffort.onchange = () => {
  if (!lastState?.project || chatEffort.disabled || submitted) return;
  pendingEffort = { project: lastState.project, provider: chatProvider.value as ConversationProvider, model: chatModel.value, effort: chatEffort.value };
  send('setReasoningEffort', pendingEffort);
  render({ ...lastState, error: undefined });
};
chatFastMode.onclick = () => {
  if (!lastState?.project || chatFastMode.disabled || submitted || chatProvider.value !== 'Codex') return;
  pendingFastMode = { project: lastState.project, provider: 'Codex', enabled: chatFastMode.getAttribute('aria-checked') !== 'true' };
  send('setFastMode', pendingFastMode);
  render({ ...lastState, error: undefined });
};
element('choose-codex-cli').onclick = () => send('chooseCLI', 'Codex');
element('choose-claude-cli').onclick = () => send('chooseCLI', 'Claude');
element('models-refresh').onclick = () => {
  if (!lastState?.project || submitted || element<HTMLButtonElement>('models-refresh').disabled) return;
  send('refreshModels', { project: lastState.project, provider: chatProvider.value as ConversationProvider, model: '' });
};
element('chat-stop').onclick = () => send('stopChat');
element('activity-stop').onclick = () => send('stopChat');
const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
marked.use({ renderer: { html: ({ text }) => escapeHtml(text), image: ({ text }) => escapeHtml(text) } });
const closeMenu = () => { element<HTMLDetailsElement>('more-menu').open = false; };
function showHistory(show: boolean) {
  if (show && !historyVisible) {
    providerFilter = 'all';
    element<HTMLInputElement>('conversation-search').value = '';
  }
  historyVisible = show;
  closeMenu();
  if (lastState?.screen !== 'conversations') send('screen', 'conversations');
  else if (lastState) render(lastState);
}


element('stop').onclick = () => send(lastState?.chat?.status === 'running' ? 'stopChat' : 'stop');
element('probe').onclick = () => send('probe');
element('sync').onclick = () => send('sync');
element('open-tab')?.addEventListener('click', () => send('tab'));
element('history-open').onclick = () => showHistory(true);
element('open-settings').onclick = () => { closeMenu(); send('settings'); };
element('history-close').onclick = () => showHistory(false);
element<HTMLSelectElement>('history-workspace').onchange = () => { if (lastState) render(lastState); };
element('external-review-menu').onclick = () => { closeMenu(); send('trackingControls'); };
element('review-tracking').onclick = () => send('trackingControls');
element('getting-started').onclick = () => { closeMenu(); send('gettingStarted'); };
element('conversation-search').oninput = () => { if (lastState) render(lastState); };
document.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach(node => { node.onclick = () => { providerFilter = node.dataset.provider!; if (lastState) render(lastState); }; });
document.querySelectorAll<HTMLButtonElement>('[data-screen]').forEach(node => { node.onclick = () => { closeMenu(); send('screen', node.dataset.screen); }; });
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !modelPopover.hidden) { event.preventDefault(); event.stopPropagation(); closeModelPopover(true); return; }
  if (event.key === 'Escape') { closeMenu(); if (historyVisible) showHistory(false); else cancelEdit(); }
});
window.addEventListener('click', event => {
  if (!element('more-menu').contains(event.target as Node)) closeMenu();
  if (!modelPopover.contains(event.target as Node) && !modelTrigger.contains(event.target as Node)) closeModelPopover();
});

/** The pending-changes box collapses to its heading so the chat keeps the room. */
function applyReviewCollapsed() {
  element('pending-changes').classList.toggle('collapsed', reviewCollapsed);
  const body = document.getElementById('review-body');
  if (body) body.hidden = reviewCollapsed;
  const toggle = document.getElementById('review-toggle');
  if (!toggle) return;
  toggle.setAttribute('aria-expanded', String(!reviewCollapsed));
  toggle.title = reviewCollapsed ? 'Show changed files' : 'Hide changed files';
  toggle.setAttribute('aria-label', `${toggle.title}: ${toggle.textContent}`);
}
function setReviewCollapsed(value: boolean) { reviewCollapsed = value; persistDrafts(); applyReviewCollapsed(); }

const messageNav = element('message-nav');
const messageAnchors = () => [...element('conversation').querySelectorAll<HTMLElement>('article.message.user')];
let selectedMessage: { key: string; id: string; scrollTop: number } | undefined;
function clearMessageSelection() {
  selectedMessage = undefined;
  for (const node of document.querySelectorAll('.message-focused')) node.classList.remove('message-focused');
}
/** The newest message at or above the viewport top is the one being read. */
function currentMessage(anchors: HTMLElement[]) {
  const scroller = document.querySelector<HTMLElement>('.scroll-body')!;
  if (selectedMessage) {
    const index = anchors.findIndex(anchor => anchor.dataset.messageId === selectedMessage!.id);
    if (selectedMessage.key === element('conversation').dataset.key && index >= 0 && Math.abs(scroller.scrollTop - selectedMessage.scrollTop) < 2) return index;
    clearMessageSelection();
  }
  // At the bottom, start from the latest request even if it cannot align to the top.
  if (scroller.clientHeight > 0 && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 2) return anchors.length - 1;
  const top = scroller.getBoundingClientRect().top + 12;
  let index = 0;
  anchors.forEach((anchor, position) => { if (anchor.getBoundingClientRect().top <= top) index = position; });
  return index;
}
function updateMessageNav() {
  const anchors = messageAnchors();
  const visible = currentScreen === 'conversations' && !historyVisible && anchors.length > 1;
  messageNav.hidden = !visible;
  if (!visible) return;
  const index = currentMessage(anchors), label = `${index + 1}/${anchors.length}`;
  if (element('message-position').textContent !== label) element('message-position').textContent = label;
  messageNav.title = `Message ${label} · Alt+Up and Alt+Down jump between your messages`;
  element<HTMLButtonElement>('message-previous').disabled = index === 0;
  element<HTMLButtonElement>('message-next').disabled = index === anchors.length - 1;
}
function jumpToMessage(direction: -1 | 1) {
  const anchors = messageAnchors();
  if (anchors.length < 2) return;
  const scroller = document.querySelector<HTMLElement>('.scroll-body')!;
  const target = Math.max(0, Math.min(anchors.length - 1, currentMessage(anchors) + direction));
  clearMessageSelection();
  const anchor = anchors[target]!;
  scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
  selectedMessage = { key: element('conversation').dataset.key!, id: anchor.dataset.messageId!, scrollTop: scroller.scrollTop };
  anchor.tabIndex = -1; anchor.focus({ preventScroll: true });
  anchor.classList.add('message-focused');
  updateMessageNav();
}
element('message-previous').onclick = () => jumpToMessage(-1);
element('message-next').onclick = () => jumpToMessage(1);
let navFrame = false;
document.querySelector<HTMLElement>('.scroll-body')!.addEventListener('scroll', () => {
  if (navFrame) return;
  navFrame = true;
  requestAnimationFrame(() => { navFrame = false; updateMessageNav(); });
});
window.addEventListener('resize', () => { clearMessageSelection(); updateMessageNav(); });
window.addEventListener('keydown', event => {
  if (messageNav.hidden || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault(); jumpToMessage(event.key === 'ArrowUp' ? -1 : 1);
});

function create<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text: string, action: () => void, disabled = false) {
  const node = create('button', text, 'secondary'); node.onclick = action; node.disabled = disabled; return node;
}
function icon(name: string) {
  const node = create('span', undefined, `codicon codicon-${name}`); node.setAttribute('aria-hidden', 'true'); return node;
}
function relativeTime(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function emptyState(title: string, text: string, name: string, action?: () => void) {
  const node = create('div', undefined, 'empty-state');
  node.append(icon(name), create('h3', title), create('p', text));
  if (action) node.append(button('Browse history', action));
  return node;
}
function providerIcon(provider: ConversationProvider) {
  const icon = create('img', undefined, 'provider-icon');
  icon.dataset.provider = provider;
  icon.src = provider === 'Claude' ? document.body.dataset.claudeIcon! : document.body.dataset.codexIcon!;
  icon.alt = ''; icon.setAttribute('aria-hidden', 'true'); return icon;
}
function providerBadge(provider: ConversationProvider, icon = true) {
  const badge = create('span', undefined, 'provider-badge'); badge.dataset.provider = provider;
  if (icon) badge.append(providerIcon(provider));
  badge.append(create('span', provider === 'Claude' ? 'Claude Code' : 'Codex')); return badge;
}
function reviewFileRow(state: ViewState, file: ReviewFile, disabled: boolean, group?: string, prefix = 'review') {
  const request = (): ReviewRequest => ({ project: state.project!, revision: state.review!.revision, file: file.path, ...(group ? { group } : {}) });
  const row = create('div', undefined, 'review-file');
  row.append(icon(file.kind === 'added' ? 'new-file' : file.kind === 'deleted' ? 'trash' : 'edit'));
  const link = button(file.path, () => send('previewReview', request()));
  link.className = 'review-file-link'; link.title = `View ${file.path} changes in the VS Code editor`; link.dataset.focusKey = `${prefix}:${file.path}`; row.append(link);
  const stats = create('span', undefined, 'review-stats');
  if (file.additions !== undefined) stats.append(create('span', `+${file.additions}`, 'review-added'), create('span', `−${file.deletions ?? 0}`, 'review-deleted'));
  else stats.textContent = file.binary ? 'Binary' : file.kind;
  row.append(stats);
  for (const [type, name, title] of [['previewRevert', 'discard', 'Revert'], ['acceptChanges', 'check', 'Accept']]) {
    const action = button(title!, () => send(type!, request()), disabled);
    action.className = 'review-file-action'; action.prepend(icon(name!)); action.title = `${title} ${file.path}`; action.setAttribute('aria-label', action.title); action.dataset.focusKey = `${prefix}:${type}:${file.path}`; row.append(action);
  }
  return row;
}
function renderConversationChanges(state: ViewState, disabled: boolean) {
  const pane = element('conversation-changes'); pane.replaceChildren();
  const review = state.review;
  const toolbar = create('div', undefined, 'changes-toolbar');
  const count = review?.files.length ?? 0;
  toolbar.append(create('span', `${count} pending ${count === 1 ? 'file' : 'files'}`, 'meta'));
  const tools = create('div', undefined, 'review-actions');
  if (review?.files.length) tools.append(button('Review latest', () => send('reviewLatest')));
  tools.append(button('Refresh', () => send('refreshReview'), disabled)); toolbar.append(tools); pane.append(toolbar);
  const bulk = create('div', undefined, 'review-actions changes-bulk-actions');
  bulk.setAttribute('role', 'group'); bulk.setAttribute('aria-label', 'Workspace review actions');
  const requestAll = (): ReviewRequest => ({ project: state.project!, revision: review!.revision });
  for (const [type, label, mark, description] of [
    ['previewReview', 'View all', 'diff', 'View all pending workspace changes in the editor'],
    ['previewRevert', 'Revert all', 'discard', 'Preview reverting all pending workspace changes across conversation groups'],
    ['acceptChanges', 'Accept all', 'check', 'Keep the code and mark all pending workspace changes reviewed across conversation groups'],
  ]) {
    const action = button(label!, () => send(type!, requestAll()), !state.project || !count || (type !== 'previewReview' && disabled));
    action.prepend(icon(mark!)); action.title = description!; action.setAttribute('aria-label', description!);
    action.dataset.focusKey = `workspace-review:${type}`;
    if (type === 'acceptChanges') action.classList.add('review-accept');
    bulk.append(action);
  }
  pane.append(bulk);
  if (review?.undo) {
    const undo = create('div', undefined, 'revert-undo');
    undo.append(icon('history'), create('span', `Last Revert · ${review.undo.files.length} ${review.undo.files.length === 1 ? 'file' : 'files'}`));
    const action = button('Undo', () => send('undoRevert', { project: state.project!, id: review.undo!.id }), disabled); action.dataset.focusKey = 'undo-revert'; undo.append(action); pane.append(undo);
  }
  if (!review?.files.length) {
    pane.append(emptyState(review?.busy ? 'Capturing changes…' : 'No pending changes', review?.externalTracking ? 'Saved edits will appear here, grouped by conversation when native edit history matches. Changes made before tracking started are the baseline.' : 'Resume Tracking in the status bar to capture new edits.', 'diff')); return;
  }
  const groups = new Map<string, ReviewFile[]>();
  for (const file of review.files) { const key = reviewGroup(file); groups.set(key, [...(groups.get(key) ?? []), file]); }
  const selected = state.conversation?.conversation.key;
  const rank = (key: string) => key === selected ? -1 : key === 'shared' ? 1 : key === 'unassigned' ? 2 : 0;
  for (const [key, files] of [...groups].sort(([a], [b]) => rank(a) - rank(b))) {
    const sources = [...new Map(files.flatMap(fileConversations).map(source => [source.key, source])).values()];
    const source = sources[0], named = key !== 'shared' && key !== 'unassigned';
    const card = create('section', undefined, 'conversation-change-group'); card.dataset.group = key;
    const heading = button('', () => {
      const collapsed = !body.hidden; body.hidden = collapsed;
      if (collapsed) collapsedReviewGroups.add(identity); else collapsedReviewGroups.delete(identity);
      persistDrafts();
      heading.setAttribute('aria-expanded', String(!collapsed));
    }); heading.className = 'conversation-change-heading';
    const identity = `${state.project}:${key}`;
    const body = create('div', undefined, 'conversation-change-body'); body.hidden = collapsedReviewGroups.has(identity);
    body.id = `review-group-${pane.childElementCount}`; heading.setAttribute('aria-controls', body.id); heading.setAttribute('aria-expanded', String(!body.hidden)); heading.dataset.focusKey = `review-group:${key}`;
    heading.append(named && source ? providerIcon(source.provider) : icon(key === 'shared' ? 'git-merge' : 'folder-opened'));
    const title = create('span', named ? source!.title : key === 'shared' ? 'Shared workspace changes' : 'Unassigned workspace changes', 'conversation-change-title'); heading.append(title);
    heading.append(create('span', `${files.length}`, 'count'), icon('chevron-down')); card.append(heading);
    if (named) {
      const caption = create('p', `${source!.provider === 'Claude' ? 'Claude Code' : 'Codex'}${key === selected ? ' · Current conversation' : ''}`, 'review-caption conversation-change-caption'); caption.title = source!.id || 'New conversation';
      if (state.conversations?.some(item => item.key === key)) {
        const open = button('', () => send('conversation', key)); open.className = 'review-chat-link'; open.title = 'Open this conversation in AgentTandem chat'; open.setAttribute('aria-label', 'Open conversation'); open.append(icon('comment-discussion'), create('span', 'Open conversation')); caption.append(open);
      }
      body.append(caption);
    } else body.append(create('p', key === 'shared' ? 'Multiple conversations or mixed edits. Review these files together.' : 'Saved edits without a verified conversation match.', 'review-caption'));
    const actions = create('div', undefined, 'review-actions');
    const request = (): ReviewRequest => ({ project: state.project!, revision: review.revision, group: key });
    actions.append(button('View changes', () => send('previewReview', request())), button('Revert group', () => send('previewRevert', request()), disabled), button('Accept group', () => send('acceptChanges', request()), disabled));
    body.append(actions);
    const list = create('div', undefined, 'review-files');
    for (const file of files) list.append(reviewFileRow(state, file, disabled, key, 'changes'));
    body.append(list); card.append(body); pane.append(card);
  }
}
function renderRevertPreview(state: ViewState, disabled: boolean) {
  const pane = element('revert-preview'), preview = state.revertPreview; pane.replaceChildren(); pane.hidden = !preview;
  if (!preview) return;
  const stale = preview.request.project !== state.project || preview.request.revision !== state.review?.revision;
  pane.append(create('h3', preview.hunk ? 'Revert this change?' : `Revert ${preview.files.length} ${preview.files.length === 1 ? 'file' : 'files'}?`));
  pane.append(create('p', stale ? 'Changes updated. Cancel and preview the current review again.' : 'Restore saved code in this scope. Undo will be available after Revert.', 'review-caption'));
  const list = create('ul', undefined, 'revert-scope');
  for (const file of preview.files) {
    const row = create('li'); row.append(icon(file.kind === 'added' ? 'trash' : file.kind === 'deleted' ? 'new-file' : 'discard'));
    const view = button(file.path, () => send('previewReview', { ...preview.request, file: file.path }), stale); view.title = 'Inspect the saved before and after snapshots'; row.append(view);
    row.append(create('span', preview.hunk ? 'Selected change' : file.kind === 'added' ? 'Delete' : file.kind === 'deleted' ? 'Restore' : 'Restore baseline', 'meta')); list.append(row);
  }
  pane.append(list);
  const actions = create('div', undefined, 'review-actions');
  const confirm = button('Confirm Revert', () => send('confirmRevert', { token: preview.token }), disabled || stale); confirm.className = 'revert-confirm'; confirm.dataset.focusKey = 'confirm-revert';
  actions.append(confirm, button('Cancel', () => send('cancelRevert'), disabled)); pane.append(actions);
}
function render(state: ViewState) {
  if (lastState?.project !== state.project || lastState?.conversation?.conversation.key !== state.conversation?.conversation.key ||
    (lastState?.conversation?.conversation.provider ?? lastState?.composeProvider) !== (state.conversation?.conversation.provider ?? state.composeProvider)) closeModelPopover();
  lastState = state;
  if (currentProject !== state.project) {
    currentProject = state.project; element<HTMLSelectElement>('history-workspace').value = ''; historyVisible = false; pendingConversation = undefined;
    submitted = undefined; accepted = undefined;
    pendingAccess = undefined;
    providerFilter = 'all'; element<HTMLInputElement>('conversation-search').value = '';
    screenScroll.clear();
  }
  if (pendingConversation && state.conversation?.conversation.key === pendingConversation) {
    const openedDraftKey = draftIdentity(state);
    drafts.delete(openedDraftKey); edits.delete(openedDraftKey); attachmentComposer.delete(openedDraftKey);
    if (draftKey === openedDraftKey) chatInput.value = '';
    historyVisible = false; pendingConversation = undefined;
  }
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset.focusKey;
  const opened = new Set([...document.querySelectorAll('details[open]')].map(node => node.id));
  const scroller = document.querySelector<HTMLElement>('.scroll-body')!;
  const previousScroll = scroller.scrollTop;
  const atBottom = scroller.scrollHeight - scroller.clientHeight - previousScroll < 40;
  const nextScreen = state.screen ?? 'conversations';
  const viewKey = nextScreen === 'conversations' && historyVisible ? 'history' : nextScreen;
  const screenChanged = viewKey !== currentScreen;
  if (screenChanged) { screenScroll.set(currentScreen, previousScroll); currentScreen = viewKey; }
  document.querySelectorAll<HTMLButtonElement>('[data-screen]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.screen === nextScreen)));
  for (const section of ['conversations', 'changes', 'tools', 'cli']) element(`screen-${section}`).hidden = section !== nextScreen;
  element('history-view').hidden = !historyVisible;
  element('thread-view').hidden = historyVisible;
  element('history-open').setAttribute('aria-pressed', String(historyVisible && nextScreen === 'conversations'));
  const root = element('root-name'); root.textContent = state.projectName ?? state.project?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Workspace'; root.title = state.project ?? 'No folder open';
  element('sync').title = state.syncing ? 'Syncing conversations…' : state.syncedAt ? `Refresh conversations · last synced ${new Date(state.syncedAt).toLocaleTimeString()}` : 'Refresh workspace conversations';
  element('sync').setAttribute('aria-busy', String(!!state.syncing));
  element<HTMLButtonElement>('sync').disabled = !!state.syncing || !state.project;
  element('sync-errors').textContent = state.syncErrors?.join('\n') ?? '';
  element('error').textContent = state.error ?? '';
  if (submitted && state.chatQueue?.items.some(item => item.requestId === submitted!.id)) {
    attachmentComposer.clearSent(submitted.key, submitted.attachments);
    if (drafts.get(submitted.key) === submitted.text) drafts.delete(submitted.key);
    if (draftKey === submitted.key && chatInput.value === submitted.text) chatInput.value = '';
    submitted = undefined; persistDrafts();
  }
  if (submitted && state.chat?.requestId === submitted.id) {
    accepted = { id: submitted.id, key: submitted.key, text: submitted.text, attachments: submitted.attachments, project: state.project, edit: submitted.edit };
    attachmentComposer.clearSent(submitted.key, submitted.attachments);
    // Clear only the accepted text; preserve edits made while the host was accepting it.
    if (drafts.get(submitted.key) === submitted.text) drafts.delete(submitted.key);
    if (draftKey === submitted.key && chatInput.value === submitted.text) chatInput.value = '';
    if (submitted.edit) {
      edits.delete(submitted.key);
      if (!drafts.has(submitted.key) && submitted.edit.previousDraft) drafts.set(submitted.key, submitted.edit.previousDraft);
      if (submitted.edit.previousAttachments?.length) attachmentComposer.set([...attachmentComposer.items, ...submitted.edit.previousAttachments], submitted.key);
    }
    submitted = undefined;
  } else if (submitted && state.error) submitted = undefined;
  const nextDraftKey = draftIdentity(state);
  if (nextDraftKey !== draftKey) {
    const continuingAttachments = accepted?.id === state.chat?.requestId && state.chat?.status === 'running' && accepted?.project === state.project && state.conversation?.conversation.key === state.chat?.conversationKey ? attachmentComposer.items : undefined;
    const continuingDraft = accepted?.id === state.chat?.requestId && state.chat?.status === 'running' && accepted?.project === state.project && state.conversation?.conversation.key === state.chat?.conversationKey ? chatInput.value : undefined;
    if (!(accepted?.edit && accepted.key === draftKey && accepted.id === state.chat?.requestId && !chatInput.value)) saveDraft();
    draftKey = nextDraftKey; chatInput.value = continuingDraft ?? drafts.get(draftKey) ?? ''; saveDraft();
    if (continuingAttachments?.length) attachmentComposer.set(continuingAttachments);
  }
  if (accepted && state.chat?.requestId === accepted.id && state.chat.status === 'failed' && !state.chat.phase) {
    const failedDraft = `${accepted.project ?? ''}:${state.conversation?.conversation.id ? state.chat.conversationKey : `new:${state.chat.provider}`}`;
    if (draftKey === failedDraft && !chatInput.value) chatInput.value = accepted.text;
    if (!drafts.get(failedDraft)) drafts.set(failedDraft, accepted.text);
    if (accepted.attachments.length) {
      const existing = attachmentComposer.forKey(failedDraft);
      attachmentComposer.set([...existing, ...accepted.attachments.filter(item => !existing.some(current => current.name === item.name && current.data === item.data))], failedDraft);
    }
    if (accepted.edit && draftKey === accepted.key) { edits.set(draftKey, accepted.edit); chatInput.value = accepted.text; }
    accepted = undefined; saveDraft();
  }
  chatProvider.value = state.conversation?.conversation.provider ?? state.composeProvider ?? 'Codex';
  attachmentComposer.render();
  const chatRunning = state.chat?.status === 'running' || state.chat?.phase === 'finishing';
  chatProvider.disabled = chatRunning || !!state.conversation?.conversation.id;
  const provider = chatProvider.value as ConversationProvider;
  if (pendingAccess && (pendingAccess.project !== state.project || pendingAccess.provider !== provider || state.accessModes?.[provider] === pendingAccess.mode || state.error)) pendingAccess = undefined;
  if (chatAccess.dataset.provider !== provider) {
    chatAccess.dataset.provider = provider;
    chatAccess.replaceChildren(...accessChoices[provider].map(choice => { const option = create('option', choice.label); option.value = choice.mode; option.title = choice.description; option.dataset.icon = ({default:'shield', 'read-only':'eye', 'accept-edits':'edit', plan:'list-tree', auto:'sparkle', 'dont-ask':'lock', 'full-access':'unlock'} as Record<AccessMode, string>)[choice.mode]; return option; }));
  }
  chatAccess.value = chatRunning && state.chat?.provider === provider ? state.chat.accessMode ?? 'default' : pendingAccess?.mode ?? state.accessModes?.[provider] ?? 'default';
  chatAccess.disabled = !state.project || chatRunning || !!state.review?.busy || !!state.reviewBusy || !!state.cliManager?.busy || !!submitted;
  if (pendingFastMode && (pendingFastMode.project !== state.project || provider !== 'Codex' || state.codexFastMode === pendingFastMode.enabled || state.error)) pendingFastMode = undefined;
  const fast = provider === 'Codex' && (chatRunning ? state.chat?.fastMode ?? false : pendingFastMode?.enabled ?? state.codexFastMode ?? false);
  element('fast-mode-field').hidden = provider !== 'Codex';
  chatFastMode.disabled = chatAccess.disabled || provider !== 'Codex';
  chatFastMode.setAttribute('aria-checked', String(fast));
  element('fast-mode-value').textContent = fast ? 'On' : 'Off';
  if (pendingModel && (pendingModel.project !== state.project || pendingModel.provider !== provider || state.selectedModels?.[provider] === pendingModel.model || state.error)) pendingModel = undefined;
  const selectedModel = chatRunning && state.chat?.provider === provider ? state.chat.model ?? '' : pendingModel?.model ?? state.selectedModels?.[provider] ?? '';
  const catalog = state.modelCatalogs?.[provider];
  const missing = !!selectedModel && !catalog?.choices.some(choice => choice.id === selectedModel);
  const signature = JSON.stringify([provider, catalog?.choices, missing ? selectedModel : '']);
  if (signature !== modelRevision) {
    modelRevision = signature;
    const defaultOption = create('option', 'Provider default'); defaultOption.value = '';
    const options = (catalog?.choices ?? []).map(choice => { const option = create('option', choice.label); option.value = choice.id; option.title = choice.description ?? choice.id; return option; });
    if (missing) { const option = create('option', `${selectedModel} (unavailable)`); option.value = selectedModel; option.disabled = true; options.push(option); }
    chatModel.replaceChildren(defaultOption, ...options);
  }
  chatModel.value = selectedModel;
  chatModel.disabled = chatAccess.disabled;
  const modelDescription = catalog?.choices.find(choice => choice.id === selectedModel)?.description ?? (selectedModel || 'Use the native provider configuration or default model.');
  chatModel.title = [modelDescription, catalog?.cli?.version, catalog?.cli?.executable].filter(Boolean).join('\n');
  element('models-refresh').title = catalog?.cli ? `Refresh models from ${catalog.cli.version}\n${catalog.cli.executable}` : 'Refresh available models';
  for (const name of ['codex', 'claude']) element<HTMLButtonElement>(`choose-${name}-cli`).disabled = chatAccess.disabled;
  element<HTMLButtonElement>('models-refresh').disabled = chatAccess.disabled || catalog?.status === 'loading';
  const selectedChoice = catalog?.choices.find(choice => choice.id === selectedModel);
  if (pendingEffort && (pendingEffort.project !== state.project || pendingEffort.provider !== provider || pendingEffort.model !== selectedModel || state.selectedEfforts?.[provider]?.[selectedModel] === pendingEffort.effort || state.error)) pendingEffort = undefined;
  const selectedEffort = chatRunning && state.chat?.provider === provider ? state.chat.reasoningEffort ?? '' : pendingEffort?.effort ?? state.selectedEfforts?.[provider]?.[selectedModel] ?? '';
  const efforts = selectedChoice?.reasoningEfforts ?? [], effortMissing = !!selectedEffort && !efforts.some(choice => choice.id === selectedEffort);
  const nextEffort = JSON.stringify([provider, selectedModel, efforts, effortMissing ? selectedEffort : '']);
  if (effortRevision !== nextEffort) {
    effortRevision = nextEffort;
    const auto = create('option', 'Auto'); auto.value = '';
    chatEffort.replaceChildren(auto, ...efforts.map(choice => { const option = create('option', choice.label); option.value = choice.id; option.title = choice.description ?? ''; return option; }));
    if (effortMissing) { const option = create('option', `${effortLabel(selectedEffort)} (unavailable)`); option.value = selectedEffort; option.disabled = true; chatEffort.append(option); }
  }
  chatEffort.value = selectedEffort;
  chatEffort.disabled = chatAccess.disabled || (!efforts.length && !selectedEffort);
  chatEffort.title = !selectedModel ? 'Choose a model to set reasoning effort.' : !efforts.length ? 'This CLI does not report reasoning effort levels for this model.' :
    efforts.find(choice => choice.id === selectedEffort)?.description ?? `Use CLI settings with Auto.${selectedChoice?.defaultReasoningEffort ? ` Suggested model default: ${effortLabel(selectedChoice.defaultReasoningEffort)}.` : ''}`;
  renderReasoningSlider();
  const modelStatus = element('model-status');
  modelStatus.textContent = catalog?.status === 'loading' ? 'Loading models…' : catalog?.error ?? (missing ? 'Selected model unavailable. Refresh or choose Provider default.' : effortMissing ? 'Reasoning effort unavailable. Choose Auto or refresh models.' : '');
  modelStatus.hidden = !modelStatus.textContent; modelStatus.dataset.error = String(catalog?.status === 'error' || ((missing || effortMissing) && catalog?.status === 'ready'));
  element('model-trigger-label').textContent = (selectedChoice?.label ?? (selectedModel || `${provider === 'Claude' ? 'Claude' : 'Codex'} default`)) + (fast ? ' · Fast' : '');
  modelTrigger.title = [chatModel.title, `Reasoning: ${selectedEffort ? effortLabel(selectedEffort) : 'Auto'}`].filter(Boolean).join('\n');
  modelTrigger.disabled = chatModel.disabled;
  modelTrigger.setAttribute('aria-label', `Choose model: ${element('model-trigger-label').textContent}, ${selectedEffort ? effortLabel(selectedEffort) : 'Auto'}`);
  if (modelTrigger.disabled || nextScreen !== 'conversations' || historyVisible) closeModelPopover();
  positionModelPopover();
  chatAccess.title = accessChoices[provider].find(choice => choice.mode === chatAccess.value)?.description ?? '';
  element('access-caption').textContent = chatAccess.value === 'full-access' ? 'No tool approvals' : chatAccess.value === 'dont-ask' ? 'Deny if approval needed' : '';
  element('composer-permissions').dataset.mode = chatAccess.value;
  // A model switch invalidates the old context capacity and cache estimate.
  const previousModel = state.selectedModels?.[provider] ?? '';
  contextStatus.render(state.conversation?.usage, (!!pendingModel && selectedModel !== previousModel) ||
    (state.conversation?.usage?.selectedModel !== undefined && state.conversation.usage.selectedModel !== selectedModel));
  providerAccounts.render(state.accounts, state.project, provider, nextScreen === 'conversations' && !historyVisible);
  queueView.render(state.chatQueue, !!chatRunning || !!state.reviewBusy || !!state.cliManager?.busy);
  element<HTMLButtonElement>('new-chat').disabled = chatRunning || !!state.review?.busy || !!state.reviewBusy;
  chatInput.disabled = !state.project;
  element('chat-composer').hidden = nextScreen !== 'conversations' || historyVisible;
  element('chat-stop').hidden = !chatRunning || state.chat?.phase === 'finishing';
  const activity = element('agent-activity'); activity.hidden = !chatRunning;
  const waiting = !!state.chat?.prompts.length;
  const activityState = state.chat?.phase === 'stopping' ? 'stopping' : waiting ? 'waiting' : state.chat?.phase ?? 'working';
  const activityLabel = activityState === 'stopping' ? 'Stopping…' : waiting ? 'Waiting for you…' : activityState === 'preparing' ? 'Preparing…' : activityState === 'finishing' ? 'Saving changes…' : state.chat?.activity ?? 'Working…';
  activity.dataset.state = activityState; activity.dataset.provider = state.chat?.provider ?? '';
  element('activity-provider').textContent = state.chat?.provider === 'Claude' ? 'Claude Code' : 'Codex';
  const activityIcon = element<HTMLImageElement>('activity-provider-icon');
  activityIcon.dataset.provider = state.chat?.provider ?? 'Codex';
  const iconSource = state.chat?.provider === 'Claude' ? document.body.dataset.claudeIcon! : document.body.dataset.codexIcon!;
  if (activityIcon.getAttribute('src') !== iconSource) activityIcon.src = iconSource;
  if (element('activity-label').textContent !== activityLabel) element('activity-label').textContent = activityLabel;
  element<HTMLButtonElement>('activity-stop').disabled = activityState === 'finishing' || activityState === 'stopping';
  element<HTMLButtonElement>('chat-stop').disabled = activityState === 'stopping';
  element('conversation').setAttribute('aria-busy', String(chatRunning && state.conversation?.conversation.key === state.chat?.conversationKey));
  const chatStatus = element('chat-status'); chatStatus.setAttribute('aria-live', chatRunning ? 'off' : 'polite');
  const chatStatusLabel = chatRunning ? activityLabel : state.chat?.status === 'interrupted' ? 'Stopped' : state.chat?.status === 'failed' ? 'Failed · retry' : 'Enter to send';
  chatStatus.title = chatRunning ? activityLabel : 'Enter to send · Shift+Enter for newline';
  if (chatStatus.textContent !== chatStatusLabel) chatStatus.textContent = chatStatusLabel;
  composerControls();
  const review = state.review, reviewDisabled = chatRunning || !!review?.busy || !!state.reviewBusy;
  const revertPreviewChanged = revertPreviewToken !== state.revertPreview?.token; revertPreviewToken = state.revertPreview?.token;
  const tracking = !!review?.externalTracking;
  element('external-review-hint').textContent = tracking ? 'Chat in Codex or Claude. Review saved changes here.' : 'Tracking paused · captured changes remain available.';
  const conversationKey = state.conversation?.conversation.key;
  const scopedGroup = review?.files.some(file => fileConversations(file).length) && conversationKey ? conversationKey : undefined;
  const reviewFiles = review?.files.filter(file => !scopedGroup || reviewGroup(file) === scopedGroup) ?? [];
  const nextReview = JSON.stringify([state.project, review, reviewDisabled, conversationKey, state.revertPreview]);
  const pending = element('pending-changes');
  pending.hidden = state.screen === 'changes' || (!review?.files.length && !review?.busy && !review?.externalTracking);
  if (nextReview !== reviewRevision) {
    reviewRevision = nextReview;
    renderConversationChanges(state, reviewDisabled);
    renderRevertPreview(state, reviewDisabled);
    const previousReviewScroll = pending.querySelector('.review-files')?.scrollTop ?? 0;
    pending.replaceChildren();
    if (review) {
      const heading = create('div', undefined, 'review-heading');
      const toggle = button('', () => setReviewCollapsed(!reviewCollapsed));
      toggle.id = 'review-toggle'; toggle.className = 'review-toggle'; toggle.append(icon('chevron-down'));
      toggle.setAttribute('aria-controls', 'review-body'); toggle.dataset.focusKey = 'review-toggle';
      toggle.append(icon('diff'), create('span', review.externalTracking && !review.files.length ? 'Watching external changes' : reviewFiles.length ? `${reviewFiles.length} ${reviewFiles.length === 1 ? 'file' : 'files'} pending review` : 'Changes in other conversations', 'review-toggle-label'));
      const title = create('h3'); title.append(toggle); heading.append(title);
      const totals = reviewFiles.reduce((sum, file) => ({ added: sum.added + (file.additions ?? 0), deleted: sum.deleted + (file.deletions ?? 0) }), { added: 0, deleted: 0 });
      if (totals.added || totals.deleted) {
        const total = create('span', undefined, 'review-total');
        total.append(create('span', `+${totals.added}`, 'review-added'), create('span', `−${totals.deleted}`, 'review-deleted'));
        heading.append(total);
      }
      const request = (file?: string): ReviewRequest => ({ project: state.project!, revision: review.revision, file, ...(scopedGroup ? { group: scopedGroup } : {}) });
      const actions = create('div', undefined, 'review-actions');
      const view = button('View changes', () => reviewFiles.length ? send('previewReview', request()) : send('screen', 'changes'), !review.files.length);
      view.title = 'View all changes in the VS Code editor'; view.setAttribute('aria-label', view.title);
      const revert = button('Revert all', () => send('previewRevert', request()), reviewDisabled || !reviewFiles.length);
      revert.title = 'Revert all pending changes'; revert.setAttribute('aria-label', revert.title);
      const accept = button('Accept all', () => send('acceptChanges', request()), reviewDisabled || !reviewFiles.length);
      accept.title = 'Accept all pending changes'; accept.setAttribute('aria-label', accept.title); accept.classList.add('review-accept');
      actions.append(view, revert, accept); heading.append(actions); pending.append(heading);
      const body = create('div', undefined, 'review-body'); body.id = 'review-body';
      if (review.busy && !chatRunning && !state.reviewBusy) body.append(button('Retry change capture', () => send('refreshReview')));
      body.append(create('p', review.busy ? 'Capturing agent changes…' : state.reviewBusy ? 'Updating changes…' : 'Already applied · Accept keeps the code; Revert restores it. Review each file below or all files above.', 'review-caption'));
      if (review.notice) body.append(create('p', review.notice, 'review-caption'));
      if (scopedGroup) body.append(create('p', 'Pending review for the current conversation.', 'review-caption'));
      body.append(button(`${review.files.length - reviewFiles.length ? `${review.files.length - reviewFiles.length} other files · ` : ''}Browse workspace changes`, () => send('screen', 'changes')));
      const files = create('div', undefined, 'review-files');
      for (const file of reviewFiles) files.append(reviewFileRow(state, file, reviewDisabled, scopedGroup));
      body.append(files); pending.append(body); files.scrollTop = previousReviewScroll;
    }
    applyReviewCollapsed();
  }
  const nextReviewPreview = JSON.stringify(state.reviewPreview);
  const nextCheckpointPreview = JSON.stringify([state.checkpointPreview, reviewDisabled]);
  const checkpointPreviewChanged = nextCheckpointPreview !== checkpointPreviewRevision;
  if (checkpointPreviewChanged) {
    checkpointPreviewRevision = nextCheckpointPreview;
    const pane = element('checkpoint-preview'), preview = state.checkpointPreview;
    pane.replaceChildren(); pane.hidden = !preview;
    if (preview) {
      const heading = create('div', undefined, 'review-heading');
      heading.append(icon('history'), create('h3', preview.undo ? 'Undo last restore' : 'Restore checkpoint'));
      pane.append(heading, create('p', `${new Date(preview.createdAt).toLocaleString()} · ${preview.files.length} files will change`, 'meta'));
      pane.append(create('p', preview.files.length ? 'Restore code to this saved point, including later edits to these files. Your chat history stays available.' : 'Your code already matches this checkpoint.', 'checkpoint-description'));
      const files = create('div', undefined, 'checkpoint-files'); files.setAttribute('aria-label', 'Files affected by restore');
      let displayed = 0;
      const more = button('Show more files', () => appendFiles());
      const appendFiles = () => {
        for (const file of preview.files.slice(displayed, displayed + 100)) {
          const row = create('div', undefined, 'checkpoint-file');
          row.append(create('span', file.path, 'checkpoint-path'), create('span', file.kind === 'added' ? 'Restore' : file.kind === 'deleted' ? 'Remove' : 'Reset', 'kind'));
          files.append(row);
        }
        displayed += 100; more.hidden = displayed >= preview.files.length;
      };
      appendFiles(); pane.append(files, more);
      const actions = create('div', undefined, 'actions');
      const cancel = button('Cancel', () => send('closeCheckpointPreview'), reviewDisabled);
      const restore = button(preview.undo ? 'Undo restore' : 'Restore code', () => send('restoreCheckpoint', { project: state.project!, id: preview.id, token: preview.token }), reviewDisabled || !preview.files.length);
      restore.classList.add('primary'); restore.dataset.focusKey = 'confirm-checkpoint';
      actions.append(cancel, restore); pane.append(actions);
    }
  }
  const reviewPreviewChanged = nextReviewPreview !== reviewPreviewRevision;
  if (reviewPreviewChanged) {
    reviewPreviewRevision = nextReviewPreview;
    const pane = element('review-preview'); pane.replaceChildren(); pane.hidden = true;
  }
  const prompts = JSON.stringify(state.chat?.prompts ?? []);
  if (prompts !== promptRevision) {
    promptRevision = prompts;
    const container = element('agent-prompts');
    const previous = new Map([...container.children].map(node => [(node as HTMLElement).dataset.prompt, node]));
    const cards: HTMLElement[] = [];
    for (const prompt of state.chat?.prompts ?? []) {
      const signature = JSON.stringify(prompt), existing = previous.get(signature);
      if (existing) { cards.push(existing as HTMLElement); continue; }
      const card = create('form', undefined, 'agent-prompt'); card.dataset.prompt = signature; card.append(create('h3', prompt.title));
      if (prompt.detail) { const detail = create('details'); detail.append(create('summary', 'View action'), create('pre', prompt.detail)); card.append(detail); }
      const fields = new Map<string, { text: HTMLInputElement; choices: HTMLInputElement[] }>();
      for (const q of prompt.questions ?? []) {
        const field = create('fieldset', undefined, 'agent-question'); field.dataset.questionId = q.id;
        if (q.header) field.append(create('div', q.header, 'question-header'));
        field.append(create('legend', q.question));
        if (q.multiSelect) field.append(create('p', 'Select one or more options.', 'question-description'));
        const choices: HTMLInputElement[] = [];
        for (const option of q.options ?? []) {
          const label = create('label', undefined, 'question-option'), choice = create('input');
          choice.type = q.multiSelect ? 'checkbox' : 'radio'; choice.name = `${prompt.id}:${q.id}`; choice.value = option.label;
          const copy = create('span', undefined, 'question-option-copy'); copy.append(create('span', option.label));
          if (option.description) copy.append(create('span', option.description, 'question-description'));
          label.append(choice, copy); field.append(label); choices.push(choice);
        }
        const label = create('label', q.options?.length ? 'Other answer' : 'Your answer', 'question-custom'), input = create('input');
        input.name = q.id; input.type = q.isSecret ? 'password' : 'text'; input.autocomplete = 'off';
        input.required = !choices.length; input.placeholder = q.options?.length ? 'Or type your own answer…' : 'Type your answer…';
        input.oninput = () => { input.setCustomValidity(''); if (!q.multiSelect && input.value.trim()) choices.forEach(choice => { choice.checked = false; }); };
        choices.forEach(choice => { choice.onchange = () => { input.setCustomValidity(''); if (!q.multiSelect) input.value = ''; }; });
        label.append(input); field.append(label); card.append(field); fields.set(q.id, { text: input, choices });
      }
      const actions = create('div', undefined, 'actions');
      if (prompt.questions) {
        const answer = button('Reply', () => undefined); answer.type = 'submit'; actions.append(answer);
        card.onsubmit = event => {
          event.preventDefault(); const answers: NonNullable<PromptAnswer['answers']> = {};
          for (const q of prompt.questions!) {
            const { text, choices } = fields.get(q.id)!, custom = text.value.trim();
            const selected = choices.filter(choice => choice.checked).map(choice => choice.value);
            const values = q.multiSelect ? [...selected, ...(custom ? [custom] : [])] : custom ? [custom] : selected;
            if (!values.length) { text.setCustomValidity('Choose an option or type an answer.'); text.reportValidity(); return; }
            answers[q.id] = q.multiSelect ? values : values[0]!;
          }
          send('answerAgent', { id: prompt.id, answers });
        };
      } else {
        const decline = button('Decline', () => send('answerAgent', { id: prompt.id, allow: false })), allow = button('Allow once', () => send('answerAgent', { id: prompt.id, allow: true })); decline.type = allow.type = 'button'; actions.append(decline, allow);
        for (const option of prompt.allowOptions ?? []) {
          const remember = button(option.label, () => send('answerAgent', { id: prompt.id, allow: true, allowScope: option.scope }));
          remember.type = 'button'; remember.title = option.description; actions.append(remember);
          card.append(create('p', `${option.label}: ${option.description}`, 'permission-scope'));
        }
      }
      card.append(actions); cards.push(card);
    }
    container.replaceChildren(...cards);
  }

  const workspacePicker = element<HTMLSelectElement>('history-workspace');
  const pathKey = (value: string) => {
    const normalized = value.replace(/\\/g, '/').replace(/\/$/, '');
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
  };
  const workspacePaths = new Map<string, string>();
  for (const item of state.conversations ?? []) workspacePaths.set(pathKey(item.cwd), item.cwd);
  const workspaceSignature = JSON.stringify([state.project, [...workspacePaths]]);
  if (workspacePicker.dataset.signature !== workspaceSignature) {
    const selected = workspacePicker.value;
    workspacePicker.dataset.signature = workspaceSignature;
    const current = create('option', `Current workspace${state.projectName ? ` · ${state.projectName}` : ''}`); current.value = '';
    current.title = state.project ?? 'No workspace open'; current.dataset.icon = 'root-folder';
    workspacePicker.replaceChildren(current, ...[...workspacePaths].sort((a, b) => a[1].localeCompare(b[1])).map(([key, cwd]) => {
      const option = create('option', cwd); option.value = key; option.title = cwd; option.dataset.icon = 'folder'; return option;
    }));
    workspacePicker.value = workspacePaths.has(selected) ? selected : '';
  }
  workspacePicker.disabled = !state.project;
  workspacePicker.title = workspacePicker.selectedOptions[0]?.title ?? '';
  const workspaceConversations = (state.conversations ?? []).filter(item => !workspacePicker.value || pathKey(item.cwd) === workspacePicker.value);
  document.querySelectorAll<HTMLButtonElement>('.history-filters [data-provider]').forEach(node => {
    const provider = node.dataset.provider!;
    const count = workspaceConversations.filter(item => provider === 'all' || item.provider === provider).length;
    const label = provider === 'all' ? 'All' : provider === 'Claude' ? 'Claude Code' : 'Codex';
    node.replaceChildren(create('span', label), create('span', String(count), 'history-provider-count'));
    node.setAttribute('aria-label', `${label}: ${count} conversations`);
    node.setAttribute('aria-pressed', String(provider === providerFilter));
  });
  const historyRoot = element('history-root');
  historyRoot.textContent = state.project ?? 'No workspace open'; historyRoot.title = historyRoot.textContent;
  const query = element<HTMLInputElement>('conversation-search').value.trim().toLocaleLowerCase();
  const conversations = workspaceConversations.filter(item => (providerFilter === 'all' || item.provider === providerFilter) && `${item.title} ${item.provider}`.toLocaleLowerCase().includes(query));
  element('conversation-count').textContent = String(conversations.length);
  const list = element('conversations'); list.replaceChildren();
  if (!conversations.length) list.append(emptyState(state.syncing ? 'Reading history…' : query ? 'No matches' : 'No conversations yet', query ? 'Try another search or provider.' : 'Saved Claude Code and Codex sessions for this workspace appear here.', 'history'));
  for (const conversation of conversations) {
    const link = button('', () => { pendingConversation = conversation.key; send('conversation', conversation.key); }); link.className = 'conversation-link'; link.dataset.focusKey = conversation.key;
    link.setAttribute('aria-pressed', String(state.conversation?.conversation.key === conversation.key));
    const label = create('span', undefined, 'conversation-label'), meta = create('span', undefined, 'conversation-meta');
    const time = create('span', relativeTime(conversation.updatedAt), 'conversation-time'); time.title = new Date(conversation.updatedAt).toLocaleString();
    meta.append(providerBadge(conversation.provider, false), time);
    label.append(create('span', conversation.title, 'conversation-title'), meta);
    link.append(providerIcon(conversation.provider), label); list.append(link);
  }

  const revision = JSON.stringify([state.project, state.conversation?.conversation.key, state.conversation?.conversation.revision, state.conversation?.notice, state.conversation ? '' : state.syncing, reviewDisabled, state.checkpoints, state.checkpointUndo]);
  const chatChanged = revision !== conversationRevision;
  const sameConversation = !!state.conversation && element('conversation').dataset.key === state.conversation.conversation.key;
  if (chatChanged) {
    conversationRevision = revision;
    const chat = element('conversation'), heading = element('thread-heading'); chat.replaceChildren(); heading.replaceChildren();
    chat.dataset.key = state.conversation?.conversation.key ?? ''; heading.hidden = !state.conversation;
    if (selectedMessage?.key !== chat.dataset.key) clearMessageSelection();
    if (!state.conversation) chat.append(emptyState(!state.project ? 'Open a workspace' : 'What are we building?', !state.project ? 'Open a folder in VS Code to chat with Claude Code or Codex.' : 'Choose your agent below and send a message to start working on this project.', !state.project ? 'folder-opened' : 'comment-discussion', state.conversations?.length ? () => showHistory(true) : undefined));
    else {
      const provider = state.conversation.conversation.provider;
      heading.append(providerBadge(provider), create('h2', state.conversation.conversation.title), create('div', `${state.conversation.messages.length} messages · ${relativeTime(state.conversation.conversation.updatedAt)}`, 'thread-meta'));
      if (state.checkpointUndo) {
        const undo = button('Undo restore', () => send('previewCheckpoint', { project: state.project!, id: state.checkpointUndo!.id }), reviewDisabled);
        undo.classList.add('checkpoint-undo'); undo.title = 'Preview code from before the last restore'; undo.dataset.focusKey = 'undo-checkpoint'; heading.append(undo);
      }
      if (!chatRunning && state.conversation.messages.some(message => message.role === 'user' && !state.checkpoints?.some(entry => entry.messageId === message.id))) {
        const hint = create('p', 'Messages without a saved checkpoint cannot restore code. New messages sent here create a checkpoint.', 'checkpoint-hint');
        heading.append(hint);
      }
      if (state.conversation.notice) chat.append(create('p', state.conversation.notice, 'empty'));
      if (!state.conversation.messages.length) chat.append(create('p', 'This session has no saved messages yet.', 'empty'));
      for (const message of state.conversation.messages) {
        const node = create('article', undefined, `message ${message.role}`);
        node.dataset.messageId = message.id;
        if (message.role === 'user') {
          node.tabIndex = -1; node.dataset.focusKey = `message:${chat.dataset.key}:${message.id}`;
          node.setAttribute('aria-label', `Your message: ${message.text.slice(0, 100)}`);
          if (selectedMessage?.id === message.id) node.classList.add('message-focused');
        }
        if (message.role === 'tool') {
          const details = create('details'); details.id = `tool-${message.id}`; details.open = opened.has(details.id);
          const summary = create('summary'); summary.append(icon('terminal'), create('span', message.toolName ?? 'Tool', 'tool-name'), providerBadge(provider), icon('chevron-right')); summary.lastElementChild!.classList.add('tool-chevron');
          details.append(summary, create('pre', message.text)); node.append(details);
        } else {
          const author = create('div', undefined, 'message-author'); author.append(message.role === 'user' ? create('span', 'You') : providerBadge(provider)); node.append(author);
          if (message.role === 'user') {
            const actions = create('div', undefined, 'message-actions');
            const checkpoint = state.checkpoints?.find(entry => entry.messageId === message.id);
            const preparing = state.chat?.requestId === message.id && state.chat.phase === 'preparing';
            const restore = button('Restore code', () => { if (checkpoint) send('previewCheckpoint', { project: state.project!, id: checkpoint.id }); }, reviewDisabled || !checkpoint);
            restore.className = 'message-restore'; restore.prepend(icon('history'));
            restore.title = checkpoint ? `Restore code to before this message · ${new Date(checkpoint.createdAt).toLocaleString()}` : preparing ? 'Preparing checkpoint before the agent runs…' : 'No saved checkpoint for this message. Checkpoints are created for new messages sent from AgentTandem.';
            restore.setAttribute('aria-label', checkpoint ? 'Preview checkpoint before this message' : preparing ? 'Restore unavailable: preparing checkpoint' : 'Restore unavailable: no saved checkpoint for this message');
            restore.dataset.focusKey = `checkpoint:${message.id}`; restore.dataset.checkpointAvailable = String(!!checkpoint);
            actions.append(restore);
            const edit = button('', () => editMessage(message.id), reviewDisabled || !state.conversation.conversation.id);
            edit.className = 'icon-button message-edit'; edit.append(icon('edit')); edit.title = 'Edit and resend'; edit.setAttribute('aria-label', 'Edit and resend message'); edit.dataset.focusKey = `edit:${message.id}`; actions.append(edit); author.append(actions);
          }
          const content = create('div', undefined, message.role === 'user' ? 'message-text' : 'message-text markdown');
          if (message.role === 'user') content.textContent = message.text;
          else {
            content.innerHTML = DOMPurify.sanitize(marked.parse(message.text, { async: false }), { ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], ALLOWED_ATTR: ['href', 'title', 'class', 'start'], ALLOW_DATA_ATTR: false });
            content.querySelectorAll<HTMLAnchorElement>('a').forEach(link => {
              if (!/^(https?:|mailto:)/i.test(link.getAttribute('href') ?? '')) link.removeAttribute('href');
              else { link.rel = 'noopener noreferrer'; link.target = '_blank'; }
            });
          }
          node.append(content);
          if (message.attachments?.length) { const cards = create('div', undefined, 'message-attachments chat-attachments'); attachmentCards(cards, message.attachments); node.append(cards); }
        }
        chat.append(node);
      }
    }
  }

  const stop = element<HTMLButtonElement>('stop');
  stop.hidden = !state.running && (!chatRunning || state.chat?.phase === 'finishing');
  stop.disabled = state.chat?.phase === 'stopping';
  stop.title = chatRunning ? 'Stop agent' : 'Stop demo'; stop.setAttribute('aria-label', stop.title);
  const nextChange = JSON.stringify([state.changePreview, !!state.review?.externalTracking]);
  const changeChanged = nextChange !== changeRevision;
  if (changeChanged) {
    changeRevision = nextChange;
    const preview = element('change-preview'); preview.replaceChildren();
    const change = state.changePreview;
    if (change) {
      const heading = create('div', undefined, 'change-heading');
      heading.append(create('h2', change.title), create('div', `${change.files.length} changed files · saved snapshots`, 'meta')); preview.append(heading);
      if (change.files.length) {
        const files = create('select', undefined, 'change-files'); files.setAttribute('aria-label', 'Changed file');
        for (const file of change.files) { const option = create('option', `${file.kind} · ${file.path}`); option.value = file.path; files.append(option); }
        files.value = change.file?.change.path ?? ''; files.onchange = () => send('previewFile', files.value); preview.append(files);
        const editor = button('Open diff in editor ↗', () => send(change.cumulative ? 'editor-cumulative' : 'editor-file', { ...change.selection, file: change.file?.change.path })); editor.dataset.focusKey = 'open-diff-editor'; preview.append(editor);
      } else preview.append(create('p', 'No code changes at this step.'));
      if (change.output) { const output = create('details'); output.id = 'change-output'; output.open = opened.has(output.id) || !change.files.length; output.append(create('summary', 'Step output'), create('pre', change.output)); preview.append(output); }
    }
  }
  const providers = element('providers'); providers.replaceChildren();
  for (const provider of state.providers) {
    const item = create('article', undefined, 'provider'); item.append(providerBadge(provider.provider), create('div', provider.version ?? '', 'meta'), ...(provider.executable ? [create('p', provider.executable, 'cli-path')] : []), create('p', provider.detail)); providers.append(item);
  }
  cliManagerView.render(state);
  dropdowns.sync();
  element<HTMLButtonElement>('cli-refresh').disabled = !!state.cliManager?.busy;
  if (focusKey) [...document.querySelectorAll<HTMLElement>('[data-focus-key]')].find(node => node.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  if (revertPreviewChanged && state.revertPreview && nextScreen === 'changes') scroller.scrollTop = 0;
  else if (checkpointPreviewChanged && state.checkpointPreview && nextScreen === 'conversations' && !historyVisible) element('checkpoint-preview').scrollIntoView({ block: 'nearest' });
  else if (reviewPreviewChanged && state.reviewPreview && nextScreen === 'conversations' && !historyVisible) scroller.scrollTop = scroller.scrollHeight;
  else if (((chatChanged && !sameConversation) || screenChanged) && nextScreen === 'conversations' && !historyVisible) scroller.scrollTop = scroller.scrollHeight;
  else if (screenChanged) scroller.scrollTop = screenScroll.get(viewKey) ?? 0;
  else if (changeChanged && nextScreen === 'changes') scroller.scrollTop = 0;
  else if (chatChanged && sameConversation && atBottom && !selectedMessage && nextScreen === 'conversations' && !historyVisible) scroller.scrollTop = scroller.scrollHeight;
  else scroller.scrollTop = previousScroll;
  updateMessageNav();
}
window.addEventListener('message', event => { if (event.data?.type === 'state' && event.data.state) render(event.data.state as ViewState); });
api.postMessage({ type: 'ready' });
