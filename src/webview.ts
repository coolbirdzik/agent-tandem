import { hoverHints } from './ui/hover-hints';
import { isMacKeyboard, shortcutMarkup, shortcuts } from './ui/keyboard-shortcuts';
import { autoHideScrollbars } from './ui/scrollbars';
import { renderMessageText, renderToolMessage } from './ui/chat-message';
import type { Selection } from './core/change-preview';
import type { SubagentSelection, SubagentTranscript, ViewState } from './core/types';
import type { ConversationProvider } from './providers/conversations';
import type { ChatEdit, ChatRequest, PromptAnswer } from './providers/chat';
import type { ReviewRequest, ReviewFile } from './core/review';
import { fileConversations, reviewGroup, hasUnassignedCaptures, hasManualConversationLink } from './core/review-groups';
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
import { setModalOpen } from './ui/modal';
interface EditDraft extends ChatEdit { previousDraft: string; previousAttachments?: ChatAttachment[] }
declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState?(): { reviewCollapsed?: boolean; collapsedReviewGroups?: string[] }; setState?(value: unknown): void };
autoHideScrollbars();
hoverHints();
const api = acquireVsCodeApi();
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sidebarNavigation = document.querySelector<HTMLButtonElement>('#sidebar-navigation');
const newChatButton = document.querySelector<HTMLButtonElement>('#new-chat');
const historyButton = document.querySelector<HTMLButtonElement>('#history-open');
const dropdowns = new Dropdowns(document.body);
const contextStatus = new ContextStatus(element('chat-context'));
const send = (type: string, selection?: Selection | string | ChatRequest | PromptAnswer | ReviewRequest | AccessSelection | ModelSelection | EffortSelection | FastModeSelection | CLIRequest | QueueAction | SubagentSelection | { project: string; provider: ConversationProvider } | { project: string; id: string; token?: string } | { token: string }) => api.postMessage({ type, selection });
const revertDialog = element<HTMLDialogElement>('revert-preview');
const checkpointDialog = element<HTMLDialogElement>('checkpoint-preview');
const approvalDialog = element<HTMLDialogElement>('agent-approval');
const approvalPrompts = element('agent-approval-prompts');
const approvalStop = element<HTMLButtonElement>('agent-approval-stop');
const dialogs = [revertDialog, checkpointDialog, approvalDialog];
revertDialog.oncancel = event => { event.preventDefault(); revertDialog.querySelector<HTMLButtonElement>('.modal-cancel')?.click(); };
checkpointDialog.oncancel = event => { event.preventDefault(); checkpointDialog.querySelector<HTMLButtonElement>('.modal-cancel')?.click(); };
approvalDialog.oncancel = event => event.preventDefault();
approvalStop.onclick = () => send('stopChat');
let lastState: ViewState | undefined;
const providerAccounts = new ProviderAccounts(element('provider-accounts'), provider => { if (lastState?.project) send('refreshAccount', { project: lastState.project, provider }); });
const queueView = new ChatQueueView(element('chat-queue'), action => send('queueAction', action));
let conversationRevision = '';
const messageSignatures = new WeakMap<HTMLElement, string>();
const expandedMessages = new Set<string>();
const collapsedMessageHeight = 320;
const messageFolds = new Map<HTMLElement, () => void>();
const messageResize = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
  for (const entry of entries) messageFolds.get(entry.target as HTMLElement)?.();
}) : undefined;
window.addEventListener('resize', () => { for (const update of messageFolds.values()) update(); });
let changeRevision = '';
const screenScroll = new Map<string, number>();
type PanelView = NonNullable<ViewState['screen']> | 'history';
const panelTitles = { changes: 'Review', cli: 'Manage CLIs', history: 'Conversations' };
let currentScreen: PanelView = 'conversations';
const returnViews: PanelView[] = [];
let backDestination: PanelView | undefined;
let historyVisible = false;
let activeSubagent: { selection: SubagentSelection; label: string } | undefined;
let parentChatScroll = 0;
let chatFocus: 'composer' | 'history' | undefined;
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
let revertPreviewRevision = '';
const savedGroups = api.getState?.()?.collapsedReviewGroups;
const collapsedReviewGroups = new Set<string>(Array.isArray(savedGroups) ? savedGroups.filter(item => typeof item === 'string').slice(-200) : []);
let checkpointPreviewRevision = '';
const chatInput = element<HTMLTextAreaElement>('chat-input');
const chatProvider = element<HTMLSelectElement>('chat-provider');
const chatAccess = element<HTMLSelectElement>('chat-access');
const chatModel = element<HTMLSelectElement>('chat-model');
const chatEffort = element<HTMLSelectElement>('chat-effort');
const reasoningSlider = element<HTMLInputElement>('reasoning-slider');
const reasoningTrigger = element<HTMLButtonElement>('reasoning-trigger');
function renderReasoningSlider() {
  reasoningSlider.max = String(Math.max(0, chatEffort.options.length - 1));
  reasoningSlider.value = String(Math.max(0, chatEffort.selectedIndex));
  reasoningSlider.disabled = chatEffort.disabled;
  element('reasoning-ticks').parentElement!.style.setProperty('--reasoning-fill', `${chatEffort.options.length > 1 ? Math.max(0, chatEffort.selectedIndex) / (chatEffort.options.length - 1) * 100 : 0}%`);
  const label = chatEffort.selectedOptions[0]?.textContent ?? 'Auto';
  reasoningSlider.setAttribute('aria-valuetext', label);
  reasoningSlider.title = chatEffort.title;
  reasoningTrigger.disabled = chatEffort.disabled;
  reasoningTrigger.title = chatEffort.title;
  reasoningTrigger.setAttribute('aria-label', `Choose reasoning effort: ${label}`);
  const triggerLabel = element('reasoning-trigger-label');
  if (triggerLabel.textContent !== label) triggerLabel.textContent = label;
  const output = element('reasoning-value');
  if (output.textContent !== label) output.replaceChildren(create('span', label, 'reasoning-value-change'));
  const ticks = element('reasoning-ticks');
  if (ticks.childElementCount !== chatEffort.options.length) ticks.replaceChildren(...[...chatEffort.options].map(() => create('span')));
}
reasoningSlider.oninput = () => {
  if (reasoningSlider.disabled) return;
  const option = chatEffort.options[Number(reasoningSlider.value)];
  if (!option || option.disabled) { renderReasoningSlider(); return; }
  chatEffort.value = option.value;
  chatEffort.dispatchEvent(new Event('change'));
};
const chatFastMode = element<HTMLButtonElement>('chat-fast-mode');
const fastModeChip = element<HTMLButtonElement>('fast-mode-chip');
const modelTrigger = element<HTMLButtonElement>('model-trigger');
const attachmentComposer = new ChatAttachments(element('chat-attachments'), chatInput, element('chat-form'), element<HTMLInputElement>('attachment-picker'), () => draftKey, composerControls);
element('attach-files').onclick = () => element<HTMLInputElement>('attachment-picker').click();
let activeComposerPopover: { trigger: HTMLButtonElement; panel: HTMLElement } | undefined;
function closeComposerPopover(restoreFocus = false) {
  if (!activeComposerPopover) return;
  const { trigger, panel } = activeComposerPopover;
  activeComposerPopover = undefined;
  dropdowns.closeWithin(panel);
  panel.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger.focus();
}
function positionComposerPopover() {
  if (!activeComposerPopover) return;
  const { trigger, panel } = activeComposerPopover;
  const anchor = trigger.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`;
  const above = anchor.top - bounds.height - 7;
  panel.style.top = `${Math.max(8, above >= 8 ? above : Math.min(anchor.bottom + 7, window.innerHeight - bounds.height - 8))}px`;
}
function bindComposerPopover(trigger: HTMLButtonElement, id: string, focus: () => void) {
  const panel = element(id);
  trigger.onclick = () => {
    if (trigger.disabled) return;
    const wasOpen = activeComposerPopover?.trigger === trigger;
    closeComposerPopover(wasOpen);
    if (wasOpen) return;
    activeComposerPopover = { trigger, panel };
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    positionComposerPopover();
    focus();
  };
  element(`${id}-close`).onclick = () => closeComposerPopover(true);
}
bindComposerPopover(modelTrigger, 'model-popover', () => dropdowns.focus(chatModel));
bindComposerPopover(reasoningTrigger, 'reasoning-popover', () => reasoningTrigger.focus());
// The popover sits outside the form, so the next native Tab stop would dismiss it.
reasoningTrigger.onkeydown = event => {
  if (event.key !== 'Tab' || event.shiftKey || activeComposerPopover?.trigger !== reasoningTrigger) return;
  event.preventDefault();
  reasoningSlider.focus();
};
// Place the parent before Dropdowns repositions an open child list.
window.addEventListener('resize', positionComposerPopover, true);
function dismissComposerPopoverOutside(event: Event) {
  const target = event.target;
  if (!activeComposerPopover || !(target instanceof Node)) return;
  const { trigger, panel } = activeComposerPopover;
  if (!panel.contains(target) && !trigger.contains(target)) closeComposerPopover();
}
window.addEventListener('focusin', dismissComposerPopoverOutside);
window.addEventListener('click', dismissComposerPopoverOutside);
const cliManagerView = new CLIManagerView(element('cli-manager'), element('cli-manager-status'), request => send('cliAction', request),
  executable => send('copyCLIPath', executable));
element('history-refresh').onclick = () => send('refreshConversations');
element('review-refresh').onclick = () => send('refreshReview');
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
  fastModeChip.disabled = chatFastMode.disabled;
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
  if (activeSubagent || !lastState?.project || (!queue && (lastState.chat?.status === 'running' || lastState.chat?.phase === 'finishing' || lastState.review?.busy || invalidModel())) || lastState.reviewBusy || submitted || lastState.cliManager?.busy || attachmentComposer.busy || (!chatInput.value.trim() && !attachmentComposer.items.length)) return;
  const edit = edits.get(draftKey);
  if (edit && edit.revision !== lastState.conversation?.conversation.revision) return;
  const id = crypto.randomUUID(); submitted = { id, key: draftKey, text: chatInput.value, attachments: [...attachmentComposer.items], edit };
  closeComposerPopover();
  send('sendChat', { requestId: id, project: lastState.project, provider: chatProvider.value as ConversationProvider,
    text: chatInput.value, model: chatModel.value, reasoningEffort: chatEffort.value, accessMode: chatAccess.value as AccessMode, conversationKey: lastState.conversation?.conversation.id ? lastState.conversation.conversation.key : undefined,
    ...(submitted.attachments.length ? { attachments: submitted.attachments } : {}),
    ...(chatProvider.value === 'Codex' ? { fastMode: chatFastMode.getAttribute('aria-checked') === 'true' } : {}),
    ...(edit ? { edit: { messageId: edit.messageId, revision: edit.revision } } : {}) });
  composerControls();
}
function newChat() {
  closeComposerPopover(); saveDraft(); historyVisible = false; chatFocus = 'composer';
  returnViews.length = 0; backDestination = undefined; pendingConversation = undefined;
  send('newChat', chatProvider.value); chatInput.focus();
}
if (newChatButton) newChatButton.onclick = newChat;
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
function setFastMode(enabled: boolean) {
  if (!lastState?.project || chatFastMode.disabled || submitted || chatProvider.value !== 'Codex') return;
  pendingFastMode = { project: lastState.project, provider: 'Codex', enabled };
  send('setFastMode', pendingFastMode);
  render({ ...lastState, error: undefined });
}
chatFastMode.onclick = () => setFastMode(chatFastMode.getAttribute('aria-checked') !== 'true');
fastModeChip.onclick = () => {
  if (fastModeChip.hidden) return;
  const restoreFocus = document.activeElement === fastModeChip;
  setFastMode(false);
  if (restoreFocus && fastModeChip.hidden) modelTrigger.focus();
};
element('models-refresh').onclick = () => {
  if (!lastState?.project || submitted || element<HTMLButtonElement>('models-refresh').disabled) return;
  send('refreshModels', { project: lastState.project, provider: chatProvider.value as ConversationProvider, model: '' });
};
element('chat-stop').onclick = () => send('stopChat');
element('activity-stop').onclick = () => send('stopChat');
function showHistory(show: boolean) {
  activeSubagent = undefined;
  if (show && !historyVisible) {
    providerFilter = 'all';
    element<HTMLInputElement>('conversation-search').value = '';
  }
  historyVisible = show;
  if (lastState?.screen !== 'conversations') send('screen', 'conversations');
  else if (lastState) render(lastState);
}

function sidebarBackView() {
  return returnViews.at(-1) ?? (currentScreen === 'conversations' ? undefined : 'conversations');
}

function goBack(view: PanelView) {
  backDestination = view;
  const screen = view === 'history' ? 'conversations' : view;
  if (screen === 'conversations') historyVisible = view === 'history';
  if (lastState && (lastState.screen ?? 'conversations') === screen) render(lastState);
  else send('screen', screen);
}

function renderSidebarHeader(navigation: HTMLButtonElement, state: ViewState, view: PanelView) {
  const title = view === 'conversations'
    ? activeSubagent?.label ?? (state.conversation?.conversation.title || (state.project ? 'New chat' : 'Open a workspace'))
    : panelTitles[view];
  const heading = element('panel-title');
  if (heading.textContent !== title) {
    heading.textContent = title;
    heading.title = title;
  }
  const back = activeSubagent ? 'conversations' : sidebarBackView();
  if (!back && document.activeElement === navigation) heading.focus({ preventScroll: true });
  navigation.hidden = !back;
  if (back) {
    const label = activeSubagent ? 'Back to parent chat' : back === 'conversations' ? 'Back to chat' : `Back to ${panelTitles[back]}`;
    if (navigation.getAttribute('aria-label') !== label) {
      navigation.title = label;
      navigation.setAttribute('aria-label', label);
    }
  }
  element('conversation-count').hidden = view !== 'history';
  element('review-count').hidden = view !== 'changes';
  element('history-refresh').hidden = view !== 'history';
  element('review-refresh').hidden = view !== 'changes';
  element('cli-refresh').hidden = view !== 'cli';
}

if (sidebarNavigation) sidebarNavigation.onclick = () => {
  if (activeSubagent) { closeSubagent(); return; }
  const back = sidebarBackView();
  if (back) goBack(back);
};
const subagentBack = document.querySelector<HTMLButtonElement>('#subagent-back');
if (subagentBack) subagentBack.onclick = closeSubagent;

function closeSubagent() {
  if (!activeSubagent || !lastState) return;
  const focusKey = `subagent:${activeSubagent.selection.agentId}`;
  activeSubagent = undefined;
  render(lastState);
  [...element('subagent-list').querySelectorAll('button')].find(button => button.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
}

function focusChat() {
  closeComposerPopover();
  chatFocus = 'composer';
  showHistory(false);
}
document.querySelector<HTMLButtonElement>('#focus-chat')?.addEventListener('click', focusChat);


element('stop').onclick = () => send(lastState?.chat?.status === 'running' ? 'stopChat' : 'stop');
element('probe').onclick = () => send('probe', 'inline');
if (historyButton) historyButton.onclick = () => showHistory(true);
document.querySelector<HTMLButtonElement>('#history-close')?.addEventListener('click', () => showHistory(false));
element<HTMLSelectElement>('history-workspace').onchange = () => { if (lastState) render(lastState); };
element('conversation-search').oninput = () => { if (lastState) render(lastState); };
document.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach(node => { node.onclick = () => { providerFilter = node.dataset.provider!; if (lastState) render(lastState); }; });
document.querySelectorAll<HTMLButtonElement>('[data-screen]').forEach(node => { node.onclick = () => { send('screen', node.dataset.screen); }; });
window.addEventListener('keydown', event => {
  if (dialogs.some(dialog => dialog.open)) return;
  if (event.key === 'Escape' && activeComposerPopover) { event.preventDefault(); event.stopPropagation(); closeComposerPopover(true); return; }
  if (event.key !== 'Escape') return;
  if (activeSubagent) { event.preventDefault(); closeSubagent(); }
  else if (sidebarNavigation && currentScreen === 'history') goBack(sidebarBackView() ?? 'conversations');
  else if (historyVisible) showHistory(false);
  else cancelEdit();
});
const reviewToggle = element<HTMLButtonElement>('review-toggle');
reviewToggle.onclick = () => setReviewCollapsed(!reviewCollapsed);
/** An empty review stays collapsed without changing the user's preference. */
function applyReviewCollapsed() {
  const collapsed = reviewToggle.disabled || reviewCollapsed;
  element('pending-changes').classList.toggle('collapsed', collapsed);
  element('review-body').hidden = collapsed;
  reviewToggle.setAttribute('aria-expanded', String(!collapsed));
  if (reviewToggle.disabled) {
    reviewToggle.removeAttribute('title');
    reviewToggle.removeAttribute('aria-label');
  } else {
    reviewToggle.title = collapsed ? 'Show changed files' : 'Hide changed files';
    reviewToggle.setAttribute('aria-label', `${reviewToggle.title}: ${reviewToggle.textContent}`);
  }
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
  const visible = currentScreen === 'conversations' && !historyVisible && !activeSubagent && anchors.length > 1;
  messageNav.hidden = !visible;
  if (!visible) return;
  const index = currentMessage(anchors), label = `${index + 1}/${anchors.length}`;
  if (element('message-position').textContent !== label) element('message-position').textContent = label;
  element<HTMLButtonElement>('message-previous').disabled = index === 0;
  element<HTMLButtonElement>('message-next').disabled = index === anchors.length - 1;
}
function jumpToMessage(direction: -1 | 1) {
  if (activeSubagent) return;
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
  if (messageNav.hidden || dialogs.some(dialog => dialog.open) || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
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
function providerBadge(provider: ConversationProvider) {
  const badge = create('span', undefined, 'provider-badge'); badge.dataset.provider = provider;
  badge.append(providerIcon(provider));
  badge.append(create('span', provider === 'Claude' ? 'Claude Code' : 'Codex')); return badge;
}
function reviewFileRow(state: ViewState, file: ReviewFile, disabled: boolean, group: string, surface: 'review' | 'changes' = 'review') {
  const request = (): ReviewRequest => ({ project: state.project!, revision: state.review!.revision, file: file.path, group });
  const row = create('div', undefined, 'review-file');
  const link = button('', () => send('previewReview', request()));
  link.className = 'review-file-link'; link.title = `View ${file.path} changes in the VS Code editor`; link.dataset.focusKey = `${surface}:${file.path}`;
  const label = create('span', undefined, 'review-file-label');
  label.append(icon(file.kind === 'added' ? 'new-file' : file.kind === 'deleted' ? 'trash' : 'edit'), create('span', file.path, 'review-file-path'));
  link.append(label);
  const actions = create('div', undefined, 'review-file-actions');
  for (const [available, type, label, mark] of [
    [hasUnassignedCaptures(file), 'linkReviewConversation', 'Link to conversation', 'link'],
    [hasManualConversationLink(file), 'unlinkReviewConversation', 'Remove manual link', 'close'],
  ] as const) if (available) {
    const action = button('', () => send(type, request()), disabled);
    action.className = 'review-file-action'; action.append(icon(mark)); action.title = `${label}: ${file.path}`;
    action.setAttribute('aria-label', action.title); action.dataset.focusKey = `${surface}:${type}:${file.path}`; actions.append(action);
  }
  for (const [type, name, title] of [['previewRevert', 'discard', 'Revert'], ['acceptChanges', 'check', 'Accept']] as const) {
    const action = button('', () => send(type, request()), disabled);
    action.className = 'review-file-action'; action.append(icon(name)); action.title = `${title} ${file.path}`; action.setAttribute('aria-label', action.title); action.dataset.focusKey = `${surface}:${type}:${file.path}`; actions.append(action);
  }
  const stats = create('span', undefined, 'review-stats');
  if (file.additions !== undefined) stats.append(create('span', `+${file.additions}`, 'review-added'), create('span', `−${file.deletions ?? 0}`, 'review-deleted'));
  else stats.textContent = file.binary ? 'Binary' : file.kind;
  row.append(link, actions, stats);
  return row;
}
function renderConversationChanges(state: ViewState, disabled: boolean) {
  const pane = element('conversation-changes'); pane.replaceChildren();
  const review = state.review;
  const status = element('review-notice');
  const notice = review?.notice ?? '';
  if (status.textContent !== notice) status.textContent = notice;
  const count = review?.files.length ?? 0;
  element('review-count').textContent = String(count);
  if (count) {
    const toolbar = create('div', undefined, 'changes-toolbar review-actions');
    toolbar.append(button('Review latest', () => send('reviewLatest')));
    pane.append(toolbar);
  }
  const bulk = create('div', undefined, 'review-actions changes-bulk-actions');
  bulk.setAttribute('role', 'group'); bulk.setAttribute('aria-label', 'Workspace review actions');
  const requestAll = (): ReviewRequest => ({ project: state.project!, revision: review!.revision });
  for (const [type, label, mark, description] of [
    ['previewReview', 'View all', 'diff', 'View all pending workspace changes in the editor'],
    ['previewRevert', 'Revert all', 'discard-all', 'Preview reverting all pending workspace changes across conversation groups'],
    ['acceptChanges', 'Accept all', 'check-all', 'Keep the code and mark all pending workspace changes reviewed across conversation groups'],
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
    const hasManualLinks = files.some(hasManualConversationLink);
    const card = create('section', undefined, 'conversation-change-group'); card.dataset.group = key;
    const header = create('div', undefined, 'conversation-change-header');
    const heading = button('', () => {
      const collapsed = !body.hidden; body.hidden = collapsed;
      if (collapsed) collapsedReviewGroups.add(identity); else collapsedReviewGroups.delete(identity);
      persistDrafts();
      heading.setAttribute('aria-expanded', String(!collapsed));
    }); heading.className = 'conversation-change-heading';
    const identity = `${state.project}:${key}`;
    const body = create('div', undefined, 'conversation-change-body'); body.hidden = collapsedReviewGroups.has(identity);
    body.id = `review-group-${pane.childElementCount}`; heading.setAttribute('aria-controls', body.id); heading.setAttribute('aria-expanded', String(!body.hidden)); heading.dataset.focusKey = `review-group:${key}`;
    const identityLabel = create('span', undefined, 'conversation-change-identity');
    identityLabel.append(
      named && source ? providerIcon(source.provider) : icon(key === 'shared' ? 'git-merge' : 'folder-opened'),
      create('span', named ? source!.title : key === 'shared' ? 'Shared workspace changes' : 'Unassigned workspace changes', 'conversation-change-title'),
    );
    heading.append(identityLabel, create('span', `${files.length}`, 'count'), icon('chevron-down'));
    header.append(heading);
    if (named && state.conversations?.some(item => item.key === key)) {
      const open = button('', () => send('conversation', key));
      open.className = 'icon-button review-chat-link';
      open.title = 'Open conversation';
      open.setAttribute('aria-label', open.title);
      open.dataset.focusKey = `review-group-open:${key}`;
      open.append(icon('comment-discussion'));
      header.append(open);
    }
    card.append(header);
    if (named) {
      const details = [key === selected ? 'Current conversation' : '', hasManualLinks ? 'Includes manual links' : ''].filter(Boolean);
      if (details.length) {
        const caption = create('p', details.join(' · '), 'review-caption conversation-change-caption');
        caption.title = source!.id || 'New conversation';
        body.append(caption);
      }
    } else body.append(create('p', key === 'shared' ? 'Multiple conversations or mixed edits. Review these files together.' : 'No automatic conversation match. Link these files to the conversation that produced them, or review them here.', 'review-caption'));
    const actions = create('div', undefined, 'review-actions');
    const request = (): ReviewRequest => ({ project: state.project!, revision: review.revision, group: key });
    actions.append(button('View changes', () => send('previewReview', request())), button('Revert group', () => send('previewRevert', request()), disabled), button('Accept group', () => send('acceptChanges', request()), disabled));
    if (files.some(hasUnassignedCaptures)) actions.append(button('Link to conversation', () => send('linkReviewConversation', request()), disabled));
    if (hasManualLinks) actions.append(button('Remove manual links', () => send('unlinkReviewConversation', request()), disabled));
    body.append(actions);
    const list = create('div', undefined, 'review-files');
    for (const file of files) list.append(reviewFileRow(state, file, disabled, key, 'changes'));
    body.append(list); card.append(body); pane.append(card);
  }
}
function renderRevertPreview(state: ViewState, disabled: boolean) {
  const pane = revertDialog, preview = state.revertPreview;
  pane.replaceChildren();
  if (!preview) return;
  const stale = preview.request.project !== state.project || preview.request.revision !== state.review?.revision;
  const title = create('h2', preview.hunk ? 'Revert this change?' : `Revert ${preview.files.length} ${preview.files.length === 1 ? 'file' : 'files'}?`);
  title.id = 'revert-preview-title'; title.tabIndex = -1; title.autofocus = true; pane.append(title);
  pane.append(create('p', stale ? 'Changes updated. Cancel and preview the current review again.' : 'Restore saved code in this scope. Undo will be available after Revert.', 'review-caption'));
  const list = create('ul', undefined, 'revert-scope');
  for (const file of preview.files) {
    const row = create('li'); row.append(icon(file.kind === 'added' ? 'trash' : file.kind === 'deleted' ? 'new-file' : 'discard'));
    const view = button(file.path, () => send('previewReview', { ...preview.request, file: file.path }), stale); view.title = 'Inspect the saved before and after snapshots'; row.append(view);
    row.append(create('span', preview.hunk ? 'Selected change' : file.kind === 'added' ? 'Delete' : file.kind === 'deleted' ? 'Restore' : 'Restore baseline', 'meta')); list.append(row);
  }
  pane.append(list);
  const actions = create('div', undefined, 'confirmation-actions');
  const confirm = button('Confirm Revert', () => send('confirmRevert', { token: preview.token }), disabled || stale); confirm.className = 'primary'; confirm.dataset.focusKey = 'confirm-revert';
  const cancel = button('Cancel', () => send('cancelRevert'), disabled); cancel.classList.add('modal-cancel'); cancel.dataset.focusKey = 'cancel-revert';
  actions.append(confirm, cancel); pane.append(actions);
}
/** Leave matching nodes attached so focus, selection and hover survive refreshes. */
function reconcileChildren(root: HTMLElement, children: HTMLElement[]) {
  const retained = new Set(children);
  for (const child of [...root.children]) if (!retained.has(child as HTMLElement)) child.remove();
  children.forEach((child, index) => {
    if (root.children[index] !== child) root.insertBefore(child, root.children[index] ?? null);
  });
}
function groupToolRows(chat: HTMLElement, messages: HTMLElement[]) {
  const existing = new Map([...chat.querySelectorAll<HTMLDetailsElement>(':scope > .conversation-tools')].map(group => [group.dataset.firstToolId, group]));
  const rows: HTMLElement[] = [];
  let tools: HTMLElement[] = [];
  const appendGroup = () => {
    if (!tools.length) return;
    const firstToolId = tools[0]!.dataset.messageId;
    let group = existing.get(firstToolId);
    if (!group) {
      group = create('details', undefined, 'conversation-accordion conversation-tools');
      group.dataset.firstToolId = firstToolId;
      const summary = create('summary', undefined, 'conversation-accordion-heading');
      const identity = create('span', undefined, 'conversation-accordion-identity');
      identity.append(icon('tools'), create('span', 'Tools', 'conversation-accordion-title'));
      const chevron = icon('chevron-down');
      chevron.classList.add('conversation-accordion-chevron');
      summary.append(identity, create('span', undefined, 'meta'), chevron);
      group.append(summary, create('div', undefined, 'tool-list'));
    }
    const count = group.querySelector('.meta')!;
    if (count.textContent !== String(tools.length)) count.textContent = String(tools.length);
    reconcileChildren(group.querySelector<HTMLElement>('.tool-list')!, tools);
    rows.push(group);
    tools = [];
  };
  for (const message of messages) {
    if (message.classList.contains('tool')) {
      tools.push(message);
      continue;
    }
    const assistant = message.classList.contains('assistant');
    // Give a recorded tool run the following agent message as an anchor within the same turn.
    if (!assistant) appendGroup();
    rows.push(message);
    if (assistant) appendGroup();
  }
  appendGroup();
  return rows;
}
function renderSubagents(state: ViewState) {
  const details = element<HTMLDetailsElement>('conversation-subagents');
  const parentKey = state.conversation?.conversation.key;
  const group = state.subagents?.parentKey === parentKey ? state.subagents : undefined;
  const identity = JSON.stringify([state.project, parentKey]);
  if (details.dataset.parent !== identity) {
    details.dataset.parent = identity;
    details.open = parentKey !== undefined;
  }
  const appeared = details.hidden && !!group?.entries.length;
  details.hidden = !group?.entries.length;
  const signature = JSON.stringify([identity, group?.entries]);
  if (details.dataset.signature === signature) return appeared;
  details.dataset.signature = signature;
  const count = element('subagent-count');
  count.textContent = String(group?.entries.length ?? 0);
  const list = element('subagent-list');
  const project = state.project;
  list.replaceChildren();
  if (!group || !project) return appeared;
  for (const entry of group.entries) {
    const row = create('li');
    const open = button(entry.label, () => {
      if (!lastState) return;
      const selection = { project, parentKey: group.parentKey, agentId: entry.id, requestId: crypto.randomUUID() };
      activeSubagent = { selection, label: entry.label };
      if (subagentBack) element('subagent-title').textContent = entry.label;
      renderSubagentTranscript();
      render(lastState);
      (sidebarNavigation ?? subagentBack)?.focus({ preventScroll: true });
      send('selectSubagent', selection);
    });
    open.type = 'button';
    open.dataset.focusKey = `subagent:${entry.id}`;
    open.title = entry.id;
    row.append(open);
    list.append(row);
  }
  return appeared;
}
function renderSubagentTranscript(transcript?: SubagentTranscript) {
  const chat = element('subagent-conversation');
  chat.replaceChildren();
  const status = !transcript ? 'Loading transcript…' : transcript.status === 'error' ? transcript.message
    : transcript.notice ?? (transcript.messages.length ? undefined : 'This subagent has no saved messages yet.');
  if (status) {
    const notice = create('p', status, transcript?.status === 'error' ? 'error' : 'meta subagent-notice');
    notice.setAttribute('role', 'status');
    chat.append(notice);
  }
  if (transcript?.status !== 'ready') return;
  const messages = transcript.messages.map(message => {
    const node = create('article', undefined, `message ${message.role}`);
    node.dataset.messageId = message.id;
    if (message.role === 'tool') {
      const tool = renderToolMessage(message);
      tool.id = `subagent-${tool.id}`;
      node.append(tool);
    } else {
      const author = create('div', undefined, 'message-author');
      author.append(create('span', message.role === 'user' ? 'Input' : activeSubagent?.label));
      node.append(author, renderMessageText(message.text));
      if (message.attachments?.length) {
        const cards = create('div', undefined, 'message-attachments chat-attachments');
        attachmentCards(cards, message.attachments);
        node.append(cards);
      }
    }
    return node;
  });
  chat.append(...groupToolRows(chat, messages));
}
function render(state: ViewState) {
  const conversationKey = state.conversation?.conversation.key;
  const conversationChanged = lastState?.conversation?.conversation.key !== conversationKey;
  const conversationOpened = lastState?.conversationOpenRevision !== state.conversationOpenRevision;
  const providerResultsChanged = JSON.stringify(lastState?.providers) !== JSON.stringify(state.providers);
  if (lastState?.project !== state.project || conversationChanged ||
    (lastState?.conversation?.conversation.provider ?? lastState?.composeProvider) !== (state.conversation?.conversation.provider ?? state.composeProvider)) closeComposerPopover();
  if (conversationOpened) historyVisible = false;
  lastState = state;
  const projectChanged = currentProject !== state.project;
  if (projectChanged) {
    currentProject = state.project; element<HTMLSelectElement>('history-workspace').value = ''; historyVisible = false; pendingConversation = undefined;
    returnViews.length = 0; backDestination = undefined;
    submitted = undefined; accepted = undefined;
    pendingAccess = undefined;
    providerFilter = 'all'; element<HTMLInputElement>('conversation-search').value = '';
    screenScroll.clear();
  }
  const openedFromHistory = !!pendingConversation && conversationKey === pendingConversation && currentScreen === 'history';
  if (pendingConversation && conversationKey === pendingConversation) {
    const openedDraftKey = draftIdentity(state);
    drafts.delete(openedDraftKey); edits.delete(openedDraftKey); attachmentComposer.delete(openedDraftKey);
    if (draftKey === openedDraftKey) chatInput.value = '';
    historyVisible = false; pendingConversation = undefined;
  }
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset.focusKey;
  const opened = new Set([...document.querySelectorAll('details[open]')].map(node => node.id));
  const scroller = document.querySelector<HTMLElement>('.scroll-body')!;
  const subagentThread = element('subagent-thread');
  const transcriptWasVisible = !subagentThread.hidden;
  const nextScreen = state.screen ?? 'conversations';
  if (activeSubagent && (activeSubagent.selection.project !== state.project || activeSubagent.selection.parentKey !== conversationKey ||
    nextScreen !== 'conversations' || historyVisible || conversationOpened)) activeSubagent = undefined;
  const transcriptVisible = !!activeSubagent;
  const previousScroll = transcriptWasVisible && !transcriptVisible && !conversationChanged && !projectChanged ? parentChatScroll : scroller.scrollTop;
  if (transcriptVisible && !transcriptWasVisible) parentChatScroll = previousScroll;
  if (transcriptWasVisible && !transcriptVisible) element('subagent-conversation').replaceChildren();
  const atBottom = scroller.scrollHeight - scroller.clientHeight - previousScroll < 40;
  const viewKey = nextScreen === 'conversations' && historyVisible ? 'history' : nextScreen;
  const screenChanged = viewKey !== currentScreen;
  if (screenChanged) {
    if (sidebarNavigation && !projectChanged) {
      if (viewKey === backDestination) returnViews.pop();
      else if (viewKey === 'conversations' && !openedFromHistory) returnViews.length = 0;
      else returnViews.push(currentScreen);
      backDestination = undefined;
    }
    screenScroll.set(currentScreen, previousScroll); currentScreen = viewKey;
  } else if (conversationChanged && viewKey === 'conversations') returnViews.length = 0;
  document.querySelectorAll<HTMLButtonElement>('[data-screen]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.screen === nextScreen)));
  for (const section of ['conversations', 'changes', 'cli']) element(`screen-${section}`).hidden = section !== nextScreen;
  element('history-view').hidden = !historyVisible;
  element('thread-view').hidden = historyVisible || transcriptVisible;
  subagentThread.hidden = !transcriptVisible;
  historyButton?.setAttribute('aria-pressed', String(historyVisible && nextScreen === 'conversations'));
  element<HTMLButtonElement>('history-refresh').disabled = !state.project || !!state.syncing;
  if (sidebarNavigation) renderSidebarHeader(sidebarNavigation, state, viewKey);
  else {
    const root = element('root-name'); root.textContent = state.projectName ?? state.project?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Workspace'; root.title = state.project ?? 'No folder open';
  }
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
  chatFastMode.setAttribute('aria-checked', String(fast));
  fastModeChip.hidden = !fast;
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
  element('model-trigger-label').textContent = selectedChoice?.label ?? (selectedModel || `${provider === 'Claude' ? 'Claude' : 'Codex'} default`);
  modelTrigger.title = [chatModel.title, `Reasoning: ${selectedEffort ? effortLabel(selectedEffort) : 'Auto'}`].filter(Boolean).join('\n');
  modelTrigger.disabled = chatModel.disabled;
  modelTrigger.setAttribute('aria-label', `Choose model: ${element('model-trigger-label').textContent}, ${selectedEffort ? effortLabel(selectedEffort) : 'Auto'}`);
  if (activeComposerPopover?.trigger.disabled || viewKey !== 'conversations' || transcriptVisible) closeComposerPopover();
  chatAccess.title = accessChoices[provider].find(choice => choice.mode === chatAccess.value)?.description ?? '';
  element('access-caption').textContent = chatAccess.value === 'full-access' ? 'No tool approvals' : chatAccess.value === 'dont-ask' ? 'Deny if approval needed' : '';
  element('composer-permissions').dataset.mode = chatAccess.value;
  // A model switch invalidates the old context capacity and cache estimate.
  const previousModel = state.selectedModels?.[provider] ?? '';
  contextStatus.render(state.conversation?.usage, (!!pendingModel && selectedModel !== previousModel) ||
    (state.conversation?.usage?.selectedModel !== undefined && state.conversation.usage.selectedModel !== selectedModel));
  providerAccounts.render(state.accounts, state.project, provider, nextScreen === 'conversations' && !historyVisible);
  queueView.render(state.chatQueue, !!chatRunning || !!state.reviewBusy || !!state.cliManager?.busy);
  if (newChatButton) newChatButton.disabled = chatRunning || !!state.review?.busy || !!state.reviewBusy;
  chatInput.disabled = !state.project;
  if (transcriptVisible) element('chat-queue').hidden = true;
  const composerHidden = viewKey !== 'conversations' || transcriptVisible;
  element('chat-composer').hidden = composerHidden;
  element('pending-changes').hidden = composerHidden;
  element('chat-stop').hidden = !chatRunning || state.chat?.phase === 'finishing';
  const activity = element('agent-activity'); activity.hidden = !chatRunning || transcriptVisible;
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
  approvalStop.disabled = !chatRunning || activityState === 'finishing' || activityState === 'stopping';
  element('conversation').setAttribute('aria-busy', String(chatRunning && state.conversation?.conversation.key === state.chat?.conversationKey));
  const chatStatus = element('chat-status'); chatStatus.setAttribute('aria-live', chatRunning ? 'off' : 'polite');
  const chatStatusLabel = chatRunning ? activityLabel : state.chat?.status === 'interrupted' ? 'Stopped' : state.chat?.status === 'failed' ? 'Failed · retry' : '';
  if (chatStatus.dataset.label !== chatStatusLabel) {
    chatStatus.dataset.label = chatStatusLabel;
    chatStatus.textContent = chatStatusLabel;
    if (!chatStatusLabel) chatStatus.innerHTML = `${shortcutMarkup(shortcuts.send, isMacKeyboard(navigator.platform))} to send`;
  }
  composerControls();
  const review = state.review, reviewInProgress = chatRunning || !!state.reviewBusy;
  const reviewDisabled = reviewInProgress || !!review?.busy;
  const reviewRefresh = element<HTMLButtonElement>('review-refresh');
  reviewRefresh.disabled = reviewInProgress;
  reviewRefresh.title = review?.busy && !reviewInProgress ? 'Retry change capture' : 'Refresh review';
  reviewRefresh.setAttribute('aria-label', reviewRefresh.title);
  const nextRevertPreview = JSON.stringify([state.revertPreview, state.project, review?.revision, reviewDisabled]);
  if (nextRevertPreview !== revertPreviewRevision) {
    revertPreviewRevision = nextRevertPreview;
    renderRevertPreview(state, reviewDisabled);
  }
  element('review-tracking-status').hidden = !!review?.externalTracking;
  const reviewFiles = conversationKey ? review?.files.filter(file => reviewGroup(file) === conversationKey) ?? [] : [];
  const nextReview = JSON.stringify([state.project, review, chatRunning, !!state.reviewBusy, conversationKey]);
  if (nextReview !== reviewRevision) {
    reviewRevision = nextReview;
    renderConversationChanges(state, reviewDisabled);
    const body = element('review-body');
    const actions = element('pending-review-actions');
    const total = element('review-total');
    const previousReviewScroll = body.querySelector('.review-files')?.scrollTop ?? 0;
    body.replaceChildren();
    actions.replaceChildren();
    total.replaceChildren();
    reviewToggle.disabled = !reviewFiles.length;
    actions.hidden = reviewToggle.disabled;
    element('review-toggle-label').textContent = `${reviewFiles.length} ${reviewFiles.length === 1 ? 'file' : 'files'} pending review`;
    const totals = reviewFiles.reduce((sum, file) => ({ added: sum.added + (file.additions ?? 0), deleted: sum.deleted + (file.deletions ?? 0) }), { added: 0, deleted: 0 });
    total.hidden = !totals.added && !totals.deleted;
    if (!total.hidden) total.append(create('span', `+${totals.added}`, 'review-added'), create('span', `−${totals.deleted}`, 'review-deleted'));
    if (review && conversationKey && reviewFiles.length) {
      const request = (): ReviewRequest => ({ project: state.project!, revision: review.revision, group: conversationKey });
      const view = button('View changes', () => send('previewReview', request()));
      view.title = 'View all changes in the VS Code editor'; view.setAttribute('aria-label', view.title);
      const revert = button('Revert all', () => send('previewRevert', request()), reviewDisabled);
      revert.prepend(icon('discard-all'));
      revert.title = 'Revert all pending changes'; revert.setAttribute('aria-label', revert.title);
      const accept = button('Accept all', () => send('acceptChanges', request()), reviewDisabled);
      accept.prepend(icon('check-all'));
      accept.title = 'Accept all pending changes'; accept.setAttribute('aria-label', accept.title); accept.classList.add('review-accept');
      actions.append(view, revert, accept);
      if (review.busy || state.reviewBusy) {
        body.append(create('p', review.busy ? 'Capturing agent changes…' : 'Updating changes…', 'review-caption'));
      }
      const files = create('div', undefined, 'review-files');
      for (const file of reviewFiles) files.append(reviewFileRow(state, file, reviewDisabled, conversationKey));
      body.append(files); files.scrollTop = previousReviewScroll;
    }
    applyReviewCollapsed();
  }
  const nextReviewPreview = JSON.stringify(state.reviewPreview);
  const nextCheckpointPreview = JSON.stringify([state.checkpointPreview, reviewDisabled]);
  const checkpointPreviewChanged = nextCheckpointPreview !== checkpointPreviewRevision;
  if (checkpointPreviewChanged) {
    checkpointPreviewRevision = nextCheckpointPreview;
    const pane = checkpointDialog, preview = state.checkpointPreview;
    pane.replaceChildren();
    if (preview) {
      const heading = create('div', undefined, 'review-heading');
      const title = create('h2', preview.undo ? 'Undo last restore' : 'Restore checkpoint');
      title.id = 'checkpoint-preview-title'; title.tabIndex = -1; title.autofocus = true;
      heading.append(icon('history'), title);
      pane.append(heading, create('p', `${new Date(preview.createdAt).toLocaleString()} · ${preview.files.length} files will change`, 'meta'));
      pane.append(create('p', preview.files.length ? 'Restore code to this saved point, including later edits to these files from any chat or editor. Your chat history stays available.' : 'Your code already matches this checkpoint.', 'checkpoint-description'));
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
      const actions = create('div', undefined, 'confirmation-actions');
      const cancel = button('Cancel', () => send('closeCheckpointPreview'), reviewDisabled);
      cancel.classList.add('modal-cancel'); cancel.dataset.focusKey = 'cancel-checkpoint';
      const restore = button(preview.undo ? 'Undo restore' : 'Restore code', () => send('restoreCheckpoint', { project: state.project!, id: preview.id, token: preview.token }), reviewDisabled || !preview.files.length);
      restore.classList.add('primary'); restore.dataset.focusKey = 'confirm-checkpoint';
      actions.append(restore, cancel); pane.append(actions);
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
    const previous = new Map([...container.children, ...approvalPrompts.children].map(node => [(node as HTMLElement).dataset.prompt, node]));
    const questions: HTMLElement[] = [], approvals: HTMLElement[] = [];
    for (const prompt of state.chat?.prompts ?? []) {
      const cards = prompt.questions ? questions : approvals;
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
      const actions = create('div', undefined, prompt.questions ? 'actions' : 'confirmation-actions');
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
        allow.classList.add('primary');
        for (const option of prompt.allowOptions ?? []) {
          const remember = button(option.label, () => send('answerAgent', { id: prompt.id, allow: true, allowScope: option.scope }));
          remember.type = 'button'; remember.title = option.description; actions.append(remember);
          card.append(create('p', `${option.label}: ${option.description}`, 'permission-scope'));
        }
      }
      card.append(actions); cards.push(card);
    }
    reconcileChildren(container, questions);
    reconcileChildren(approvalPrompts, approvals);
  }

  const workspacePicker = element<HTMLSelectElement>('history-workspace');
  const pathKey = (value: string) => {
    const normalized = value.replace(/\\/g, '/').replace(/\/$/, '');
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
  };
  const historyConversations = (state.conversations ?? []).filter(item => !item.hiddenFromHistory);
  const workspacePaths = new Map<string, string>();
  for (const item of historyConversations) workspacePaths.set(pathKey(item.cwd), item.cwd);
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
  const workspaceConversations = historyConversations.filter(item => !workspacePicker.value || pathKey(item.cwd) === workspacePicker.value);
  document.querySelectorAll<HTMLButtonElement>('.history-filters [data-provider]').forEach(node => {
    const provider = node.dataset.provider!;
    const count = workspaceConversations.filter(item => provider === 'all' || item.provider === provider).length;
    const label = provider === 'all' ? 'All' : provider === 'Claude' ? 'Claude Code' : 'Codex';
    if (node.dataset.count !== String(count)) {
      node.dataset.count = String(count);
      node.replaceChildren(create('span', label), create('span', String(count), 'history-provider-count'));
    }
    node.setAttribute('aria-label', `${label}: ${count} conversations`);
    node.setAttribute('aria-pressed', String(provider === providerFilter));
  });
  const query = element<HTMLInputElement>('conversation-search').value.trim().toLocaleLowerCase();
  const conversations = workspaceConversations.filter(item => (providerFilter === 'all' || item.provider === providerFilter) && `${item.title} ${item.provider}`.toLocaleLowerCase().includes(query));
  element('conversation-count').textContent = String(conversations.length);
  const list = element('conversations');
  const rows = new Map([...list.querySelectorAll<HTMLButtonElement>('.conversation-link')].map(row => [row.dataset.focusKey!, row]));
  const nextRows: HTMLElement[] = [];
  if (!conversations.length) {
    const title = !state.syncedAt && state.syncing ? 'Reading history…' : query ? 'No matches' : 'No conversations yet';
    const signature = JSON.stringify([title, query, state.project]);
    const existing = list.firstElementChild as HTMLElement | null;
    const empty = existing?.dataset.emptySignature === signature ? existing : emptyState(title, query ? 'Try another search or provider.' : 'Saved Claude Code and Codex sessions for this workspace appear here.', 'history');
    empty.dataset.emptySignature = signature; nextRows.push(empty);
  }
  for (const conversation of conversations) {
    let link = rows.get(conversation.key);
    if (!link) {
      link = button('', () => { pendingConversation = conversation.key; send('conversation', conversation.key); });
      link.className = 'conversation-link'; link.dataset.focusKey = conversation.key;
      link.append(providerIcon(conversation.provider), create('span', '', 'conversation-title'), create('span', '', 'conversation-time'));
    }
    link.setAttribute('aria-pressed', String(state.conversation?.conversation.key === conversation.key));
    const title = link.querySelector<HTMLElement>('.conversation-title')!, time = link.querySelector<HTMLElement>('.conversation-time')!;
    if (title.textContent !== conversation.title) {
      title.textContent = conversation.title;
      title.title = conversation.title;
    }
    const label = relativeTime(conversation.updatedAt);
    if (time.textContent !== label) time.textContent = label;
    if (time.dataset.updatedAt !== String(conversation.updatedAt)) {
      time.dataset.updatedAt = String(conversation.updatedAt);
      time.title = new Date(conversation.updatedAt).toLocaleString();
    }
    nextRows.push(link);
  }
  reconcileChildren(list, nextRows);

  const revision = JSON.stringify([state.project, state.conversation?.conversation.key, state.conversation?.conversation.revision, state.conversation?.notice, state.conversation?.messages, state.conversation ? '' : !state.syncedAt && state.syncing, reviewDisabled, state.checkpoints, state.checkpointUndo]);
  const chatChanged = revision !== conversationRevision;
  const sameConversation = !projectChanged && !!state.conversation && element('conversation').dataset.key === state.conversation.conversation.key;
  if (chatChanged) {
    conversationRevision = revision;
    const chat = element('conversation'), heading = element('thread-heading');
    const existingMessages = new Map(sameConversation ? [...chat.querySelectorAll<HTMLElement>('.message[data-message-id]')].map(node => [node.dataset.messageId!, node]) : []);
    const nextMessages: HTMLElement[] = [];
    if (!sameConversation || !state.conversation) chat.replaceChildren();
    chat.dataset.key = state.conversation?.conversation.key ?? ''; heading.hidden = !state.conversation;
    if (selectedMessage?.key !== chat.dataset.key) clearMessageSelection();
    if (!state.conversation) {
      heading.replaceChildren(); delete heading.dataset.signature;
      chat.append(emptyState(!state.project ? 'Open a workspace' : 'What are we building?', !state.project ? 'Open a folder in VS Code to chat with Claude Code or Codex.' : 'Choose your agent below and send a message to start working on this project.', !state.project ? 'folder-opened' : 'comment-discussion', historyConversations.length ? () => showHistory(true) : undefined));
    } else {
      const provider = state.conversation.conversation.provider;
      const missingCheckpoint = !chatRunning && state.conversation.messages.some(message => message.role === 'user' && !state.checkpoints?.some(entry => entry.messageId === message.id));
      const headingSignature = JSON.stringify([state.project, state.conversation.conversation.key, provider, state.conversation.conversation.title, state.conversation.messages.length, relativeTime(state.conversation.conversation.updatedAt), state.checkpointUndo, reviewDisabled, missingCheckpoint]);
      if (heading.dataset.signature !== headingSignature) {
        heading.dataset.signature = headingSignature; heading.replaceChildren();
        heading.append(providerBadge(provider));
        if (!sidebarNavigation) heading.append(create('h2', state.conversation.conversation.title));
        heading.append(create('div', `${state.conversation.messages.length} messages · ${relativeTime(state.conversation.conversation.updatedAt)}`, 'thread-meta'));
        if (state.checkpointUndo) {
          const undo = button('Undo restore', () => send('previewCheckpoint', { project: state.project!, id: state.checkpointUndo!.id }), reviewDisabled);
          undo.classList.add('checkpoint-undo'); undo.title = 'Preview code from before the last restore'; undo.dataset.focusKey = 'undo-checkpoint'; heading.append(undo);
        }
        if (missingCheckpoint) {
          const hint = create('p', 'Messages without a saved checkpoint cannot restore code. Messages sent here, and messages sent from any chat while change tracking is on, have one; earlier messages do not.', 'checkpoint-hint');
          heading.append(hint);
        }
      }
      if (state.conversation.notice) nextMessages.push(create('p', state.conversation.notice, 'empty'));
      if (!state.conversation.messages.length) nextMessages.push(create('p', 'This session has no saved messages yet.', 'empty'));
      for (const message of state.conversation.messages) {
        const checkpoint = state.checkpoints?.find(entry => entry.messageId === message.id);
        const signature = JSON.stringify([message, provider, state.project, state.conversation.conversation.id, reviewDisabled, checkpoint, state.chat?.requestId === message.id ? state.chat.phase : undefined]);
        const existing = existingMessages.get(message.id);
        if (existing && messageSignatures.get(existing) === signature) { nextMessages.push(existing); continue; }
        const node = create('article', undefined, `message ${message.role}`);
        node.dataset.messageId = message.id; messageSignatures.set(node, signature);
        if (message.role === 'user') {
          node.tabIndex = -1; node.dataset.focusKey = `message:${chat.dataset.key}:${message.id}`;
          node.setAttribute('aria-label', `Your message: ${message.text.slice(0, 100)}`);
          if (selectedMessage?.id === message.id) node.classList.add('message-focused');
        }
        if (message.role === 'tool') {
          node.append(renderToolMessage(message, sameConversation && opened.has(`tool-${message.id}`)));
        } else {
          const author = create('div', undefined, 'message-author'); author.append(message.role === 'user' ? create('span', 'You') : providerBadge(provider)); node.append(author);
          if (message.role === 'user') {
            const actions = create('div', undefined, 'message-actions');
            const checkpoint = state.checkpoints?.find(entry => entry.messageId === message.id);
            const preparing = state.chat?.requestId === message.id && state.chat.phase === 'preparing';
            const restore = button('Restore code', () => { if (checkpoint) send('previewCheckpoint', { project: state.project!, id: checkpoint.id }); }, reviewDisabled || !checkpoint);
            restore.className = 'message-restore'; restore.prepend(icon('history'));
            restore.title = checkpoint ? `Restore code to before this message · ${new Date(checkpoint.createdAt).toLocaleString()}` : preparing ? 'Preparing checkpoint before the agent runs…' : 'No saved checkpoint for this message. Checkpoints exist for messages sent from AgentTandem and for messages sent from any chat while change tracking is on.';
            restore.setAttribute('aria-label', checkpoint ? 'Preview checkpoint before this message' : preparing ? 'Restore unavailable: preparing checkpoint' : 'Restore unavailable: no saved checkpoint for this message');
            restore.dataset.focusKey = `checkpoint:${message.id}`; restore.dataset.checkpointAvailable = String(!!checkpoint);
            actions.append(restore);
            const edit = button('', () => editMessage(message.id), reviewDisabled || !state.conversation.conversation.id);
            edit.className = 'icon-button message-edit'; edit.append(icon('edit')); edit.title = 'Edit and resend'; edit.setAttribute('aria-label', 'Edit and resend message'); edit.dataset.focusKey = `edit:${message.id}`; actions.append(edit); author.append(actions);
          }
          const content = renderMessageText(message.text);
          node.append(content);
          if (message.role === 'user') {
            const key = JSON.stringify([state.project, chat.dataset.key, message.id]);
            content.id = `message-content-${message.id}`;
            const toggle = button('', () => {
              if (expandedMessages.has(key)) expandedMessages.delete(key);
              else expandedMessages.add(key);
              update(); updateMessageNav();
            });
            toggle.className = 'message-toggle'; toggle.hidden = true;
            toggle.dataset.focusKey = `message-toggle:${message.id}`;
            toggle.setAttribute('aria-controls', content.id);
            const update = () => {
              const expanded = expandedMessages.has(key);
              content.classList.toggle('message-collapsed', !expanded);
              const overflowing = content.scrollHeight > collapsedMessageHeight;
              if (toggle.hidden !== !overflowing) toggle.hidden = !overflowing;
              toggle.setAttribute('aria-expanded', String(expanded));
              const label = expanded ? 'Show less' : 'Show more';
              if (toggle.textContent !== label) toggle.replaceChildren(create('span', label), icon(expanded ? 'chevron-up' : 'chevron-down'));
            };
            content.classList.toggle('message-collapsed', !expandedMessages.has(key));
            node.append(toggle);
            messageFolds.set(content, update); messageResize?.observe(content);
          }
          if (message.attachments?.length) { const cards = create('div', undefined, 'message-attachments chat-attachments'); attachmentCards(cards, message.attachments); node.append(cards); }
        }
        nextMessages.push(node);
      }
      reconcileChildren(chat, groupToolRows(chat, nextMessages));
      for (const update of messageFolds.values()) update();
    }
    for (const content of messageFolds.keys()) if (!chat.contains(content)) { messageResize?.unobserve(content); messageFolds.delete(content); }
  }

  const subagentsAppeared = renderSubagents(state);
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
  const probe = element<HTMLButtonElement>('probe');
  probe.disabled = !!state.checkingProviders || !!state.cliManager?.busy || state.cliManager?.trusted === false;
  probe.textContent = state.checkingProviders ? 'Checking providers…' : 'Check providers';
  if (providerResultsChanged) {
    element('providers').replaceChildren(...state.providers.map(provider => {
      const item = create('article', undefined, 'provider-check-result');
      const status = provider.available ? 'Available' : 'Unavailable';
      item.append(providerBadge(provider.provider), create('span', provider.version ? `${status} · ${provider.version}` : status, 'meta'));
      if (provider.executable) item.append(create('p', provider.executable, 'provider-check-path'));
      item.append(create('p', provider.detail));
      return item;
    }));
  }
  cliManagerView.render(state);
  positionComposerPopover();
  dropdowns.sync();
  element<HTMLButtonElement>('cli-refresh').disabled = !!state.cliManager?.busy;
  if (focusKey) [...document.querySelectorAll<HTMLElement>('[data-focus-key]')].find(node => node.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  if (transcriptVisible) scroller.scrollTop = transcriptWasVisible ? previousScroll : 0;
  else if (transcriptWasVisible && !screenChanged && !conversationChanged && !projectChanged) scroller.scrollTop = previousScroll;
  else if (reviewPreviewChanged && state.reviewPreview && nextScreen === 'conversations' && !historyVisible) scroller.scrollTop = scroller.scrollHeight;
  else if (((chatChanged && !sameConversation) || screenChanged) && nextScreen === 'conversations' && !historyVisible) scroller.scrollTop = scroller.scrollHeight;
  else if (screenChanged) scroller.scrollTop = screenScroll.get(viewKey) ?? 0;
  else if (changeChanged && nextScreen === 'changes') scroller.scrollTop = 0;
  else if ((chatChanged || subagentsAppeared) && sameConversation && atBottom && !selectedMessage && nextScreen === 'conversations' && !historyVisible) scroller.scrollTop = scroller.scrollHeight;
  else scroller.scrollTop = previousScroll;
  updateMessageNav();
  if (chatFocus && nextScreen === 'conversations' && !transcriptVisible) {
    const target = chatFocus === 'history' ? element('conversation-search') : chatInput;
    target.focus({ preventScroll: true });
    chatFocus = undefined;
  }
  const activeDialog = approvalPrompts.children.length ? approvalDialog
    : state.revertPreview && nextScreen === 'changes' ? revertDialog
    : state.checkpointPreview && !composerHidden ? checkpointDialog : undefined;
  for (const dialog of dialogs) if (dialog !== activeDialog) setModalOpen(dialog, false);
  if (activeDialog) {
    setModalOpen(activeDialog, true);
    const error = activeDialog.querySelector<HTMLElement>('.confirmation-error');
    if (!state.error) error?.remove();
    else if (error) {
      if (error.textContent !== state.error) error.textContent = state.error;
    } else {
      const alert = create('p', undefined, 'confirmation-error');
      alert.setAttribute('role', 'alert');
      activeDialog.firstElementChild?.after(alert);
      alert.textContent = state.error;
    }
    if (!activeDialog.contains(document.activeElement)) activeDialog.querySelector<HTMLElement>('[autofocus]')?.focus({ preventScroll: true });
  }
}
window.addEventListener('message', event => {
  if (event.data?.type === 'state' && event.data.state) render(event.data.state as ViewState);
  if (event.data?.type === 'subagentTranscript' && activeSubagent && event.data.requestId === activeSubagent.selection.requestId) {
    renderSubagentTranscript(event.data.transcript as SubagentTranscript);
  }
  if (event.data?.type === 'headerAction') {
    switch (event.data.action) {
      case 'newChat':
        if (lastState?.chat?.status !== 'running' && lastState?.chat?.phase !== 'finishing' && !lastState?.review?.busy && !lastState?.reviewBusy) newChat();
        break;
      case 'history': chatFocus = 'history'; showHistory(true); break;
      case 'focusChat': focusChat(); break;
      case 'review': send('screen', 'changes'); break;
    }
  }
});
api.postMessage({ type: 'ready' });
