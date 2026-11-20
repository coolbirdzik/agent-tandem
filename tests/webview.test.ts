// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { panelHtml } from '../src/host/panel-html';
import type { ViewState } from '../src/core/types';
import { agentQuestions } from '../src/providers/chat';
const resources = { script: '/webview.js', style: '/panel.css', icons: '/codicon.css', claude: '/claude.svg', codex: '/codex.svg', cspSource: 'https://test.invalid', nonce: 'nonce' };
const postMessage = vi.fn();
const setState = vi.fn();
const listeners: Array<{ type: string; listener: EventListenerOrEventListenerObject }> = [];
const conversation = { key: 'Claude:c1', id: 'c1', provider: 'Claude' as const, title: 'Fix login', cwd: '/project', updatedAt: 1, revision: '1' };
const currentConversationCaptures = [{ from: 1, to: 2, conversations: [conversation] }];
const state: ViewState = { sessions: [], running: false, providers: [], project: '/project', projectName: 'project', screen: 'conversations',
  conversations: [conversation, { ...conversation, provider: 'Codex', key: 'Codex:c2', id: 'c2' }],
  conversation: { conversation, messages: [{ id: 'a1', role: 'assistant', text: 'Hello <script>bad()</script>' }, { id: 't1', role: 'tool', toolName: 'Edit', text: '{"file":"login.ts"}' }] } };
const render = (value: ViewState) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: value } }));
const headerAction = (action: string) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'headerAction', action } }));
beforeEach(async () => {
  vi.resetModules(); postMessage.mockClear(); setState.mockClear();
  document.write(panelHtml(resources).replace(/<link[^>]+>/g, '').replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''));
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage, setState, getState: () => ({
    drafts: [['/project:Claude:c1', 'Old restored message']],
    edits: [['/project:Claude:c1', { messageId: 'u1', revision: '1', previousDraft: 'Old draft' }]],
  }) }));
  const addEventListener = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => { listeners.push({ type, listener }); addEventListener(type, listener, options); });
  await import('../src/webview.js');
});
afterEach(() => { for (const item of listeners.splice(0)) window.removeEventListener(item.type, item.listener); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
describe('Single tandem webview', () => {
  it('keeps history rows, messages, selection and quota attached across refetches with identical data', () => {
    const value: ViewState = { ...state, syncedAt: 1, accounts: { Claude: { status: 'ready', updatedAt: 1,
      quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 20 }] } } } };
    render(value);
    const row = document.querySelector<HTMLButtonElement>('.conversation-link')!;
    const message = document.querySelector('.message')!;
    const heading = document.querySelector('#panel-title')!;
    const filter = document.querySelector('.history-filters button span')!;
    const summary = document.querySelector<HTMLButtonElement>('.account-summary')!;
    summary.click();
    const meter = document.querySelector('.account-popover progress')!;
    const refresh = document.querySelector<HTMLButtonElement>('[data-account-refresh]')!;
    const range = document.createRange(); range.selectNodeContents(message.querySelector('.message-text')!);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    const selectionNode = window.getSelection()!.anchorNode;
    const mutations = new MutationObserver(() => undefined);
    mutations.observe(document.getElementById('conversations')!, { childList: true, subtree: true });
    render({ ...structuredClone(value), syncing: true, accounts: { Claude: { ...value.accounts!.Claude!, status: 'loading', quotaCached: true } } });
    expect(document.querySelector('.conversation-link')).toBe(row);
    expect(document.querySelector('.message')).toBe(message);
    expect(document.querySelector('.history-filters button span')).toBe(filter);
    expect(document.querySelector('.account-summary')).toBe(summary);
    expect(summary.textContent).toContain('\uE030 80%');
    expect(summary.querySelector('.quota-window-badge')?.getAttribute('aria-label')).toBe('5h');
    expect(document.querySelector('.account-popover progress')).toBe(meter);
    expect(document.querySelector('[data-account-refresh]')).toBe(refresh);
    expect(refresh.disabled).toBe(true);
    expect(window.getSelection()!.anchorNode).toBe(selectionNode);
    render({ ...structuredClone(value), syncedAt: 2, accounts: { Claude: { ...value.accounts!.Claude!, updatedAt: 2 } } });
    expect(document.querySelector('.account-summary')).toBe(summary);
    expect(refresh.disabled).toBe(false);
    render({ ...value, conversation: { ...value.conversation!, conversation: { ...conversation, revision: 'metadata-only' } } });
    expect(document.querySelector('.message')).toBe(message);
    expect(document.querySelector('#panel-title')).toBe(heading);
    expect(mutations.takeRecords()).toHaveLength(0);
    const ring = summary.querySelector('.quota-ring-value');
    render({ ...value, accounts: { Claude: { ...value.accounts!.Claude!, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 30 }] } } } });
    expect(document.querySelector('.account-summary')).toBe(summary);
    expect(summary.querySelector('.quota-ring-value')).toBe(ring);
    expect(summary.textContent).toContain('\uE030 70%');
    expect(ring!.getAttribute('stroke-dasharray')).toBe('70 100');
    mutations.disconnect(); window.getSelection()!.removeAllRanges();
  });

  it('updates changed history and messages while retaining unaffected rows and expanded tools', () => {
    render(state);
    const row = document.querySelector<HTMLButtonElement>('.conversation-link')!;
    const tool = document.querySelector<HTMLDetailsElement>('.message details')!; tool.open = true;
    const toolMessage = tool.closest('.message');
    const updated: ViewState = { ...state,
      conversations: [{ ...conversation, title: 'Renamed conversation', revision: '2' }, state.conversations![1]!],
      conversation: { ...state.conversation!, conversation: { ...conversation, revision: '2' },
        messages: [{ ...state.conversation!.messages[0]!, text: 'Updated answer' }, state.conversation!.messages[1]!, { id: 'new', role: 'assistant', text: 'New answer' }] } };
    render(updated);
    expect(document.querySelector('.conversation-link')).toBe(row);
    expect(row.textContent).toContain('Renamed conversation');
    expect(row.querySelector<HTMLElement>('.conversation-title')?.title).toBe('Renamed conversation');
    expect(document.querySelector('[data-message-id="a1"]')!.textContent).toContain('Updated answer');
    expect(document.querySelector('[data-message-id="t1"]')).toBe(toolMessage);
    expect(tool.open).toBe(true);
    expect(document.querySelectorAll('.message')).toHaveLength(3);
    render({ ...updated, conversations: [updated.conversations![0]!], conversation: { ...updated.conversation!, conversation: { ...conversation, revision: '3' }, messages: [updated.conversation!.messages[0]!] } });
    expect(document.querySelectorAll('.conversation-link')).toHaveLength(1);
    expect(document.querySelectorAll('.message')).toHaveLength(1);
    expect(toolMessage!.isConnected).toBe(false);
  });

  it('groups chat by local day, keeps tools within their day, and exposes recorded message times', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 10, 20, 12));
      const beforeMidnight = new Date(2026, 10, 19, 23, 59);
      const afterMidnight = new Date(2026, 10, 20, 0, 1);
      const content: NonNullable<ViewState['conversation']> = { conversation, messages: [
        { id: 'u1', role: 'user', text: 'Fix login', timestamp: beforeMidnight.toISOString() },
        { id: 't1', role: 'tool', text: 'Started', timestamp: beforeMidnight.toISOString() },
        { id: 't2', role: 'tool', text: 'Finished', timestamp: afterMidnight.toISOString() },
        { id: 'a1', role: 'assistant', text: 'Fixed', timestamp: afterMidnight.toISOString() },
        { id: 'legacy', role: 'assistant', text: 'Legacy message', timestamp: 'invalid' },
      ] };
      const value = { ...state, conversation: content };
      render(value);
      const rows = () => [...document.querySelectorAll<HTMLElement>('#conversation > *')];
      expect(rows().map(row => row.dataset.messageId ?? row.dataset.firstToolId ?? row.textContent)).toEqual([
        'Yesterday', 'u1', 't1', 'Today', 'a1', 't2', 'legacy',
      ]);
      const [divider, user] = rows();
      const format = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
      const userTime = user?.querySelector<HTMLTimeElement>('.message-actions > time');
      expect(userTime?.textContent).toBe(format.format(beforeMidnight));
      expect(userTime?.dateTime).toBe(beforeMidnight.toISOString());
      expect(userTime?.nextElementSibling?.classList.contains('message-restore')).toBe(true);
      expect(document.querySelector('[data-message-id="a1"] .message-author > time')?.textContent).toBe(format.format(afterMidnight));
      expect(document.querySelector('[data-message-id="t2"] summary > time')?.textContent).toBe(format.format(afterMidnight));
      expect(document.querySelector('[data-message-id="legacy"] time')).toBeNull();
      expect(document.querySelector('#conversation .message[title]')).toBeNull();

      vi.setSystemTime(new Date(2026, 10, 21, 0, 1));
      render(value);
      expect(rows()[0]).toBe(divider);
      expect(rows()[0]?.textContent).toBe('2 days ago');
      expect(rows()[1]).toBe(user);
      expect(rows()[3]?.textContent).toBe('Yesterday');
    } finally { vi.useRealTimers(); }
  });

  it('groups history by local day and restores section expansion after searching', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 10, 20, 12));
      const today = { ...conversation, updatedAt: new Date(2026, 10, 20, 0, 1).getTime() };
      const recent = { ...state.conversations![1]!, title: 'Fix lint', updatedAt: new Date(2026, 10, 20, 9).getTime() };
      const yesterday = { ...conversation, key: 'Claude:older', title: 'Review history', updatedAt: new Date(2026, 10, 19, 23, 59).getTime() };
      const value = { ...state, conversations: [recent, today, yesterday] };
      render(value);
      headerAction('history');
      const sections = () => [...document.querySelectorAll<HTMLDetailsElement>('#conversations > details')];
      const [first, second] = sections();
      expect(sections().map(section => section.querySelector('summary')!.getAttribute('aria-label'))).toEqual(['Today, 2 conversations', 'Yesterday, 1 conversation']);
      expect(first!.open).toBe(true);
      expect(second!.open).toBe(false);
      expect([...first!.querySelectorAll('.conversation-title')].map(title => title.textContent)).toEqual(['Fix lint', 'Fix login']);

      first!.open = false;
      render(structuredClone(value));
      expect(sections()[0]).toBe(first);
      expect(first!.open).toBe(false);

      const search = document.querySelector<HTMLInputElement>('#conversation-search')!;
      search.value = 'Review history';
      search.dispatchEvent(new Event('input'));
      expect(sections()).toEqual([second]);
      expect(second!.open).toBe(true);
      search.value = '';
      search.dispatchEvent(new Event('input'));
      expect(sections().map(section => section.open)).toEqual([false, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes native title actions through the existing chat, history and review behavior', () => {
    const selector = '#new-chat, #history-open, button[data-screen="changes"]';
    expect(document.querySelectorAll(selector)).toHaveLength(0);
    const tab = new DOMParser().parseFromString(panelHtml(resources, true), 'text/html');
    expect(tab.querySelectorAll(selector)).toHaveLength(3);
    render({ ...state, reviewBusy: true });
    postMessage.mockClear();
    headerAction('newChat');
    expect(postMessage).not.toHaveBeenCalled();
    render(state);
    headerAction('newChat');
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'newChat', selection: 'Claude' });
    headerAction('history');
    expect(document.querySelector<HTMLElement>('#history-view')!.hidden).toBe(false);
    expect(document.activeElement?.id).toBe('conversation-search');
    const originalDraft = document.querySelector<HTMLTextAreaElement>('#chat-input')!.value;
    postMessage.mockClear();
    headerAction('focusChat');
    expect(document.querySelector<HTMLElement>('#history-view')!.hidden).toBe(true);
    expect(document.activeElement?.id).toBe('chat-input');
    expect(document.querySelector<HTMLTextAreaElement>('#chat-input')!.value).toBe(originalDraft);
    expect(postMessage).not.toHaveBeenCalled();
    render({ ...state, screen: 'changes' });
    headerAction('focusChat');
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'screen', selection: 'conversations' });
    render(state);
    expect(document.activeElement?.id).toBe('chat-input');
    headerAction('review');
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'screen', selection: 'changes' });
    expect(document.querySelector<HTMLButtonElement>('#history-refresh')?.hidden).toBe(true);
    expect(document.body.dataset.editorTab).toBe('false');
    expect(panelHtml(resources, true)).toContain('data-editor-tab="true"');
  });

  it('places refresh last in the Conversations, Review, and Manage CLIs headers', () => {
    const header = document.querySelector('.header-actions')!;
    const refresh = (id: string) => header.querySelector<HTMLButtonElement>(`#${id}-refresh`)!;
    const visibleRefresh = () => Array.from(header.querySelectorAll('.header-refresh:not([hidden])'));
    const lastAction = () => Array.from(header.querySelectorAll('button:not([hidden])')).at(-1);
    render(state);
    expect(visibleRefresh()).toEqual([]);
    headerAction('history');
    expect(visibleRefresh()).toEqual([refresh('history')]);
    expect(lastAction()).toBe(refresh('history'));
    refresh('history').click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'refreshConversations', selection: undefined });
    render({ ...state, syncing: true });
    expect(refresh('history').disabled).toBe(true);
    render({ ...state, screen: 'changes' });
    expect(visibleRefresh()).toEqual([refresh('review')]);
    expect(lastAction()).toBe(refresh('review'));
    render({ ...state, screen: 'cli' });
    expect(visibleRefresh()).toEqual([refresh('cli')]);
    expect(lastAction()).toBe(refresh('cli'));
    refresh('cli').click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'refreshCLIs', selection: undefined });

    const tab = new DOMParser().parseFromString(panelHtml(resources, true), 'text/html');
    for (const [section, id] of [['history-view', 'history'], ['screen-changes', 'review'], ['screen-cli', 'cli']]) {
      expect(tab.querySelector(`#${section} > .section-heading`)?.lastElementChild?.id).toBe(`${id}-refresh`);
    }
  });

  it('shows the workspace pending-file count beside Review with a keyboard-accessible tooltip', () => {
    const file = { path: 'source.ts', kind: 'modified' as const, binary: false };
    const review = { revision: 'r1', busy: false, files: [
      { ...file, captures: currentConversationCaptures },
      { ...file, path: 'unassigned.ts' },
    ] };
    render({ ...state, review });
    const count = document.querySelector<HTMLElement>('.sidebar-heading #review-count')!;
    expect(count.hidden).toBe(true);
    render({ ...state, screen: 'changes', review });
    expect(count.hidden).toBe(false);
    expect(count.textContent).toBe('2');
    expect(count.title).toBe('Number of files with pending changes in this workspace');
    expect(count.tabIndex).toBe(0);
    expect(document.querySelector('#conversation-changes .changes-toolbar .meta')).toBeNull();
    render({ ...state, screen: 'changes', review: { ...review, files: [] } });
    expect(count.textContent).toBe('0');
    render({ ...state, screen: 'conversations', review });
    expect(count.hidden).toBe(true);

    const tab = new DOMParser().parseFromString(panelHtml(resources, true), 'text/html');
    expect(tab.querySelector('#screen-changes .section-heading h2 + #review-count')?.getAttribute('title')).toBe(count.title);
  });

  it('offers scoped conversation links for script and binary changes and labels removable manual links', () => {
    const names = ['media/provider-icons.ttf', 'media/screenshots/preferences.png', 'tests/quota-status-bar.test.ts', 'tests/settings.test.ts', 'tests/status-bar-preferences.test.ts'];
    const review = { revision: 'scripts', busy: false, files: names.map((name, i) => ({ path: name, kind: 'modified' as const, binary: i < 2 })) };
    render({ ...state, screen: 'changes', review });
    const group = document.querySelector<HTMLElement>('[data-group="unassigned"]')!;
    [...group.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Link to conversation')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'linkReviewConversation', selection: { project: '/project', revision: 'scripts', group: 'unassigned' } });
    group.querySelector<HTMLButtonElement>('[aria-label="Link to conversation: media/provider-icons.ttf"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'linkReviewConversation', selection: { project: '/project', revision: 'scripts', group: 'unassigned', file: names[0] } });
    const linked = { ...review, revision: 'linked', files: review.files.map(file => ({ ...file, captures: [{ from: 1, to: 2, conversations: [conversation], assignment: 'manual' as const }] })) };
    render({ ...state, screen: 'changes', review: linked });
    expect(document.querySelector('[data-group="unassigned"]')).toBeNull();
    expect(document.querySelector('.conversation-change-caption')!.textContent).toContain('Includes manual links');
    document.querySelector<HTMLButtonElement>('[aria-label="Remove manual link: media/provider-icons.ttf"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'unlinkReviewConversation', selection: { project: '/project', revision: 'linked', group: conversation.key, file: names[0] } });
    render({ ...state, screen: 'changes', review: linked, reviewBusy: true });
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Remove manual link: media/provider-icons.ttf"]')!.disabled).toBe(true);
  });
  it('shows banked resets in the quota summary, hover and account popover and removes stale account data', () => {
    const expiresAt = Date.parse('2026-11-01T00:00:00Z');
    const codexState = { ...state, conversation: { conversation: state.conversations![1]!, messages: [] } };
    render({ ...codexState, accounts: { Codex: { status: 'ready', quota: { status: 'available', windows: [], bankedResets: { availableCount: 2, credits: [{ title: 'Full reset', expiresAt }] } } } } });
    const summary = document.querySelector<HTMLButtonElement>('[data-account-provider="Codex"]')!;
    expect(summary.textContent).toContain('2 resets');
    expect(summary.title).toContain('Banked resets: 2 available');
    expect(summary.title).toContain(`Expires ${new Date(expiresAt).toLocaleString()}`);
    summary.click();
    expect(document.querySelector('.account-popover')!.textContent).toContain('Banked resets: 2 available');
    expect(document.querySelector('.account-popover')!.textContent).toContain(`Expires ${new Date(expiresAt).toLocaleString()}`);
    render({ ...codexState, accounts: { Codex: { status: 'ready', quota: { status: 'available', windows: [], bankedResets: { availableCount: 0, credits: [] } } } } });
    expect(document.querySelector('.account-popover')!.textContent).toContain('Banked resets: 0 available');
    expect(document.querySelector('.account-popover')!.textContent).not.toContain('Full reset');
    expect(document.querySelector('.account-summary')!.textContent).not.toContain('2 resets');
  });
  it('previews a scoped Revert, blocks a stale confirmation and exposes Undo even with no pending files', () => {
    const file = { path: 'source.ts', kind: 'modified' as const, binary: false };
    const review = { revision: 'r1', busy: false, externalTracking: true, files: [file] };
    render({ ...state, screen: 'changes', review });
    document.querySelector<HTMLButtonElement>('#conversation-changes [aria-label="Revert source.ts"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewRevert', selection: { project: '/project', revision: 'r1', file: 'source.ts', group: 'unassigned' } });
    const revertPreview = { token: 'preview-token', request: { project: '/project', revision: 'r1', file: 'source.ts', group: 'unassigned' }, files: [file] };
    render({ ...state, screen: 'changes', review, revertPreview });
    const dialog = document.querySelector<HTMLDialogElement>('dialog#revert-preview')!;
    expect(dialog.open).toBe(true);
    expect(document.querySelectorAll('#revert-preview .revert-scope li')).toHaveLength(1);
    document.querySelector<HTMLButtonElement>('[data-focus-key="confirm-revert"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'confirmRevert', selection: { token: 'preview-token' } });
    render({ ...state, screen: 'changes', review, revertPreview, error: 'Save or close the dirty editor before reverting.' });
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('dirty editor');
    render({ ...state, screen: 'changes', review: { ...review, revision: 'r2' }, revertPreview });
    expect(document.querySelector<HTMLButtonElement>('[data-focus-key="confirm-revert"]')!.disabled).toBe(true);
    expect(document.querySelector('#revert-preview')!.textContent).toContain('Changes updated');
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'cancelRevert', selection: undefined });
    render({ ...state, screen: 'changes', review: { ...review, files: [], undo: { id: 'undo', createdAt: 1, files: ['source.ts'] } } });
    document.querySelector<HTMLButtonElement>('[data-focus-key="undo-revert"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'undoRevert', selection: { project: '/project', id: 'undo' } });
    expect(dialog.open).toBe(false);
    expect(document.querySelector<HTMLElement>('#chat-composer')!.hidden).toBe(true);
  });
  it('collapses conversation groups across passive updates and opens the latest native diff on demand', () => {
    const review = { revision: 'r1', busy: false, files: [{ path: 'source.ts', kind: 'modified' as const, binary: false }] };
    render({ ...state, screen: 'changes', review });
    document.querySelector<HTMLButtonElement>('.conversation-change-heading')!.click();
    expect(document.querySelector<HTMLElement>('.conversation-change-body')!.hidden).toBe(true);
    expect(setState).toHaveBeenLastCalledWith({ reviewCollapsed: false, collapsedReviewGroups: ['/project:unassigned'] });
    render({ ...state, screen: 'changes', review: { ...review, revision: 'r2' } });
    expect(document.querySelector<HTMLButtonElement>('.conversation-change-heading')!.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector<HTMLElement>('.conversation-change-body')!.hidden).toBe(true);
    [...document.querySelectorAll<HTMLButtonElement>('.changes-toolbar button')].find(button => button.textContent === 'Review latest')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'reviewLatest', selection: undefined });
    document.querySelector<HTMLButtonElement>('.conversation-change-heading')!.click();
    expect(document.querySelector<HTMLElement>('.conversation-change-body')!.hidden).toBe(false);
  });
  it('shows conversation groups on Changes even when the chat review is collapsed, with scoped native diff actions', () => {
    const codex = state.conversations![1]!;
    const capture = (...conversations: NonNullable<ViewState['conversations']>) => [{ from: 1, to: 2, conversations }];
    const review = { revision: 'groups', busy: false, externalTracking: true, files: [
      { path: 'claude.ts', kind: 'modified' as const, binary: false, captures: capture(conversation) },
      { path: 'codex.ts', kind: 'added' as const, binary: false, captures: capture(codex) },
      { path: 'shared.ts', kind: 'modified' as const, binary: false, captures: capture(conversation, codex) },
      { path: 'manual.ts', kind: 'modified' as const, binary: false },
    ] };
    render({ ...state, review });
    expect(document.querySelectorAll('#pending-changes .review-file-link')).toHaveLength(1);
    expect(document.querySelector('#pending-changes .review-file-link')!.textContent).toBe('claude.ts');
    for (const [label, icon] of [['Accept', 'check'], ['Revert', 'discard']]) {
      const action = document.querySelector<HTMLButtonElement>(`#pending-changes [aria-label="${label} claude.ts"]`)!;
      expect(action.textContent).toBe('');
      expect(action.title).toBe(`${label} claude.ts`);
      expect(action.querySelector(`.codicon-${icon}`)).not.toBeNull();
    }
    document.querySelector<HTMLButtonElement>('#review-toggle')!.click();
    headerAction('history');
    expect(document.querySelector<HTMLElement>('#history-view')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#pending-changes')!.hidden).toBe(true);
    render({ ...state, review, screen: 'changes' });
    expect(document.querySelector<HTMLElement>('#pending-changes')!.hidden).toBe(true);
    expect(document.querySelectorAll('#conversation-changes .review-file-link')).toHaveLength(4);
    document.querySelector<HTMLButtonElement>('[data-focus-key="workspace-review:acceptChanges"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'acceptChanges', selection: { project: '/project', revision: 'groups' } });
    document.querySelector<HTMLButtonElement>('[data-focus-key="workspace-review:previewRevert"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewRevert', selection: { project: '/project', revision: 'groups' } });
    document.querySelector<HTMLButtonElement>('[data-focus-key="workspace-review:previewReview"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewReview', selection: { project: '/project', revision: 'groups' } });
    render({ ...state, review, screen: 'changes', reviewBusy: true });
    expect(document.querySelector<HTMLButtonElement>('[data-focus-key="workspace-review:acceptChanges"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-focus-key="workspace-review:previewRevert"]')!.disabled).toBe(true);
    render({ ...state, review, screen: 'changes' });
    const group = document.querySelector<HTMLElement>(`#conversation-changes [data-group="${conversation.key}"]`)!;
    expect(group.querySelector('.conversation-change-caption')!.textContent).toBe('Current conversation');
    expect(document.querySelector(`[data-group="${codex.key}"] .conversation-change-caption`)).toBeNull();
    expect(document.querySelector('#conversation-changes [data-group="shared"]')!.textContent).toContain('shared.ts');
    expect(document.querySelector('#conversation-changes [data-group="unassigned"]')!.textContent).toContain('manual.ts');
    group.querySelector<HTMLButtonElement>('.review-file-link')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewReview', selection: { project: '/project', revision: 'groups', file: 'claude.ts', group: conversation.key } });
    for (const [label, icon, type] of [['Revert', 'discard', 'previewRevert'], ['Accept', 'check', 'acceptChanges']]) {
      const action = group.querySelector<HTMLButtonElement>(`button[aria-label="${label} claude.ts"]`)!;
      expect(action.title).toBe(`${label} claude.ts`);
      expect(action.textContent).toBe('');
      expect(action.querySelector(`.codicon-${icon}[aria-hidden="true"]`)).not.toBeNull();
      action.click();
      expect(postMessage).toHaveBeenLastCalledWith({ type, selection: { project: '/project', revision: 'groups', file: 'claude.ts', group: conversation.key } });
    }
    [...group.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Accept group')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'acceptChanges', selection: { project: '/project', revision: 'groups', group: conversation.key } });
    const heading = group.querySelector<HTMLButtonElement>('.conversation-change-heading')!;
    const open = group.querySelector<HTMLButtonElement>('.conversation-change-header > button[aria-label="Open conversation"]')!;
    expect(open.title).toBe('Open conversation');
    expect(open.textContent).toBe('');
    expect(open.querySelector('.codicon-comment-discussion[aria-hidden="true"]')).not.toBeNull();
    heading.click();
    open.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'conversation', selection: conversation.key });
    expect(heading.getAttribute('aria-expanded')).toBe('false');
    const opened = { ...state, review, conversationOpenRevision: 1 };
    render(opened);
    expect(document.querySelector<HTMLElement>('#history-view')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#thread-view')!.hidden).toBe(false);
    expect(document.querySelector('#conversation')!.textContent).toContain('Hello');
    headerAction('history');
    render({ ...opened, syncing: true });
    expect(document.querySelector<HTMLElement>('#history-view')!.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('#sidebar-navigation')!.click();
    render({ ...opened, conversation: { conversation: codex, messages: [] } });
    expect(document.querySelector('#pending-changes .review-file-link')!.textContent).toBe('codex.ts');
    document.querySelector<HTMLButtonElement>('#pending-changes [aria-label="Accept all pending changes"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'acceptChanges', selection: { project: '/project', revision: 'groups', group: codex.key } });
  });
  it('shows a Review empty state and keeps other conversations out of chat', () => {
    render({ ...state, screen: 'changes', review: { revision: 'empty', busy: false, externalTracking: true, files: [] } });
    expect(document.querySelector('#conversation-changes')!.textContent).toContain('No pending changes');
    expect(document.querySelector('#conversation-changes')!.textContent).toContain('before tracking started');
    expect(document.querySelector<HTMLButtonElement>('[data-focus-key="workspace-review:acceptChanges"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-focus-key="workspace-review:previewRevert"]')!.disabled).toBe(true);
    const other = state.conversations![1]!;
    const review = { revision: 'other', busy: false, files: [{ path: 'other.ts', kind: 'modified' as const, binary: false, captures: [{ from: 1, to: 2, conversations: [other] }] }] };
    render({ ...state, review });
    expect(document.querySelector<HTMLElement>('#pending-changes')!.hidden).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('#review-toggle')!.disabled).toBe(true);
    expect(document.querySelectorAll('#pending-changes .review-file')).toHaveLength(0);
    expect(document.querySelector('#pending-changes .review-actions button')).toBeNull();
    render({ ...state, review, screen: 'changes' });
    expect(document.querySelector('#conversation-changes .review-file-link')?.textContent).toBe('other.ts');
  });
  it('shows the accordion with the composer, including in new chats', () => {
    const review = { revision: 'r1', busy: false, files: [{ path: 'source.ts', kind: 'modified' as const, binary: false, captures: [{ from: 1, to: 2, conversations: [conversation] }] }] };
    const pending = document.querySelector<HTMLElement>('#pending-changes')!;
    const toggle = document.querySelector<HTMLButtonElement>('#review-toggle')!;
    expect(pending.hidden).toBe(false);
    expect(toggle.disabled).toBe(true);
    expect(toggle.textContent).toBe('0 files pending review');
    expect(pending.querySelector('.review-actions button')).toBeNull();
    render({ ...state, review });
    expect(pending.hidden).toBe(false);
    expect(toggle.disabled).toBe(false);
    render({ ...state, review, screen: 'cli' });
    expect(pending.hidden).toBe(true);
    render({ ...state, review });
    expect(pending.hidden).toBe(false);
    render({ ...state, review, conversation: undefined });
    expect(pending.hidden).toBe(false);
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(pending.querySelector<HTMLElement>('#review-body')!.hidden).toBe(true);
    expect(pending.querySelector('.review-actions button')).toBeNull();
    render({ ...state, review });
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(pending.querySelectorAll('.review-actions button')).toHaveLength(3);
  });
  it('does not resurrect attachments when history is reopened during an asynchronous file read', async () => {
    const readers: Array<{ result: string; onload?: () => void }> = [];
    vi.stubGlobal('FileReader', class { result = 'data:image/png;base64,AQID'; onload?: () => void; readAsDataURL() { readers.push(this); } });
    render(state);
    const drop = new Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['image'], 'old.png', { type: 'image/png' })] } });
    document.getElementById('chat-form')!.dispatchEvent(drop);
    headerAction('history');
    document.querySelector<HTMLButtonElement>('.conversation-link[data-focus-key="Claude:c1"]')!.click(); render(state);
    readers[0]!.onload?.(); await vi.waitFor(() => expect(document.getElementById('attachment-status')!.hidden).toBe(true));
    expect(document.querySelectorAll('#chat-attachments .attachment-card')).toHaveLength(0);
  });
  it('restores attachments after a native failure and edits history without losing the previous draft', async () => {
    const attachment = { name: 'history.png', mimeType: 'image/png', data: 'AQID' };
    const editable = { ...state, conversation: { conversation, messages: [{ id: 'u1', role: 'user' as const, text: 'Describe this', attachments: [attachment] }] } };
    render(editable);
    const drop = new Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['notes'], 'draft.txt', { type: 'text/plain' })] } });
    document.getElementById('chat-form')!.dispatchEvent(drop);
    await vi.waitFor(() => expect(document.querySelector('#chat-attachments')!.textContent).toContain('draft.txt'));
    document.querySelector<HTMLButtonElement>('[data-focus-key="edit:u1"]')!.click();
    expect(document.querySelector('#chat-attachments img')?.getAttribute('alt')).toBe('history.png');
    document.querySelector<HTMLButtonElement>('#chat-edit-cancel')!.click();
    expect(document.querySelector('#chat-attachments')!.textContent).toContain('draft.txt');
    document.querySelector<HTMLButtonElement>('#chat-send')!.click(); const requestId = postMessage.mock.calls.at(-1)![0].selection.requestId;
    const chat = { requestId, provider: 'Claude' as const, status: 'running' as const, conversationKey: 'Claude:c1', prompts: [] };
    render({ ...editable, chat }); expect(document.querySelectorAll('#chat-attachments .attachment-card')).toHaveLength(0);
    render({ ...editable, chat: { ...chat, status: 'failed' }, error: 'Native request failed' });
    expect(document.querySelector('#chat-attachments')!.textContent).toContain('draft.txt');
    expect(document.querySelector<HTMLButtonElement>('#chat-send')!.disabled).toBe(false);
  });
  it('pastes multiple images with preview/removal, sends attachment-only input and clears only after acknowledgement', async () => {
    render(state); const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    const image = new File([new Uint8Array([1, 2, 3])], 'screen.png', { type: 'image/png' });
    const other = new File([new Uint8Array([4, 5, 6])], 'other.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { items: [image, other].map(file => ({ kind: 'file', getAsFile: () => file })), getData: () => '' } });
    input.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(document.querySelectorAll('#chat-attachments img')).toHaveLength(2));
    document.querySelector<HTMLButtonElement>('[aria-label="Remove other.png"]')!.click();
    expect(document.querySelectorAll('#chat-attachments img')).toHaveLength(1);
    expect(document.querySelector<HTMLButtonElement>('#chat-send')!.disabled).toBe(false);
    document.querySelector<HTMLButtonElement>('#chat-send')!.click();
    const sent = postMessage.mock.calls.at(-1)![0].selection;
    expect(sent).toMatchObject({ text: '', attachments: [{ name: 'screen.png', mimeType: 'image/png', data: 'AQID' }] });
    expect(document.querySelectorAll('#chat-attachments img')).toHaveLength(1);
    render({ ...state, chatQueue: { project: '/project', provider: 'Claude', conversationKey: conversation.key, items: [sent] } });
    expect(document.querySelectorAll('#chat-attachments img')).toHaveLength(0); expect(document.querySelectorAll('#chat-queue img')).toHaveLength(1);
  });
  it('drops PDF/files without changing text paste and keeps attachments after a host rejection', async () => {
    render(state); const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    const plain = new Event('paste', { cancelable: true }); Object.defineProperty(plain, 'clipboardData', { value: { items: [], getData: () => 'plain text' } });
    input.dispatchEvent(plain); expect(plain.defaultPrevented).toBe(false);
    const drop = new Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['%PDF'], 'reference.pdf', { type: 'application/pdf' }), new File(['hello'], 'notes.txt', { type: 'text/plain' })] } });
    document.getElementById('chat-form')!.dispatchEvent(drop);
    await vi.waitFor(() => expect(document.querySelectorAll('#chat-attachments .attachment-card')).toHaveLength(2));
    document.querySelector<HTMLButtonElement>('#chat-send')!.click(); render({ ...state, error: 'CLI unavailable' });
    expect(document.querySelectorAll('#chat-attachments .attachment-card')).toHaveLength(2); expect(document.querySelector<HTMLButtonElement>('#chat-send')!.disabled).toBe(false);
  });
  it('opens with an empty composer despite old persisted drafts/edits and clears it when reopening history', () => {
    render(state);
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    expect(input.value).toBe('');
    expect(document.querySelector<HTMLElement>('#chat-edit-banner')!.hidden).toBe(true);
    input.value = 'Current unsent text'; input.dispatchEvent(new Event('input'));
    expect(setState).toHaveBeenLastCalledWith({ reviewCollapsed: false, collapsedReviewGroups: [] });
    render({ ...state, syncing: true }); expect(input.value).toBe('Current unsent text');
    headerAction('history');
    document.querySelector<HTMLButtonElement>('.conversation-link[data-focus-key="Claude:c1"]')!.click();
    render(state); expect(input.value).toBe('');
  });
  it('opens and re-enters a conversation at the bottom while refresh/streaming preserve a reader above it', () => {
    const scroller = document.querySelector<HTMLElement>('.scroll-body')!;
    let scrollTop = 0;
    const height = () => document.querySelector('[data-message-id="a3"]') ? 1200 : 1000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: height },
      scrollTop: { configurable: true, get: () => scrollTop, set: value => { scrollTop = Math.max(0, Math.min(height() - 200, value)); } },
    });
    render(state); expect(scrollTop).toBe(800);
    scrollTop = 150; scroller.dispatchEvent(new Event('scroll'));
    const updated = { ...state, conversation: { ...state.conversation!, conversation: { ...conversation, revision: '2' }, messages: [...state.conversation!.messages, { id: 'a2', role: 'assistant' as const, text: 'New reply' }] } };
    render(updated); expect(scrollTop).toBe(150);
    render({ ...updated, syncing: true }); expect(scrollTop).toBe(150);
    render({ ...updated, screen: 'changes' }); render(updated); expect(scrollTop).toBe(800);
    render({ ...updated, conversation: { ...updated.conversation, conversation: { ...conversation, revision: '3' }, messages: [...updated.conversation.messages, { id: 'a3', role: 'assistant', text: 'Streaming grows the conversation' }] } });
    expect(scrollTop).toBe(1000);
    render({ ...state, conversation: { conversation: state.conversations![1]!, messages: [] } }); expect(scrollTop).toBe(800);
    headerAction('history');
    document.querySelector<HTMLButtonElement>('.conversation-link[data-focus-key="Claude:c1"]')!.click();
    render(state); expect(scrollTop).toBe(800);
  });
  it.each(['Claude', 'Codex'] as const)('queues %s input while running and clears only acknowledged text', provider => {
    const active = { ...conversation, key: `${provider}:c1`, provider };
    const chat = { requestId: 'active', provider, conversationKey: active.key, status: 'running' as const, prompts: [], phase: 'working' as const };
    const value: ViewState = { ...state, conversation: { conversation: active, messages: [] }, chat, review: { revision: 'r', busy: true, files: [] } };
    render(value); const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    input.value = 'Next request'; input.dispatchEvent(new Event('input'));
    expect(document.querySelector<HTMLButtonElement>('#chat-send')!.disabled).toBe(false);
    expect(document.querySelector('#chat-send')!.getAttribute('aria-label')).toBe('Queue message');
    postMessage.mockClear(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const sent = postMessage.mock.calls.at(-1)![0]; expect(sent.type).toBe('sendChat'); expect(sent.selection).toMatchObject({ provider, text: 'Next request', conversationKey: active.key });
    input.value = 'Draft after queue'; input.dispatchEvent(new Event('input'));
    render({ ...value, chatQueue: { project: '/project', provider, conversationKey: active.key, items: [sent.selection] } });
    expect(input.value).toBe('Draft after queue'); expect(document.querySelector('#chat-queue')!.textContent).toContain('1 queued');
    expect(document.querySelector('#chat-queue')!.textContent).toContain('Next request');
  });
  it('edits, removes and resumes queued messages while keeping edit drafts through streaming updates', () => {
    const item = { requestId: 'q', project: '/project', provider: 'Claude' as const, conversationKey: conversation.key, text: 'Queued request' };
    const chatQueue = { project: '/project', provider: 'Claude' as const, conversationKey: conversation.key, items: [item], paused: 'Stopped' };
    const value = { ...state, chatQueue }; render(value);
    document.querySelector<HTMLButtonElement>('#chat-queue [aria-label="Edit queued message"]')!.click();
    const input = document.querySelector<HTMLTextAreaElement>('#chat-queue textarea')!; input.value = 'Changed'; input.dispatchEvent(new Event('input'));
    render({ ...value, syncing: true }); expect(document.querySelector('#chat-queue textarea')).toBe(input); expect(input.value).toBe('Changed');
    document.querySelector<HTMLButtonElement>('#chat-queue [aria-label="Save queued message"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'queueAction', selection: { project: '/project', action: 'edit', id: 'q', text: 'Changed' } });
    document.querySelector<HTMLButtonElement>('#chat-queue [aria-label="Remove queued message"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'queueAction', selection: { project: '/project', action: 'remove', id: 'q' } });
    document.querySelector<HTMLButtonElement>('#chat-queue [aria-label="Resume queued messages"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'queueAction', selection: { project: '/project', action: 'resume' } });
    render({ ...state, project: '/other' }); expect(document.querySelector<HTMLElement>('#chat-queue')!.hidden).toBe(true);
  });
  it('shows only the current provider quota beside context, with identity and all windows in its popover', () => {
    const value: ViewState = { ...state, conversation: { conversation: state.conversations![1]!, messages: [] }, accounts: {
      Codex: { status: 'ready', account: { signedIn: true, email: 'codex@example.test', plan: 'plus', method: 'ChatGPT' }, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 25, resetsAt: 1791580550000 }, { id: '7d', label: '7d', usedPercent: 50 }, { id: 'reserve', label: 'Reserve', usedPercent: 0 }] } },
      Claude: { status: 'ready', account: { signedIn: true, email: 'claude@example.test', plan: 'pro', method: 'Claude account' }, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 100 }] } },
    } };
    render(value);
    expect(document.querySelectorAll('[data-account-provider]')).toHaveLength(1);
    expect(document.querySelector('[data-account-provider="Claude"]')).toBeNull();
    expect(document.querySelector('#provider-accounts')!.textContent).toContain('\uE030 75%');
    expect([...document.querySelectorAll('#provider-accounts .quota-window-badge')].map(badge => badge.getAttribute('aria-label'))).toEqual(['5h', '7d']);
    expect(document.querySelector('.quota-ring-value')!.getAttribute('stroke-dasharray')).toBe('75 100');
    expect(document.querySelector('.quota-mini')!.getAttribute('data-level')).toBe('healthy');
    expect(document.querySelector('#provider-accounts')!.parentElement).toBe(document.querySelector('#chat-context')!.parentElement);
    document.querySelector<HTMLButtonElement>('[data-account-provider="Codex"]')!.click();
    const popover = document.querySelector<HTMLElement>('.account-popover')!;
    expect(popover.hidden).toBe(false); expect(popover.querySelectorAll('progress')).toHaveLength(3);
    expect(popover.textContent).toContain('codex@example.test');
    expect(popover.textContent).toContain('Reserve'); expect(popover.textContent).toContain('Resets');
    postMessage.mockClear(); popover.querySelector<HTMLButtonElement>('[data-account-refresh]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'refreshAccount', selection: { project: '/project', provider: 'Codex' } });
    render({ ...value, accounts: { ...value.accounts, Codex: { ...value.accounts!.Codex!, status: 'loading' } } });
    expect(popover.querySelector<HTMLButtonElement>('[data-account-refresh]')!.disabled).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover.hidden).toBe(true); expect((document.activeElement as HTMLElement).dataset.accountProvider).toBe('Codex');
    document.querySelector<HTMLButtonElement>('[data-account-provider="Codex"]')!.click();
    render({ ...value, conversation: state.conversation });
    expect(popover.hidden).toBe(true);
    expect(document.querySelectorAll('[data-account-provider]')).toHaveLength(1);
    expect(document.querySelector('[data-account-provider="Codex"]')).toBeNull();
    expect(document.querySelector('#provider-accounts')!.textContent).toContain('\uE030 0%');
    document.querySelector<HTMLButtonElement>('[data-account-provider="Claude"]')!.click();
    expect(popover.textContent).toContain('claude@example.test');
    render({ ...value, conversation: undefined, composeProvider: 'Codex' });
    expect(document.querySelector('[data-account-provider="Codex"]')).not.toBeNull();
    expect(document.querySelector('[data-account-provider="Claude"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-account-provider="Codex"]')!.click();
    headerAction('history');
    expect(popover.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#provider-accounts')!.hidden).toBe(true);
  });
  it('clears old identity and quotas on project changes and hides accounts without a local project', () => {
    const codexState = { ...state, conversation: { conversation: state.conversations![1]!, messages: [] } };
    render({ ...codexState, accounts: { Codex: { status: 'ready', account: { signedIn: true, email: 'old@example.test', method: 'ChatGPT' }, quota: { status: 'available', windows: [{ id: '5h', label: '5h', usedPercent: 25 }] } } } });
    document.querySelector<HTMLButtonElement>('[data-account-provider="Codex"]')!.click();
    render({ ...codexState, project: '/other', accounts: { Codex: { status: 'ready', account: { signedIn: false, method: 'Not signed in' }, quota: { status: 'unavailable', windows: [], detail: 'Sign in to view quota.' } } } });
    expect(document.querySelector('#provider-accounts')!.textContent).not.toContain('old@example.test');
    expect(document.querySelector('.account-popover')!.textContent).toContain('Sign in to view quota.');
    expect(document.querySelector('.account-popover')!.querySelectorAll('progress')).toHaveLength(0);
    expect(document.querySelector('#provider-accounts')!.textContent).toContain('Quota —');
    render({ ...state, project: undefined });
    expect(document.querySelector<HTMLElement>('#provider-accounts')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.account-popover')!.hidden).toBe(true);
  });
  it.each(['Claude', 'Codex'] as const)('renders all %s questions with descriptions and sends all selections', provider => {
    const questions = agentQuestions([
      { question: 'How should Accept/Reject appear on each change block?', header: 'Rendering', options: [
        { label: 'CodeLens per hunk (Recommended)', description: "Use CodeLensProvider for the agenttandem-review scheme: one row per hunk '✓ Accept · ✗ Reject · ↓ Next' directly above the change block." },
        { label: 'Keep insets with larger Cursor-style buttons', description: 'Keep webview insets and restyle them as pill buttons with icons.' },
        { label: 'Inset + CodeLens fallback', description: 'Prefer insets when the proposed API is available; otherwise fall back to CodeLens.' },
        { label: 'Render the diff in the panel webview', description: 'Build a custom inline diff in the AgentTandem sidebar.' },
      ], multiSelect: false },
      { question: 'How should Next/Previous buttons work?', header: 'Next/Prev', options: [
        { label: 'Next in the CodeLens row plus shortcuts (Recommended)', description: 'Each hunk includes ↓ Next change, with Alt+Down/Alt+Up keybindings.' },
        { label: 'Labeled toolbar at the top of the file', description: 'Expand ChangeFileBadge into a toolbar.' },
        { label: 'Keep icons and add a labeled status bar item', description: 'Add a Next change ↓ status bar item.' },
      ], multiSelect: false },
      { question: 'Where should per-hunk Accept buttons appear?', header: 'Scope', options: [
        { label: 'Pending review only (Recommended)', description: 'Show Accept/Reject only on diffs of pending changes.' },
        { label: 'Include step and cumulative diffs', description: 'Map to the pending review when the revision still matches.' },
      ], multiSelect: false },
    ]);
    const value: ViewState = { ...state, conversation: { conversation: state.conversations!.find(c => c.provider === provider)!, messages: [] }, chat: { requestId: 'r', provider, status: 'running', prompts: [{ id: 'p', title: 'Agent needs your input', detail: '', questions }] } };
    render(value); postMessage.mockClear();
    const fields = [...document.querySelectorAll<HTMLFieldSetElement>('.agent-question')];
    expect(fields).toHaveLength(3);
    expect(document.querySelectorAll('.question-option')).toHaveLength(9);
    expect(document.querySelector('#agent-prompts')!.textContent).toContain('Use CodeLensProvider');
    expect(document.querySelector('#agent-prompts')!.textContent).toContain('Rendering');
    expect([...document.querySelectorAll('#agent-prompts button')].map(b => b.textContent)).toEqual(['Reply']);
    fields.forEach(field => field.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    render({ ...value, syncing: true });
    expect(document.querySelectorAll('.agent-question input:checked')).toHaveLength(3);
    document.querySelector<HTMLButtonElement>('#agent-prompts button')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'answerAgent', selection: { id: 'p', answers: Object.fromEntries(questions.map(q => [q.id, q.options![0]!.label])) } });
  });
  it('requires an answer for every question and supports free text despite available choices', () => {
    render({ ...state, chat: { requestId: 'r', provider: 'Codex', status: 'running', prompts: [{ id: 'p', title: 'Questions', detail: '', questions: [{ id: 'x', question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }] }] }] } });
    const form = document.querySelector<HTMLFormElement>('.agent-prompt')!, input = form.querySelector<HTMLInputElement>('input[type="text"]')!;
    postMessage.mockClear(); form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(postMessage).not.toHaveBeenCalled(); expect(input.validationMessage).toContain('Choose an option');
    const radio = form.querySelector<HTMLInputElement>('input[type="radio"]')!; radio.click();
    input.value = ' My own answer '; input.dispatchEvent(new Event('input'));
    expect(radio.checked).toBe(false);
    form.querySelector<HTMLButtonElement>('button')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'answerAgent', selection: { id: 'p', answers: { x: 'My own answer' } } });
  });
  it('supports multi-select plus custom text, secret questions and preserves drafts when another prompt changes', () => {
    const prompt = { id: 'p', title: 'Questions', detail: '', questions: [
      { id: 'many', question: 'Choose shortcuts?', multiSelect: true, options: [{ label: 'Alt+Down' }, { label: 'Alt+Y' }] },
      { id: 'secret', question: 'Secret?', isSecret: true },
    ] };
    const chat = { requestId: 'r', provider: 'Claude' as const, status: 'running' as const, prompts: [prompt] };
    render({ ...state, chat });
    document.querySelectorAll<HTMLInputElement>('.agent-question input[type="checkbox"]').forEach(input => input.click());
    const custom = document.querySelector<HTMLInputElement>('.agent-question input[type="text"]')!; custom.value = 'Alt+Up'; custom.dispatchEvent(new Event('input'));
    document.querySelector<HTMLInputElement>('input[type="password"]')!.value = 'private';
    render({ ...state, chat: { ...chat, prompts: [prompt, { id: 'p2', title: 'Allow?', detail: '' }] } });
    expect(document.querySelector<HTMLInputElement>('.agent-question input[type="text"]')).toBe(custom);
    document.querySelector<HTMLButtonElement>('.agent-prompt button')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'answerAgent', selection: { id: 'p', answers: { many: ['Alt+Down', 'Alt+Y', 'Alt+Up'], secret: 'private' } } });
    render({ ...state, chat: { ...chat, prompts: [] } });
    expect(document.querySelector('.agent-prompt')).toBeNull();
  });
  it('toggles Codex Fast mode, keeps pending state through sync and sends it immediately', () => {
    const value: ViewState = { ...state, conversation: undefined, composeProvider: 'Codex', codexFastMode: false };
    render(value); postMessage.mockClear();
    const toggle = document.querySelector<HTMLButtonElement>('#chat-fast-mode')!;
    const chip = document.querySelector<HTMLButtonElement>('#fast-mode-chip')!;
    expect(document.querySelector<HTMLElement>('#fast-mode-field')!.hidden).toBe(false);
    expect(chip.hidden).toBe(true);
    toggle.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'setFastMode', selection: { project: '/project', provider: 'Codex', enabled: true } });
    render({ ...value, syncing: true });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('#model-trigger-label')!.textContent).toBe('Codex default');
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe('');
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    input.value = 'hello'; input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLFormElement>('#chat-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'sendChat', selection: expect.objectContaining({ provider: 'Codex', fastMode: true }) });
    expect(toggle.disabled).toBe(true);
    expect(chip.disabled).toBe(true);
  });
  it('restores Off, hides Fast mode for Claude and clears stale choices on project/error changes', () => {
    const value: ViewState = { ...state, conversation: undefined, composeProvider: 'Codex', codexFastMode: true };
    render(value);
    const toggle = document.querySelector<HTMLButtonElement>('#chat-fast-mode')!;
    const chip = document.querySelector<HTMLButtonElement>('#fast-mode-chip')!;
    expect(chip.hidden).toBe(false);
    chip.focus(); chip.click(); expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'setFastMode', selection: { project: '/project', provider: 'Codex', enabled: false } });
    expect(chip.hidden).toBe(true);
    expect(document.activeElement?.id).toBe('model-trigger');
    expect(document.querySelector<HTMLElement>('#model-popover')!.hidden).toBe(true);
    render({ ...value, codexFastMode: false });
    expect(chip.hidden).toBe(true);
    toggle.click();
    render({ ...value, codexFastMode: false, error: 'Could not save' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    toggle.click();
    render({ ...value, project: '/other', codexFastMode: false });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    render(state);
    expect(document.querySelector<HTMLElement>('#fast-mode-field')!.hidden).toBe(true);
    expect(chip.hidden).toBe(true);
    expect(toggle.disabled).toBe(true);
    postMessage.mockClear();
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    input.value = 'hello'; input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLFormElement>('#chat-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'sendChat', selection: expect.not.objectContaining({ fastMode: expect.anything() }) });
  });
  it.each([{ chat: { requestId: 'r', provider: 'Codex' as const, status: 'running' as const, fastMode: true, prompts: [] } }, { reviewBusy: true }, { cliManager: { busy: true, trusted: true, active: {}, registry: { version: 1, initialized: true, revision: 'r', defaults: { Codex: '', Claude: '' }, entries: [] } } }])('blocks Fast mode changes during an active action', busy => {
    render({ ...state, conversation: undefined, composeProvider: 'Codex', codexFastMode: false, ...busy } as ViewState);
    const toggle = document.querySelector<HTMLButtonElement>('#chat-fast-mode')!;
    expect(toggle.disabled).toBe(true);
    postMessage.mockClear(); toggle.click(); expect(postMessage).not.toHaveBeenCalled();
  });
  it('keeps Restore visible on every user message, enables recorded checkpoints and previews exact targets', () => {
    const value: ViewState = { ...state, conversation: { conversation, messages: [{ id: 'u1', role: 'user', text: 'User <script>bad()</script>\nSecond line' }, { id: 'u2', role: 'user', text: 'Older unrecorded message' }] }, checkpoints: [{ id: 'cp1', messageId: 'u1', createdAt: 100 }], checkpointUndo: { id: 'undo', createdAt: 200 } };
    render(value); postMessage.mockClear();
    expect(document.querySelectorAll('.message-restore')).toHaveLength(2);
    expect(document.querySelector('.message-restore')!.textContent).toBe('Restore code');
    expect(document.querySelector('[data-focus-key="checkpoint:u1"]')!.getAttribute('data-checkpoint-available')).toBe('true');
    const unavailable = document.querySelector<HTMLButtonElement>('[data-focus-key="checkpoint:u2"]')!;
    expect(unavailable.disabled).toBe(true); expect(unavailable.title).toContain('No saved checkpoint');
    expect(document.querySelector('.checkpoint-hint')!.textContent).toContain('while change tracking is on');
    unavailable.click(); expect(postMessage).not.toHaveBeenCalled();
    expect(document.querySelector('.message.user .message-text')!.textContent).toContain('<script>bad()</script>');
    expect(document.querySelector('.message.user script')).toBeNull();
    document.querySelector<HTMLButtonElement>('.message-restore')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewCheckpoint', selection: { project: '/project', id: 'cp1' } });
    const preview = { id: 'cp1', token: 'preview-token', createdAt: 100, undo: false, files: [{ path: 'new.ts', kind: 'deleted' as const, binary: false }, { path: 'removed.bin', kind: 'added' as const, binary: true }] };
    render({ ...value, checkpointPreview: preview });
    expect(document.querySelectorAll('.checkpoint-file')).toHaveLength(2);
    const dialog = document.querySelector<HTMLDialogElement>('dialog#checkpoint-preview')!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('chat history stays available');
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'closeCheckpointPreview', selection: undefined });
    document.querySelector<HTMLButtonElement>('[data-focus-key="confirm-checkpoint"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'restoreCheckpoint', selection: { project: '/project', id: 'cp1', token: 'preview-token' } });
    render({ ...value, checkpointPreview: preview, reviewBusy: true });
    expect(document.querySelector<HTMLButtonElement>('.message-restore')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-focus-key="confirm-checkpoint"]')!.disabled).toBe(true);
    render({ ...value, checkpoints: [{ id: 'cp2', messageId: 'u2', createdAt: 300 }] });
    expect(dialog.open).toBe(false);
    expect(document.querySelector('[data-focus-key="checkpoint:u2"]')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('[data-focus-key="undo-checkpoint"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewCheckpoint', selection: { project: '/project', id: 'undo' } });
  });
  it('shows Restore without host checkpoint data and updates the same conversation when a snapshot arrives', () => {
    const value: ViewState = { ...state, conversation: { conversation, messages: [{ id: 'u1', role: 'user', text: 'Restore this turn' }] } };
    render(value);
    expect(document.querySelector<HTMLButtonElement>('.message-restore')!.disabled).toBe(true);
    expect(document.querySelector('.checkpoint-hint')).not.toBeNull();
    render({ ...value, chat: { requestId: 'u1', provider: 'Claude', status: 'running', phase: 'preparing', prompts: [] } });
    expect(document.querySelector<HTMLButtonElement>('.message-restore')!.title).toContain('Preparing checkpoint');
    expect(document.querySelector('.checkpoint-hint')).toBeNull();
    render({ ...value, checkpoints: [{ id: 'cp1', messageId: 'u1', createdAt: 100 }] });
    expect(document.querySelector<HTMLButtonElement>('.message-restore')!.disabled).toBe(false);
    expect(document.querySelector('.checkpoint-hint')).toBeNull();
  });
  it.each(['Claude', 'Codex'] as const)('shows %s context from actual usage with an explicit unknown cache TTL', provider => {
    render({ ...state, conversation: { conversation: { ...conversation, provider }, messages: [], usage: { usedTokens: 46000, windowTokens: 200000, cachedTokens: 42000 } } });
    expect(document.querySelector('[data-context-label]')!.textContent).toContain('23%');
    expect(document.querySelector('[data-cache-label]')!.textContent).toBe('TTL —');
    expect(document.querySelector<HTMLElement>('[data-cache-label]')!.title).toContain('42,000');
    render({ ...state, conversation: undefined }); expect(document.querySelector('[data-context-label]')!.textContent).toBe('Context —');
  });
  it('counts down reported cache TTL without refreshing on history sync and labels expiry as an estimate', () => {
    vi.useFakeTimers();
    try {
      const usage = { usedTokens: 1000, windowTokens: 200000, cacheTtlMs: 300000, cacheExpiresAt: Date.now() + 65000 };
      const value = { ...state, conversation: { conversation, messages: [], usage } };
      render(value); expect(document.querySelector('[data-cache-label]')!.textContent).toBe('TTL ~1:05');
      vi.advanceTimersByTime(10000); render({ ...value, syncing: true }); expect(document.querySelector('[data-cache-label]')!.textContent).toBe('TTL ~0:55');
      vi.advanceTimersByTime(55000); expect(document.querySelector('[data-cache-label]')!.textContent).toBe('TTL expired');
      render(state); expect(document.querySelector('[data-cache-label]')!.textContent).toBe('TTL —');
    } finally { vi.useRealTimers(); }
  });
  it('opens the reasoning slider in its own popover and keeps the current level in the composer', () => {
    render(effortState); postMessage.mockClear();
    const trigger = document.querySelector<HTMLButtonElement>('#reasoning-trigger')!;
    const popover = document.querySelector<HTMLElement>('#reasoning-popover')!;
    const modelPopover = document.querySelector<HTMLElement>('#model-popover')!;
    const slider = document.querySelector<HTMLInputElement>('#reasoning-slider')!;
    expect(popover.hidden).toBe(true);
    expect(popover.contains(slider)).toBe(true);
    expect(trigger.textContent).toBe('High');
    expect(document.querySelector('.tandem-footer')).toBeNull();
    document.querySelector<HTMLButtonElement>('#model-trigger')!.click();
    expect(modelPopover.hidden).toBe(false);
    trigger.click();
    expect(modelPopover.hidden).toBe(true);
    expect(popover.hidden).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(trigger);
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(slider);
    expect(slider.max).toBe('2'); expect(slider.value).toBe('2');
    slider.value = '1'; slider.dispatchEvent(new Event('input'));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'setReasoningEffort', selection: expect.objectContaining({ effort: 'low' }) });
    expect(document.querySelector('#reasoning-value')!.textContent).toBe('Low');
    expect(trigger.textContent).toBe('Low');
    expect(slider.getAttribute('aria-valuetext')).toBe('Low');
    render({ ...effortState, syncing: true });
    expect(popover.hidden).toBe(false);
    expect(document.activeElement).toBe(slider);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(popover.hidden).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    trigger.click();
    document.querySelector<HTMLButtonElement>('#chat-access-trigger')!.click();
    expect(popover.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#chat-access-options')!.hidden).toBe(false);
  });
  it('invalidates the previous model context/cache estimate before and after the host saves a new model', () => {
    const value = { ...effortState, conversation: { conversation, messages: [], usage: { usedTokens: 1000, windowTokens: 200000, selectedModel: 'sonnet' } } };
    render(value); expect(document.querySelector('[data-context-label]')!.textContent).toBe('Context 1%');
    expect(document.querySelector<HTMLElement>('[data-context-label]')!.title).toContain('1,000');
    const model = document.querySelector<HTMLSelectElement>('#chat-model')!; model.value = 'opus'; model.dispatchEvent(new Event('change'));
    expect(document.querySelector('[data-context-label]')!.textContent).toBe('Context —');
    render({ ...value, selectedModels: { Codex: '', Claude: 'opus' } });
    expect(document.querySelector('[data-context-label]')!.textContent).toBe('Context —');
  });
  const cliState: ViewState = { ...state, screen: 'cli', cliManager: { trusted: true, busy: false, active: { Codex: { id: 'cx', source: 'project' }, Claude: { id: 'cl', source: 'path' } }, registry: { version: 1, initialized: true, revision: 'cli1', defaults: { Codex: 'cx', Claude: '' }, entries: [
    { id: 'cx', provider: 'Codex', name: 'My Codex', executable: 'C:/cli/codex.exe', version: '1.0', enabled: true },
    { id: 'cl', provider: 'Claude', name: 'My Claude', executable: 'C:/cli/claude.exe', version: '2.0', enabled: false },
  ] } } };
  it('manages both providers, disables unavailable choices and sends per-project/default selections', () => {
    render(cliState); postMessage.mockClear();
    expect(document.getElementById('screen-cli')!.hidden).toBe(false); expect(document.getElementById('chat-composer')!.hidden).toBe(true);
    expect(document.querySelectorAll('.cli-entry')).toHaveLength(2);
    expect([...document.querySelectorAll('select[id^="cli-default-"]')].map(select => select.getAttribute('aria-label'))).toEqual(['Default', 'Default']);
    expect(document.querySelector('[data-cli-id="cx"] .cli-entry-heading > .meta')!.textContent).toBe('In use · Default · Enabled');
    const claude = document.querySelector<HTMLSelectElement>('#cli-project-Claude')!;
    for (const id of ['cli-default-Claude', 'cli-project-Claude']) {
      expect(document.querySelector(`#${id} option[value="cl"]`)).toMatchObject({ textContent: 'My Claude', disabled: true });
    }
    expect(claude.selectedOptions[0]).toMatchObject({ value: 'path', textContent: 'Using terminal PATH', disabled: true });
    expect(claude.options[0]).toMatchObject({ value: '', textContent: 'Use Default', disabled: false });
    const project = document.querySelector<HTMLSelectElement>('#cli-project-Codex')!;
    expect(project.options[0]!.textContent).toBe('Use Default');
    project.value = ''; project.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'cliAction', selection: expect.objectContaining({ provider: 'Codex', action: 'use', id: '', revision: 'cli1', project: '/project' }) });
    render({ ...cliState, cliManager: { ...cliState.cliManager!, busy: true } }); render(cliState);
    const defaultSelect = document.querySelector<HTMLSelectElement>('#cli-default-Codex')!;
    defaultSelect.value = ''; defaultSelect.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'cliAction', selection: expect.objectContaining({ action: 'default', id: '' }) });
  });
  it.each([
    ['/usr/local/bin/codex', 'Global installation', 'terminal-compact'],
    ['/home/user/.vscode/extensions/openai.chatgpt-1.0/bin/codex', 'VS Code extension', 'extensions'],
    ['/home/user/.cursor/extensions/openai.chatgpt-1.0/bin/codex', 'Cursor extension', 'extensions'],
    ['/custom/bin/codex', 'Local executable', undefined],
  ])('shows the installation origin for %s in the CLI row heading', (executable, label, icon) => {
    const manager = cliState.cliManager!;
    const registry = { ...manager.registry, entries: [{ ...manager.registry.entries[0]!, executable }] };
    render({ ...cliState, cliManager: { ...manager, registry } });
    const identity = document.querySelector('[data-cli-id="cx"] .cli-entry-identity')!;
    expect(identity.querySelector('.cli-entry-version')!.textContent).toBe('1.0');
    expect(identity.querySelector('.meta')!.textContent).toBe(label);
    const glyph = identity.querySelector('.codicon');
    if (icon) {
      expect(glyph).toBe(identity.firstElementChild);
      expect(glyph!.classList.contains(`codicon-${icon}`)).toBe(true);
      expect(glyph!.getAttribute('aria-hidden')).toBe('true');
    } else {
      expect(glyph).toBeNull();
    }
  });
  it.each([
    { provider: 'Codex', executable: '/editor/bin/codex', version: 'codex-cli 0.162.0' },
    { provider: 'Claude', executable: '/editor/bin/claude', version: '2.1.10 (Claude Code)' },
  ])('keeps $provider on Automatic without repeating the selected extension below the dropdowns', ({ provider, executable, version }) => {
    render({ ...cliState, cliManager: { ...cliState.cliManager!, active: { [provider]: { executable, version, source: 'extension' } }, registry: { ...cliState.cliManager!.registry, defaults: { Codex: '', Claude: '' } } } });
    const machine = document.querySelector<HTMLSelectElement>(`#cli-default-${provider}`)!;
    expect(machine.value).toBe('');
    expect(machine.selectedOptions[0]!.textContent).toBe('Automatic');
    expect(document.querySelector<HTMLSelectElement>(`#cli-project-${provider}`)!.value).toBe('');
    expect(machine.closest('.cli-selections')!.nextElementSibling!.matches('.cli-entry')).toBe(true);
    expect(document.querySelector(`#cli-project-${provider} option[value="path"]`)).toBeNull();
  });
  it('keeps an automatic PATH selection in the dropdowns', () => {
    render({ ...cliState, cliManager: { ...cliState.cliManager!, active: { Codex: { executable: '/terminal/codex', version: 'codex-cli 0.150.0', source: 'automatic-path' } }, registry: { ...cliState.cliManager!.registry, defaults: { Codex: '', Claude: '' } } } });
    expect(document.querySelector('.cli-selections')!.nextElementSibling!.matches('.cli-entry')).toBe(true);
    expect(document.querySelector<HTMLSelectElement>('#cli-project-Codex')!.value).toBe('');
    expect(document.querySelector<HTMLSelectElement>('#cli-default-Codex option[value="cx"]')!.textContent).toBe('My Codex');
    expect(document.querySelector<HTMLSelectElement>('#cli-project-Codex option[value="cx"]')!.textContent).toBe('My Codex');
  });
  it('checks the selected CLIs and displays both results in Manage CLIs', () => {
    render(cliState);
    const probe = document.querySelector<HTMLButtonElement>('#screen-cli #probe')!;
    expect(probe.textContent).toBe('Check providers');
    expect(document.getElementById('screen-tools')).toBeNull();
    probe.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'probe', selection: 'inline' });
    render({ ...cliState, checkingProviders: true });
    expect(probe.disabled).toBe(true);
    expect(probe.textContent).toBe('Checking providers…');
    render({ ...cliState, providers: [
      { provider: 'Codex', available: true, executable: '/cli/codex', version: 'codex-cli 0.150.0', detail: 'App-server handshake succeeded.' },
      { provider: 'Claude', available: false, detail: 'Executable unavailable.' },
    ] });
    expect(probe.disabled).toBe(false);
    const results = document.querySelectorAll('#screen-cli #providers article');
    expect(results).toHaveLength(2);
    expect(results[0]!.textContent).toContain('Available · codex-cli 0.150.0');
    expect(results[0]!.textContent).toContain('/cli/codex');
    expect(results[1]!.textContent).toContain('Unavailable');
    expect(results[1]!.textContent).toContain('Executable unavailable.');
  });
  it('keeps selection errors visible beneath the dropdowns', () => {
    const error = 'Selected Codex executable is unavailable.';
    render({ ...cliState, cliManager: { ...cliState.cliManager!, active: { Codex: { id: 'cx', source: 'project', error } } } });
    expect(document.querySelector('.cli-selections + .cli-entry-error')!.textContent).toBe(error);
  });
  it('keeps CLI rows independently expandable across updates and collapses them when reopening Manage CLIs', () => {
    const executable = 'C:/cli/codex.exe';
    render(cliState);
    const row = (id: string) => document.querySelector<HTMLDetailsElement>(`details[data-cli-id="${id}"]`)!;
    const toggle = (id: string) => row(id).querySelector('summary')!.click();
    expect(row('cx').open).toBe(false);
    expect(row('cl').open).toBe(false);
    toggle('cx');
    expect(row('cx').open).toBe(true);
    expect(row('cl').open).toBe(false);
    toggle('cl');
    expect(row('cx').open).toBe(true);
    expect(row('cl').open).toBe(true);
    toggle('cl');
    render({ ...cliState, cliManager: { ...cliState.cliManager!, busy: true } });
    expect(row('cx').open).toBe(true);
    expect(row('cl').open).toBe(false);
    postMessage.mockClear();
    const button = row('cx').querySelector<HTMLButtonElement>('button.cli-path')!;
    expect(button.title).toBe(executable);
    expect(button.textContent).toBe(executable);
    expect(button.getAttribute('aria-label')).toBe(`Copy executable path: ${executable}`);
    button.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'copyCLIPath', selection: executable });
    render({ ...cliState, screen: 'conversations' });
    render(cliState);
    expect(row('cx').open).toBe(false);
    expect(row('cl').open).toBe(false);
  });
  it('requests the native Add wizard for the selected provider', () => {
    render(cliState); postMessage.mockClear();
    const codex = () => document.querySelector<HTMLElement>('[aria-label="Codex CLI installations"]')!;
    expect([...document.querySelectorAll('.cli-group-heading button.primary')].map(button => button.textContent)).toEqual(['Add', 'Add']);
    expect([...codex().querySelectorAll('.cli-group-heading button')].map(button => button.textContent)).toEqual(['Scan', 'Check versions', 'Add']);
    codex().querySelector<HTMLButtonElement>('button.primary')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'cliAction', selection: { provider: 'Codex', action: 'add', revision: 'cli1', project: '/project' } });
    expect(codex().querySelector('form')).toBeNull();
    render({ ...cliState, cliManager: { ...cliState.cliManager!, busy: true } });
    render(cliState);
    const claude = document.querySelector<HTMLElement>('[aria-label="Claude CLI installations"]')!;
    claude.querySelector<HTMLButtonElement>('button.primary')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'cliAction', selection: { provider: 'Claude', action: 'add', revision: 'cli1', project: '/project' } });
    render({ ...cliState, cliManager: { ...cliState.cliManager!, busy: true } });
    render(cliState);
  });
  it('replaces CLI entry details during editing and restores them on Cancel', () => {
    render(cliState); postMessage.mockClear();
    const row = document.querySelector<HTMLElement>('[data-cli-id="cx"]')!;
    row.querySelector('summary')!.click();
    [...row.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Edit')!.click();
    const editingRow = document.querySelector<HTMLDetailsElement>('[data-cli-id="cx"]')!;
    expect(editingRow.open).toBe(true);
    expect(editingRow.querySelector('summary')!.textContent).toContain('In use · Default · Enabled');
    expect(editingRow.querySelector('.cli-path')).toBeNull();
    expect([...editingRow.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Save', 'Cancel']);
    const editName = document.querySelector<HTMLInputElement>('[data-cli-draft="cx:name"]')!; expect(editName.value).toBe('My Codex'); editName.value = 'Changed';
    document.querySelector<HTMLFormElement>('.cli-edit-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'cliAction', selection: expect.objectContaining({ action: 'edit', id: 'cx', name: 'Changed', executable: 'C:/cli/codex.exe' }) });
    render({ ...cliState, error: 'Check failed' });
    expect(document.querySelector<HTMLInputElement>('[data-cli-draft="cx:name"]')!.value).toBe('Changed');
    [...document.querySelectorAll<HTMLButtonElement>('.cli-edit-form button')].find(button => button.textContent === 'Cancel')!.click();
    expect(document.querySelector('.cli-edit-form')).toBeNull();
    expect(document.querySelector('[data-cli-id="cx"] .cli-path')!.textContent).toBe('C:/cli/codex.exe');
    [...document.querySelectorAll<HTMLButtonElement>('[data-cli-id="cx"] button')].find(button => button.textContent === 'Edit')!.click();
    expect(document.querySelector<HTMLInputElement>('[data-cli-draft="cx:name"]')!.value).toBe('My Codex');
  });
  it('locks management during active runs and sends removal as a registry operation', () => {
    render({ ...cliState, chat: { requestId: 'r', provider: 'Codex', status: 'running', prompts: [] } });
    expect([...document.querySelectorAll<HTMLButtonElement>('#cli-manager button:not(.cli-path)')].every(button => button.disabled)).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-cli-id="cx"] button.cli-path')!.disabled).toBe(false);
    render(cliState); postMessage.mockClear();
    document.querySelector<HTMLElement>('[data-cli-id="cl"] summary')!.click();
    [...document.querySelectorAll<HTMLButtonElement>('[data-cli-id="cl"] button')].find(button => button.textContent === 'Remove')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'cliAction', selection: expect.objectContaining({ action: 'remove', provider: 'Claude', id: 'cl' }) });
  });
  it('exposes the CLI behind the model list', () => {
    render({ ...state, modelCatalogs: { Claude: { status: 'ready', choices: [{ id: 'sonnet', label: 'Sonnet' }], cli: { executable: 'C:/cli/claude.exe', version: '2.1.220' } } } });
    expect(document.querySelector<HTMLSelectElement>('#chat-model')!.title).toContain('C:/cli/claude.exe');
    expect(document.querySelector<HTMLButtonElement>('#models-refresh')!.title).toContain('2.1.220');
  });
  const modelState: ViewState = { ...state, selectedModels: { Codex: 'codex-a', Claude: 'sonnet' }, modelCatalogs: {
    Codex: { status: 'ready', choices: [{ id: 'codex-a', label: 'Codex A' }, { id: 'codex-b', label: 'Codex B' }] },
    Claude: { status: 'ready', choices: [{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }] },
  } };
  const effortState: ViewState = { ...modelState, selectedEfforts: { Codex: {}, Claude: { sonnet: 'high', opus: 'max' } }, modelCatalogs: {
    ...modelState.modelCatalogs, Claude: { status: 'ready', choices: [
      { id: 'sonnet', label: 'Sonnet', reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
      { id: 'opus', label: 'Opus', reasoningEfforts: [{ id: 'max', label: 'Max' }] },
    ] },
  } };
  it('opens the model picker from the compact trigger, keeps it open on sync and restores focus on Escape', () => {
    render(effortState);
    const trigger = document.querySelector<HTMLButtonElement>('#model-trigger')!, popover = document.querySelector<HTMLElement>('#model-popover')!;
    expect(popover.hidden).toBe(true); expect(trigger.textContent).toContain('Sonnet');
    trigger.click(); expect(popover.hidden).toBe(false); expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.id).toBe('chat-model-trigger');
    const modelPicker = document.querySelector<HTMLButtonElement>('#chat-model-trigger')!; modelPicker.focus();
    render({ ...effortState, syncing: true }); expect(popover.hidden).toBe(false); expect(document.activeElement).toBe(modelPicker);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover.hidden).toBe(true); expect(document.activeElement).toBe(trigger);
  });
  it('closes the model popover outside, on tab-out and on run start, with locked controls', () => {
    render(effortState);
    const trigger = document.querySelector<HTMLButtonElement>('#model-trigger')!, popover = document.querySelector<HTMLElement>('#model-popover')!;
    trigger.click(); document.querySelector('#thread-heading')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); expect(popover.hidden).toBe(true);
    trigger.click(); document.querySelector<HTMLTextAreaElement>('#chat-input')!.focus(); expect(popover.hidden).toBe(true);
    trigger.click(); render({ ...effortState, chat: { requestId: 'r', provider: 'Claude', model: 'sonnet', status: 'running', prompts: [] } });
    expect(popover.hidden).toBe(true); expect(trigger.disabled).toBe(true); trigger.click(); expect(popover.hidden).toBe(true);
  });
  it('uses model-specific effort choices, preserves pending effort across sync and forwards it on send', () => {
    render(effortState); postMessage.mockClear();
    const select = document.querySelector<HTMLSelectElement>('#chat-effort')!;
    expect([...select.options].map(row => row.value)).toEqual(['', 'low', 'high']); expect(select.value).toBe('high');
    select.focus(); select.value = 'low'; select.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'setReasoningEffort', selection: { project: '/project', provider: 'Claude', model: 'sonnet', effort: 'low' } });
    render({ ...effortState, syncing: true }); expect(select.value).toBe('low'); expect(document.activeElement).toBe(select);
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!; input.value = 'Hello'; input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('#chat-send')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'sendChat', selection: expect.objectContaining({ model: 'sonnet', reasoningEffort: 'low' }) });
  });
  it('restores each model effort and locks/pins the active turn selection', () => {
    render(effortState);
    const model = document.querySelector<HTMLSelectElement>('#chat-model')!, effort = document.querySelector<HTMLSelectElement>('#chat-effort')!;
    model.value = 'opus'; model.dispatchEvent(new Event('change'));
    expect(effort.value).toBe('max'); expect([...effort.options].map(row => row.value)).toEqual(['', 'max']);
    const trigger = document.querySelector<HTMLButtonElement>('#reasoning-trigger')!;
    const popover = document.querySelector<HTMLElement>('#reasoning-popover')!;
    trigger.click();
    expect(popover.hidden).toBe(false);
    render({ ...effortState, chat: { requestId: 'r', provider: 'Claude', model: 'sonnet', reasoningEffort: 'low', status: 'running', prompts: [] } });
    expect(effort.value).toBe('low'); expect(effort.disabled).toBe(true);
    expect(popover.hidden).toBe(true); expect(trigger.disabled).toBe(true);
    const slider = document.querySelector<HTMLInputElement>('#reasoning-slider')!;
    expect(slider.disabled).toBe(true); expect(slider.getAttribute('aria-valuetext')).toBe('Low');
    postMessage.mockClear(); effort.dispatchEvent(new Event('change')); expect(postMessage).not.toHaveBeenCalled();
  });
  it('blocks stale effort until Auto is chosen and disables effort when the model has no capabilities', () => {
    render({ ...effortState, selectedEfforts: { Codex: {}, Claude: { sonnet: 'max' } } });
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!; input.value = 'Hello'; input.dispatchEvent(new Event('input'));
    expect(document.querySelector<HTMLButtonElement>('#chat-send')!.disabled).toBe(true);
    expect(document.querySelector('#model-status')!.textContent).toContain('Reasoning effort unavailable');
    const effort = document.querySelector<HTMLSelectElement>('#chat-effort')!; effort.value = ''; effort.dispatchEvent(new Event('change'));
    expect(document.querySelector<HTMLButtonElement>('#chat-send')!.disabled).toBe(false);
    render({ ...modelState, selectedEfforts: undefined }); expect(effort.disabled).toBe(true); expect(effort.value).toBe('');
  });
  it('shows native model labels, persists selection and sends it on an existing conversation', () => {
    render(modelState); postMessage.mockClear();
    const select = document.querySelector<HTMLSelectElement>('#chat-model')!;
    expect(select.value).toBe('sonnet'); expect([...select.options].map(option => option.textContent)).toEqual(['Provider default', 'Sonnet', 'Opus']);
    select.focus(); select.value = 'opus'; select.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'setModel', selection: { project: '/project', provider: 'Claude', model: 'opus' } });
    render({ ...modelState, syncing: true }); expect(select.value).toBe('opus'); expect(document.activeElement).toBe(select);
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!; input.value = 'Hello'; input.dispatchEvent(new Event('input')); document.querySelector<HTMLButtonElement>('#chat-send')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'sendChat', selection: expect.objectContaining({ provider: 'Claude', model: 'opus', conversationKey: 'Claude:c1' }) });
  });
  it('keeps models separate across providers/projects and pins the active turn model', () => {
    render(modelState); const select = document.querySelector<HTMLSelectElement>('#chat-model')!;
    render({ ...modelState, conversation: undefined, composeProvider: 'Codex' }); expect(select.value).toBe('codex-a'); expect([...select.options].map(option => option.value)).toEqual(['', 'codex-a', 'codex-b']);
    render({ ...modelState, chat: { requestId: 'r1', provider: 'Claude', model: 'opus', status: 'running', prompts: [] } }); expect(select.value).toBe('opus'); expect(select.disabled).toBe(true);
    render({ ...modelState, project: '/other', selectedModels: undefined, modelCatalogs: undefined }); expect(select.value).toBe('');
  });
  it('blocks stale selections, offers refresh, and allows Default during discovery failures', () => {
    render({ ...modelState, selectedModels: { Codex: '', Claude: 'old-model' } });
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!; input.value = 'Hello'; input.dispatchEvent(new Event('input'));
    expect(document.querySelector<HTMLButtonElement>('#chat-send')!.disabled).toBe(true);
    expect(document.getElementById('model-status')!.textContent).toContain('unavailable');
    document.querySelector<HTMLButtonElement>('#models-refresh')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'refreshModels', selection: { project: '/project', provider: 'Claude', model: '' } });
    render({ ...modelState, selectedModels: { Codex: '', Claude: 'old-model' }, modelCatalogs: { Claude: { status: 'error', choices: [], error: 'Sign in first' } } });
    expect(document.getElementById('model-status')!.textContent).toBe('Sign in first');
    const select = document.querySelector<HTMLSelectElement>('#chat-model')!; select.value = ''; select.dispatchEvent(new Event('change'));
    document.querySelector<HTMLButtonElement>('#chat-send')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'sendChat', selection: expect.objectContaining({ model: '' }) });
  });
  it('allows Default while loading but disables repeated refresh', () => {
    render({ ...state, modelCatalogs: { Claude: { status: 'loading', choices: [] } } });
    expect(document.getElementById('model-status')!.textContent).toContain('Loading');
    expect(document.querySelector<HTMLButtonElement>('#models-refresh')!.disabled).toBe(true);
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!; input.value = 'Hello'; input.dispatchEvent(new Event('input'));
    expect(document.querySelector<HTMLButtonElement>('#chat-send')!.disabled).toBe(false);
  });
  it('offers provider-specific access choices and sends Full access immediately without an extra confirmation', () => {
    render({ ...state, conversation: undefined, composeProvider: 'Codex', error: 'Previous error' }); postMessage.mockClear();
    const select = document.querySelector<HTMLSelectElement>('#chat-access')!;
    expect([...select.options].map(option => option.textContent)).toEqual(['Agent', 'Read only', 'Full access']);
    select.value = 'full-access'; select.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'setAccessMode', selection: { project: '/project', provider: 'Codex', mode: 'full-access' } });
    expect(select.value).toBe('full-access'); expect(document.getElementById('access-caption')!.textContent).toBe('No tool approvals');
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    input.value = 'Run the tool'; input.dispatchEvent(new Event('input')); document.querySelector<HTMLButtonElement>('#chat-send')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'sendChat', selection: expect.objectContaining({ accessMode: 'full-access', provider: 'Codex' }) });
  });
  it('restores project/provider access on refresh and locks it to the active run mode', () => {
    const modes = { Codex: 'read-only' as const, Claude: 'full-access' as const };
    render({ ...state, accessModes: modes });
    const select = document.querySelector<HTMLSelectElement>('#chat-access')!;
    expect(select.value).toBe('full-access'); expect([...select.options].map(option => option.value)).toContain('accept-edits');
    render({ ...state, accessModes: modes, syncing: true }); expect(select.value).toBe('full-access');
    render({ ...state, accessModes: modes, conversation: { conversation: state.conversations![1]!, messages: [] } });
    expect(select.value).toBe('read-only'); expect([...select.options].map(option => option.value)).not.toContain('plan');
    render({ ...state, accessModes: modes, chat: { requestId: 'r1', provider: 'Claude', status: 'running', accessMode: 'default', prompts: [] } });
    expect(select.value).toBe('default'); expect(select.disabled).toBe(true);
    render({ ...state, accessModes: modes, project: '/other', conversation: undefined, composeProvider: 'Claude' });
    expect(select.value).toBe('full-access');
    render({ ...state, project: '/other', conversation: undefined, composeProvider: 'Claude' }); expect(select.value).toBe('default');
  });
  const editable = { ...state, conversation: { conversation, messages: [{ id: 'u1', role: 'user' as const, text: 'Original request' }, { id: 'a1', role: 'assistant' as const, text: 'Original answer' }, { id: 'u2', role: 'user' as const, text: 'Later request' }] } };
  it('edits an old user message and sends its exact target without changing the history preview', () => {
    render(editable); postMessage.mockClear();
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    document.querySelector<HTMLButtonElement>('[data-focus-key="edit:u1"]')!.click();
    expect(input.value).toBe('Original request'); expect(document.activeElement).toBe(input);
    expect(document.querySelector<HTMLElement>('#chat-edit-banner')!.hidden).toBe(false);
    input.value = 'Edited request'; input.dispatchEvent(new Event('input'));
    render({ ...editable, syncing: true });
    expect(input.value).toBe('Edited request'); expect(document.activeElement).toBe(input);
    expect(document.querySelector('.message.user .message-text p')!.textContent).toBe('Original request');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'sendChat', selection: expect.objectContaining({ text: 'Edited request', conversationKey: 'Claude:c1', edit: { messageId: 'u1', revision: '1' } }) });
    expect(document.querySelector<HTMLButtonElement>('#chat-edit-cancel')!.disabled).toBe(true);
  });
  it('Cancel and Escape restore the existing draft even after switching edit targets', () => {
    render(editable);
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    input.value = 'My next request'; input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('[data-focus-key="edit:u1"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-focus-key="edit:u2"]')!.click();
    expect(input.value).toBe('Later request');
    document.querySelector<HTMLButtonElement>('#chat-edit-cancel')!.click();
    expect(input.value).toBe('My next request'); expect(document.querySelector<HTMLElement>('#chat-edit-banner')!.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-focus-key="edit:u1"]')!.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(input.value).toBe('My next request'); expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sendChat' }));
  });
  it('preserves edits per conversation and refuses a changed history until Cancel', () => {
    render(editable);
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    document.querySelector<HTMLButtonElement>('[data-focus-key="edit:u1"]')!.click();
    input.value = 'Draft edit'; input.dispatchEvent(new Event('input'));
    render({ ...state, conversation: { conversation: state.conversations![1]!, messages: [] } });
    expect(document.querySelector<HTMLElement>('#chat-edit-banner')!.hidden).toBe(true);
    render(editable); expect(input.value).toBe('Draft edit');
    render({ ...editable, conversation: { ...editable.conversation, conversation: { ...conversation, revision: '2' } } });
    expect(document.querySelector<HTMLButtonElement>('#chat-send')!.disabled).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sendChat' }));
    document.querySelector<HTMLButtonElement>('#chat-edit-cancel')!.click();
    expect(document.querySelector<HTMLElement>('#chat-edit-banner')!.hidden).toBe(true);
  });
  it('keeps edits on rejection and disables all edit actions while the agent runs', () => {
    render(editable);
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    document.querySelector<HTMLButtonElement>('[data-focus-key="edit:u1"]')!.click();
    input.value = 'Retry edit'; input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('#chat-send')!.click();
    render({ ...editable, error: 'Save the file first.' });
    expect(input.value).toBe('Retry edit'); expect(document.querySelector<HTMLElement>('#chat-edit-banner')!.hidden).toBe(false);
    render({ ...editable, chat: { requestId: 'other', provider: 'Claude', status: 'running', phase: 'working', prompts: [] } });
    expect([...document.querySelectorAll<HTMLButtonElement>('.message-edit')].every(button => button.disabled)).toBe(true);
  });
  it('keeps the original draft after a successful branch and restores edit mode after a failure before the branch starts', () => {
    render(editable);
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    input.value = 'Next original draft'; input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('[data-focus-key="edit:u1"]')!.click();
    input.value = 'Edited request'; input.dispatchEvent(new Event('input')); document.querySelector<HTMLButtonElement>('#chat-send')!.click();
    const requestId = postMessage.mock.calls.at(-1)![0].selection.requestId;
    const chat = { requestId, provider: 'Claude' as const, status: 'running' as const, conversationKey: 'Claude:branch', prompts: [] };
    const branch = { ...editable, chat, conversation: { conversation: { ...conversation, id: 'branch', key: 'Claude:branch', revision: 'branch' }, messages: [{ id: 'u1', role: 'user' as const, text: 'Edited request' }] } };
    render(branch); expect(input.value).toBe(''); expect(document.querySelector<HTMLElement>('#chat-edit-banner')!.hidden).toBe(true);
    render({ ...editable, chat: { ...chat, status: 'completed' } }); expect(input.value).toBe('Next original draft');
    document.querySelector<HTMLButtonElement>('[data-focus-key="edit:u1"]')!.click();
    input.value = 'Retry original edit'; input.dispatchEvent(new Event('input')); document.querySelector<HTMLButtonElement>('#chat-send')!.click();
    const failedId = postMessage.mock.calls.at(-1)![0].selection.requestId;
    render({ ...branch, chat: { ...chat, requestId: failedId, status: 'failed', phase: 'finishing' } });
    render({ ...editable, chat: { ...chat, requestId: failedId, status: 'failed', conversationKey: 'Claude:c1' }, error: 'Provider history changed.' });
    expect(input.value).toBe('Retry original edit'); expect(document.querySelector<HTMLElement>('#chat-edit-banner')!.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('#chat-edit-cancel')!.click(); expect(input.value).toBe('Next original draft');
  });
  it('routes every Stop button to the active agent and shows Stopping until changes are saved', () => {
    const chat = { requestId: 'r1', provider: 'Codex' as const, status: 'running' as const, phase: 'working' as const, prompts: [] };
    render({ ...state, chat });
    for (const id of ['stop', 'activity-stop', 'chat-stop']) {
      const stop = document.getElementById(id) as HTMLButtonElement;
      expect(stop.hidden).toBe(false); stop.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'stopChat', selection: undefined });
    }
    render({ ...state, chat: { ...chat, phase: 'stopping' } });
    expect(document.querySelector('#activity-label')?.textContent).toBe('Stopping…');
    for (const id of ['stop', 'activity-stop', 'chat-stop']) expect((document.getElementById(id) as HTMLButtonElement).disabled).toBe(true);
    render({ ...state, chat: { ...chat, status: 'interrupted', phase: 'finishing' } });
    expect(document.querySelector('#activity-label')?.textContent).toBe('Saving changes…');
    render({ ...state, chat: { ...chat, status: 'interrupted', phase: undefined } });
    expect(document.querySelector<HTMLElement>('#agent-activity')?.hidden).toBe(true);
    expect(document.querySelector('#chat-status')?.textContent).toBe('Stopped');
  });
  it.each(['Codex', 'Claude'] as const)('shows a persistent working indicator for %s without replacing it or disturbing drafts', provider => {
    const chat = { requestId: 'r1', provider, status: 'running' as const, conversationKey: 'Claude:c1', phase: 'working' as const, prompts: [] };
    render({ ...state, chat });
    const activity = document.querySelector<HTMLElement>('#agent-activity')!;
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    input.value = 'Next draft'; input.dispatchEvent(new Event('input')); input.focus();
    expect(activity.hidden).toBe(false); expect(activity.dataset.state).toBe('working');
    expect(activity.dataset.provider).toBe(provider); expect(document.querySelector('#activity-label')?.textContent).toBe('Working…');
    expect(document.querySelector('#activity-provider-icon')?.getAttribute('src')).toBe(provider === 'Claude' ? '/claude.svg' : '/codex.svg');
    expect(document.querySelectorAll('.activity-dots span')).toHaveLength(3);
    render({ ...state, chat: { ...chat, activity: 'Using Read…' }, syncing: true });
    expect(document.querySelector('#agent-activity')).toBe(activity); expect(document.querySelector('#activity-label')?.textContent).toBe('Using Read…');
    expect(input.value).toBe('Next draft'); expect(document.activeElement).toBe(input);
    render({ ...state, chat, screen: 'changes' }); expect(activity.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('#activity-stop')!.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'stopChat', selection: undefined });
    render({ ...state, chat: { ...chat, status: 'interrupted', phase: undefined } }); expect(activity.hidden).toBe(true);
  });
  it('shows preparing/finishing and pauses animation while waiting; clears activity on completion, failure and project switch', () => {
    const chat = { requestId: 'r1', provider: 'Claude' as const, status: 'running' as const, conversationKey: 'Claude:c1', prompts: [] };
    render({ ...state, chat: { ...chat, phase: 'preparing' } });
    expect(document.querySelector('#activity-label')?.textContent).toBe('Preparing…');
    expect(document.querySelector('#conversation')?.getAttribute('aria-busy')).toBe('true');
    render({ ...state, chat: { ...chat, activity: 'Using Bash…', prompts: [{ id: 'p1', title: 'Allow?', detail: 'command' }] } });
    expect(document.querySelector<HTMLElement>('#agent-activity')!.dataset.state).toBe('waiting');
    expect(document.querySelector('#activity-label')?.textContent).toBe('Waiting for you…');
    render({ ...state, chat: { ...chat, status: 'completed', phase: 'finishing' } });
    expect(document.querySelector('#activity-label')?.textContent).toBe('Saving changes…');
    expect(document.querySelector<HTMLButtonElement>('#activity-stop')!.disabled).toBe(true);
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    input.value = 'Next'; input.dispatchEvent(new Event('input'));
    expect(document.querySelector<HTMLButtonElement>('#chat-send')!.disabled).toBe(false);
    expect(document.querySelector('#chat-send')!.getAttribute('aria-label')).toBe('Queue message');
    for (const status of ['completed', 'failed'] as const) {
      render({ ...state, chat: { ...chat, status } });
      expect(document.querySelector<HTMLElement>('#agent-activity')!.hidden).toBe(true);
      expect(document.querySelector('#conversation')?.getAttribute('aria-busy')).toBe('false');
    }
    render({ ...state, project: '/other', conversation: undefined, chat: undefined });
    expect(document.querySelector<HTMLElement>('#agent-activity')!.hidden).toBe(true);
  });
  it('sends chat review decisions scoped to the current conversation and keeps its files available in Review', () => {
    const captures = currentConversationCaptures;
    const review = { revision: 'review-1', busy: false, files: [{ path: 'source.ts', kind: 'modified' as const, binary: false, captures }, { path: 'new.ts', kind: 'added' as const, binary: false, captures }] };
    render({ ...state, review });
    expect(document.querySelector<HTMLElement>('#pending-changes')!.hidden).toBe(false);
    expect(document.querySelector('#pending-changes')?.textContent).toContain('2 files pending review');
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Accept all pending changes"]')!.textContent).toBe('Accept all');
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Revert all pending changes"]')!.textContent).toBe('Revert all');
    render({ ...state, review, syncing: true });
    expect(document.querySelectorAll('#pending-changes .review-file')).toHaveLength(2);
    postMessage.mockClear(); document.querySelector<HTMLButtonElement>('#pending-changes [aria-label="Accept source.ts"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'acceptChanges', selection: { project: '/project', revision: 'review-1', file: 'source.ts', group: conversation.key } });
    document.querySelector<HTMLButtonElement>('[aria-label="Revert all pending changes"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewRevert', selection: { project: '/project', revision: 'review-1', group: conversation.key } });
    document.querySelector<HTMLButtonElement>('[aria-label="Accept all pending changes"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'acceptChanges', selection: { project: '/project', revision: 'review-1', group: conversation.key } });
    render({ ...state, conversation: undefined, screen: 'changes', review });
    expect(document.querySelectorAll('#conversation-changes .review-file')).toHaveLength(2);
  });
  it('removes only the accepted file and keeps the remaining review actions bound to the new revision', () => {
    const captures = currentConversationCaptures;
    const review = { revision: 'r1', busy: false, files: [{ path: 'one.ts', kind: 'modified' as const, binary: false, captures }, { path: 'two.ts', kind: 'modified' as const, binary: false, captures }] };
    render({ ...state, review });
    document.querySelector<HTMLButtonElement>('#pending-changes [aria-label="Accept one.ts"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'acceptChanges', selection: { project: '/project', revision: 'r1', file: 'one.ts', group: conversation.key } });
    render({ ...state, review: { ...review, revision: 'r2', files: [review.files[1]!] } });
    expect(document.querySelectorAll('#pending-changes .review-file')).toHaveLength(1);
    expect(document.querySelector('#pending-changes [aria-label="Accept one.ts"]')).toBeNull();
    expect(document.querySelector('#pending-changes')?.textContent).toContain('1 file pending review');
    document.querySelector<HTMLButtonElement>('#pending-changes [aria-label="Accept two.ts"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'acceptChanges', selection: { project: '/project', revision: 'r2', file: 'two.ts', group: conversation.key } });
    const unassigned = { path: 'unassigned.ts', kind: 'modified' as const, binary: false };
    render({ ...state, review: { ...review, revision: 'r3', files: [unassigned] } });
    expect(document.querySelector<HTMLElement>('#pending-changes')!.hidden).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('#review-toggle')!.disabled).toBe(true);
    expect(document.querySelectorAll('#pending-changes .review-file')).toHaveLength(0);
  });
  it('collapses the pending changes box to its heading and keeps the choice across renders', () => {
    const captures = currentConversationCaptures;
    const review = { revision: 'review-1', busy: false, files: [{ path: 'source.ts', kind: 'modified' as const, binary: false, additions: 2, deletions: 1, captures }, { path: 'new.ts', kind: 'added' as const, binary: false, additions: 4, deletions: 0, captures }] };
    render({ ...state, review });
    const pending = document.querySelector<HTMLElement>('#pending-changes')!;
    const toggle = document.querySelector<HTMLButtonElement>('#review-toggle')!;
    expect(toggle.querySelector('.review-toggle-label')!.textContent).toContain('pending review');
    expect(document.querySelector('.review-total')?.textContent).toBe('+6−1');
    expect(pending.classList.contains('collapsed')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.querySelector<HTMLElement>('.review-toggle-label')!.click();
    expect(pending.classList.contains('collapsed')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector<HTMLElement>('#review-body')!.hidden).toBe(true);
    expect(toggle.getAttribute('aria-controls')).toBe('review-body');
    expect(toggle.title).toBe('Show changed files');
    // The heading and its file-level actions stay reachable while collapsed.
    expect(pending.textContent).toContain('2 files pending review');
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Accept all pending changes"]')!.disabled).toBe(false);
    render({ ...state, review: { ...review, revision: 'review-2' } });
    expect(document.querySelector<HTMLElement>('#pending-changes')!.classList.contains('collapsed')).toBe(true);
    document.querySelector<HTMLButtonElement>('#review-toggle')!.click();
    expect(document.querySelector<HTMLElement>('#pending-changes')!.classList.contains('collapsed')).toBe(false);
    expect(document.querySelector<HTMLElement>('#review-body')!.hidden).toBe(false);
  });
  it('jumps between user messages with the in-chat arrows and Alt+Arrow keys', async () => {
    const messages = [
      { id: 'u1', role: 'user' as const, text: 'First request' },
      { id: 'a1', role: 'assistant' as const, text: 'Done' },
      { id: 'u2', role: 'user' as const, text: 'Second request' },
      { id: 'a2', role: 'assistant' as const, text: 'Done again' },
      { id: 'u3', role: 'user' as const, text: 'Third request' },
    ];
    // jsdom reports every rect at zero, so place the scroller and messages explicitly.
    const rect = (top: number) => () => ({ top, bottom: top + 60, height: 60, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const place = (tops: number[]) => {
      document.querySelector<HTMLElement>('.scroll-body')!.getBoundingClientRect = rect(0);
      [...document.querySelectorAll<HTMLElement>('article.message.user')].forEach((node, index) => { node.getBoundingClientRect = rect(tops[index]!); });
      return [...document.querySelectorAll<HTMLElement>('article.message.user')];
    };
    render({ ...state, conversation: { conversation, messages } });
    const nav = document.querySelector<HTMLElement>('#message-nav')!;
    expect(nav.hidden).toBe(false);
    let anchors = place([0, 200, 400]);
    window.dispatchEvent(new Event('resize'));
    document.querySelector<HTMLElement>('.scroll-body')!.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
    expect(document.querySelector('#message-position')!.textContent).toBe('1/3');
    expect(document.querySelector<HTMLButtonElement>('#message-previous')!.disabled).toBe(true);
    document.querySelector<HTMLButtonElement>('#message-next')!.click();
    expect(document.activeElement).toBe(anchors[1]);
    expect(anchors[1]!.classList.contains('message-focused')).toBe(true);
    // Reading the second message: Alt+Up focuses the one before it.
    anchors = place([-200, 0, 200]);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true }));
    expect(document.activeElement).toBe(anchors[0]);
    expect(document.querySelector('#message-position')!.textContent).toBe('1/3');
    render({ ...state, conversation: { conversation: { ...conversation, revision: '2' }, messages: messages.slice(0, 2) } });
    expect(document.querySelector<HTMLElement>('#message-nav')!.hidden).toBe(true);
    render({ ...state, conversation: { conversation: { ...conversation, revision: '3' }, messages } });
    headerAction('history');
    expect(document.querySelector<HTMLElement>('#message-nav')!.hidden).toBe(true);
  });
  it('reaches the last message when scrolling is clamped and retains focus during streaming', async () => {
    const messages = [{ id: 'u1', role: 'user' as const, text: 'First' }, { id: 'u2', role: 'user' as const, text: 'Second' }, { id: 'u3', role: 'user' as const, text: 'Third' }];
    const value = { ...state, conversation: { conversation, messages } };
    render(value);
    const scroller = document.querySelector<HTMLElement>('.scroll-body')!;
    let scrollTop = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 450 },
      scrollTop: { configurable: true, get: () => scrollTop, set: value => { scrollTop = Math.max(0, Math.min(250, value)); } },
    });
    scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    const place = () => [...document.querySelectorAll<HTMLElement>('article.message.user')].map((node, i) => {
      node.getBoundingClientRect = () => ({ top: [0, 250, 350][i]! - scrollTop }) as DOMRect;
      return node;
    });
    let anchors = place(); window.dispatchEvent(new Event('resize'));
    const next = document.querySelector<HTMLButtonElement>('#message-next')!, previous = document.querySelector<HTMLButtonElement>('#message-previous')!;
    next.click(); next.click();
    expect(scrollTop).toBe(250);
    expect(document.activeElement).toBe(anchors[2]);
    expect(document.querySelector('#message-position')!.textContent).toBe('3/3');
    expect(next.disabled).toBe(true);
    previous.click(); expect(document.activeElement).toBe(anchors[1]);
    next.click();
    render({ ...value, conversation: { conversation: { ...conversation, revision: 'streaming' }, messages: [...messages, { id: 'a3', role: 'assistant', text: 'Working…' }] } });
    anchors = place();
    expect(document.activeElement).toBe(anchors[2]);
    expect(document.querySelector('#message-position')!.textContent).toBe('3/3');
    scroller.scrollTop = 0; scroller.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
    expect(document.querySelector('#message-position')!.textContent).toBe('1/3');
    expect(document.querySelector('.message-focused')).toBeNull();
  });
  it('opens review changes in the editor and disables decisions until capture finishes', () => {
    const review = { revision: 'r1', busy: true, files: [{ path: 'source.ts', kind: 'modified' as const, binary: false, captures: currentConversationCaptures }] };
    render({ ...state, review });
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Accept all pending changes"]')!.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('#pending-changes [aria-label="Revert source.ts"]')!.disabled).toBe(true);
    document.querySelector<HTMLButtonElement>('#pending-changes .review-file-link')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewReview', selection: { project: '/project', revision: 'r1', file: 'source.ts', group: conversation.key } });
    render({ ...state, review: { ...review, busy: false }, reviewPreview: { path: 'source.ts', before: 'old', after: 'new', patch: '@@ -1 +1 @@\n-old\n+new' } });
    expect(document.querySelector<HTMLElement>('#review-preview')!.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>('[aria-label="View all changes in the VS Code editor"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewReview', selection: { project: '/project', revision: 'r1', group: conversation.key } });
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Accept all pending changes"]')!.disabled).toBe(false);
  });
  it('sends the typed message to the selected provider/session with Enter and rejects duplicate submits', () => {
    render(state); postMessage.mockClear();
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    input.value = 'Fix login\nKeep tests'; input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    expect(postMessage).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({ type: 'sendChat', selection: { provider: 'Claude', project: '/project', conversationKey: 'Claude:c1', text: 'Fix login\nKeep tests' } });
    expect(input.value).toBe('Fix login\nKeep tests');
    const requestId = postMessage.mock.calls[0]?.[0].selection.requestId;
    render({ ...state, chat: { requestId, provider: 'Claude', status: 'running', conversationKey: 'Claude:c1', prompts: [] } });
    expect(input.value).toBe(''); expect(document.querySelector<HTMLButtonElement>('#chat-stop')!.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('#chat-stop')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'stopChat', selection: undefined });
  });
  it('keeps typed drafts and focus through refresh, screens, and conversation switches', () => {
    render(state);
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    input.value = 'Unsent draft'; input.dispatchEvent(new Event('input')); input.focus();
    render({ ...state, syncing: true }); expect(input.value).toBe('Unsent draft'); expect(document.activeElement).toBe(input);
    render({ ...state, screen: 'changes' }); expect(document.querySelector<HTMLElement>('#chat-composer')!.hidden).toBe(true);
    render(state); expect(input.value).toBe('Unsent draft');
    render({ ...state, conversation: { conversation: state.conversations![1]!, messages: [] } }); expect(input.value).toBe('');
    input.value = 'Codex draft'; input.dispatchEvent(new Event('input')); render(state); expect(input.value).toBe('Unsent draft');
  });
  it('starts a new chat with the chosen provider and never resumes a previously selected session', () => {
    render({ ...state, composeProvider: 'Codex', conversation: undefined }); postMessage.mockClear();
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    const provider = document.querySelector<HTMLSelectElement>('#chat-provider')!;
    provider.value = 'Claude'; provider.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'newChat', selection: 'Claude' });
    render({ ...state, conversation: undefined, composeProvider: 'Claude' });
    input.value = 'New work'; input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('#chat-send')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'sendChat', selection: expect.objectContaining({ provider: 'Claude', conversationKey: undefined, text: 'New work' }) });
  });
  it('restores a failed message for retry and retains the draft when the host rejects a send', () => {
    render(state);
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    input.value = 'Try this'; input.dispatchEvent(new Event('input')); document.querySelector<HTMLButtonElement>('#chat-send')!.click();
    render({ ...state, error: 'Trust the workspace.' }); expect(input.value).toBe('Try this'); expect(document.querySelector<HTMLButtonElement>('#chat-send')!.disabled).toBe(false);
    render(state); document.querySelector<HTMLButtonElement>('#chat-send')!.click();
    const requestId = postMessage.mock.calls.at(-1)![0].selection.requestId;
    const chat = { requestId, provider: 'Claude' as const, status: 'running' as const, conversationKey: 'Claude:c1', prompts: [] };
    render({ ...state, chat }); expect(input.value).toBe('');
    render({ ...state, chat: { ...chat, status: 'failed' }, error: 'Log in first.' });
    expect(input.value).toBe('Try this'); expect(document.querySelector<HTMLButtonElement>('#chat-send')!.disabled).toBe(false);
  });
  it('keeps text typed during acceptance when a new session receives its provider ID', () => {
    render({ ...state, conversation: undefined, composeProvider: 'Codex' });
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    input.value = 'First'; input.dispatchEvent(new Event('input')); document.querySelector<HTMLButtonElement>('#chat-send')!.click();
    const requestId = postMessage.mock.calls.at(-1)![0].selection.requestId;
    input.value = 'Next draft'; input.dispatchEvent(new Event('input'));
    render({ ...state, conversation: { conversation: state.conversations![1]!, messages: [] }, chat: { requestId, provider: 'Codex', status: 'running', conversationKey: 'Codex:c2', prompts: [] } });
    expect(input.value).toBe('Next draft');
  });
  it('shows explicit permission buttons and sends only the selected decision', () => {
    render({ ...state, chat: { requestId: 'r1', provider: 'Claude', status: 'running', prompts: [{ id: 'p1', title: 'Allow terminal?', detail: 'echo test' }] } });
    const dialog = document.querySelector<HTMLDialogElement>('dialog#agent-approval')!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('echo test');
    expect(document.querySelector('#agent-prompts')?.childElementCount).toBe(0);
    postMessage.mockClear();
    expect(dialog.dispatchEvent(new Event('cancel', { cancelable: true }))).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('#agent-approval-prompts button')];
    buttons[0]!.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'answerAgent', selection: { id: 'p1', allow: false } });
    buttons[1]!.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'answerAgent', selection: { id: 'p1', allow: true } });
    dialog.querySelector<HTMLButtonElement>('#agent-approval-stop')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'stopChat', selection: undefined });
    render(state);
    expect(dialog.open).toBe(false);
  });
  it('shows Always allow with its scope and sends a distinct remembered permission answer', () => {
    render({ ...state, chat: { requestId: 'r1', provider: 'Claude', status: 'running', prompts: [{ id: 'p1', title: 'Allow terminal?', detail: 'echo test', allowOptions: [
      { scope: 'always', label: 'Always allow', description: 'Remember in this project.' },
      { scope: 'session', label: 'Allow for this run', description: 'Current run only.' },
    ] }] } });
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#agent-approval-prompts button')];
    expect(buttons.map(button => button.textContent)).toEqual(['Decline', 'Allow once', 'Always allow', 'Allow for this run']);
    expect(document.querySelector('#agent-approval')?.textContent).toContain('Remember in this project.');
    buttons[2]!.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'answerAgent', selection: { id: 'p1', allow: true, allowScope: 'always' } });
    buttons[3]!.click(); expect(postMessage).toHaveBeenLastCalledWith({ type: 'answerAgent', selection: { id: 'p1', allow: true, allowScope: 'session' } });
  });
  it('renders compact history rows, safe Markdown and Tools beneath agent messages', () => {
    const [firstReply, firstTool] = state.conversation!.messages;
    const pending = { ...state.conversation!, messages: [
      { id: 'u1', role: 'user' as const, text: 'Fix login' }, firstTool!,
      { id: 't1-result', role: 'tool' as const, toolName: 'Result', text: 'Updated login.ts' },
    ] };
    render({ ...state, conversation: pending });
    const pendingTools = document.querySelector<HTMLDetailsElement>('.conversation-tools')!;
    expect(pendingTools.previousElementSibling?.getAttribute('data-message-id')).toBe('u1');
    pendingTools.open = true;
    const content = { ...pending, messages: [...pending.messages,
      firstReply!,
      { id: 't2', role: 'tool' as const, toolName: 'Read', text: 'login.ts' },
    ] };
    render({ ...state, conversation: content });
    const links = [...document.querySelectorAll<HTMLButtonElement>('.conversation-link')];
    expect(links.map(link => [...link.children].map(child => child.className))).toEqual([
      ['provider-icon', 'conversation-title', 'conversation-time'],
      ['provider-icon', 'conversation-title', 'conversation-time'],
    ]);
    expect(links[0]?.querySelector<HTMLElement>('.conversation-title')?.title).toBe(conversation.title);
    expect(links[0]?.querySelector<HTMLElement>('.conversation-time')?.title).toBe(new Date(conversation.updatedAt).toLocaleString());
    expect(links[0]?.querySelector('img')?.src).toContain('claude.svg'); expect(links[1]?.querySelector('img')?.src).toContain('codex.svg');
    expect(document.querySelector('.assistant .message-text')?.textContent).toContain('<script>bad()</script>');
    expect(document.querySelector('.message-text script')).toBeNull();
    const groups = [...document.querySelectorAll<HTMLDetailsElement>('#conversation > .conversation-tools')];
    expect(groups).toHaveLength(2);
    const [first, second] = [groups[0]!, groups[1]!];
    expect(first).toBe(pendingTools);
    expect(first.open).toBe(true);
    expect(second.open).toBe(false);
    expect(first.querySelector('summary .conversation-accordion-title')?.textContent).toBe('Tools');
    expect(first.querySelector('summary .codicon-tools')).not.toBeNull();
    expect(first.querySelector('summary .meta')?.textContent).toBe('2');
    expect([...first.querySelectorAll('.tool-name')].map(name => name.textContent)).toEqual(['Edit', 'Result']);
    expect(first.querySelector('#tool-t1 summary .codicon-terminal')).not.toBeNull();
    expect(first.querySelector('#tool-t1-result summary .codicon-output')).not.toBeNull();
    expect(first.previousElementSibling?.getAttribute('data-message-id')).toBe('a1');
    expect(first.nextElementSibling).toBe(second);
    expect(document.querySelector('.message.tool .provider-badge')).toBeNull();
    second.open = true;
    const tool = first.querySelector<HTMLDetailsElement>('#tool-t1')!;
    tool.open = true;
    render({ ...state, conversation: { ...content, conversation: { ...conversation, revision: '2' }, messages: [...content.messages,
      { id: 't2-result', role: 'tool', toolName: 'Result', text: 'File read' },
      { id: 'a2', role: 'assistant', text: 'Checking the change' },
    ] } });
    expect(document.querySelector('.conversation-tools')).toBe(first);
    expect(first.open).toBe(true);
    expect(first.querySelector('#tool-t1')).toBe(tool);
    expect(tool.open).toBe(true);
    expect(first.nextElementSibling?.getAttribute('data-message-id')).toBe('a2');
    expect(first.nextElementSibling?.nextElementSibling).toBe(second);
    expect(second.open).toBe(true);
    expect(second.querySelector('summary .meta')?.textContent).toBe('2');
    expect(second.querySelector('#tool-t2-result pre')?.textContent).toBe('File read');
  });
  it('opens a read-only subagent transcript in chat and restores the parent on Back', () => {
    const group = { parentKey: conversation.key, entries: [{ id: 'agent1', label: 'Scout' }] };
    const parent = { ...state, subagents: group };
    render(parent);
    const section = document.querySelector<HTMLDetailsElement>('#conversation-subagents')!;
    expect(section.hidden).toBe(false);
    expect(section.open).toBe(true);
    expect(section.querySelector('summary .conversation-accordion-title')?.textContent).toBe('Subagents');
    expect(section.querySelector('summary .codicon-robot')).not.toBeNull();
    expect(section.querySelector('summary .codicon-chevron-down')?.previousElementSibling?.textContent).toBe('1');
    section.querySelector('summary')!.click();
    expect(section.open).toBe(false);
    render(parent);
    expect(section.open).toBe(false);
    render({ ...state, conversation: undefined, subagents: group });
    expect(section.hidden).toBe(true);
    expect(section.open).toBe(false);
    render(state);
    expect(section.hidden).toBe(true);
    render(parent);
    expect(section.hidden).toBe(false);
    expect(section.open).toBe(true);

    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!;
    input.value = 'Parent draft';
    input.dispatchEvent(new Event('input'));
    const open = section.querySelector<HTMLButtonElement>('button')!;
    const scroller = document.querySelector<HTMLElement>('.scroll-body')!;
    scroller.scrollTop = 80;
    open.click();
    const requestId = postMessage.mock.lastCall![0].selection.requestId;
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'selectSubagent', selection: { project: '/project', parentKey: conversation.key, agentId: 'agent1', requestId: expect.any(String) } });
    expect(document.getElementById('panel-title')?.textContent).toBe('Scout');
    for (const id of ['thread-view', 'chat-composer', 'pending-changes']) expect(document.getElementById(id)?.hidden).toBe(true);
    expect(document.getElementById('subagent-thread')?.hidden).toBe(false);
    const transcript = document.getElementById('subagent-conversation')!;
    expect(transcript.textContent).toContain('Loading transcript');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'subagentTranscript', requestId, transcript: { status: 'ready', messages: [
      { id: 'child-message', role: 'user', text: '**Task** <script>bad()</script>' },
      { id: 'child-tool', role: 'tool', toolName: 'Read', text: 'login.ts' },
      { id: 'reply', role: 'assistant', text: 'Done' },
    ] } } }));
    expect(transcript.querySelector('strong')?.textContent).toBe('Task');
    expect(transcript.querySelector('.assistant')?.textContent).toContain('Done');
    expect(transcript.querySelector('.conversation-tools')?.previousElementSibling?.getAttribute('data-message-id')).toBe('reply');
    expect(transcript.querySelector('script, button')).toBeNull();
    render({ ...parent, syncing: true });
    expect(transcript.querySelector('strong')?.textContent).toBe('Task');

    const back = document.querySelector<HTMLButtonElement>('#sidebar-navigation')!;
    expect(back.getAttribute('aria-label')).toBe('Back to parent chat');
    back.click();
    expect(document.getElementById('panel-title')?.textContent).toBe(conversation.title);
    for (const id of ['thread-view', 'chat-composer', 'pending-changes']) expect(document.getElementById(id)?.hidden).toBe(false);
    expect(document.getElementById('subagent-thread')?.hidden).toBe(true);
    expect(scroller.scrollTop).toBe(80);
    expect(input.value).toBe('Parent draft');
    expect(document.activeElement).toBe(open);

    open.click();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'subagentTranscript', requestId, transcript: { status: 'error', message: 'Stale transcript' } } }));
    expect(transcript.textContent).toContain('Loading transcript');
    expect(transcript.textContent).not.toContain('Stale transcript');
  });
  it('selects a conversation inside the tandem; tab commands require a separate click', () => {
    render(state); postMessage.mockClear();
    document.querySelector<HTMLButtonElement>('.conversation-link')!.click();
    expect(postMessage.mock.calls).toEqual([[{ type: 'conversation', selection: 'Claude:c1' }]]);
    render({ ...state, running: true, screen: 'changes' });
    const stop = document.querySelector<HTMLButtonElement>('header #stop')!;
    expect(stop.hidden).toBe(false); stop.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'stop', selection: undefined });
  });
  it('filters sessions by provider without changing the opened conversation', () => {
    render(state); document.querySelector<HTMLButtonElement>('[data-provider="Codex"]')!.click();
    expect(document.querySelectorAll('.conversation-link')).toHaveLength(1);
    expect(document.querySelector('.conversation-link')?.getAttribute('data-focus-key')).toBe('Codex:c2');
    expect(document.querySelector('#thread-heading .provider-badge')?.textContent).toBe('Claude Code');
  });
  it('keeps the Review header free of tracking controls and keeps chat available while tracking', () => {
    const review = { revision: 'watch', files: [], busy: false, externalTracking: true };
    render({ ...state, review });
    expect(document.querySelector<HTMLElement>('#pending-changes')!.hidden).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('#review-toggle')!.disabled).toBe(true);
    expect(document.querySelector('#external-review-toggle')).toBeNull();
    const input = document.querySelector<HTMLTextAreaElement>('#chat-input')!; input.value = 'Work'; input.dispatchEvent(new Event('input'));
    expect(document.querySelector<HTMLButtonElement>('#chat-send')!.disabled).toBe(false);
    render({ ...state, review, screen: 'changes' });
    const trackingStatus = document.querySelector<HTMLElement>('#review-tracking-status')!;
    expect(trackingStatus.hidden).toBe(true);
    render({ ...state, review: { ...review, externalTracking: false }, screen: 'changes' });
    expect(trackingStatus.hidden).toBe(false);
    expect(trackingStatus.textContent).toContain('Tracking paused');
    expect(document.querySelector('button[aria-label="Change tracking controls"]')).toBeNull();
    expect(panelHtml(resources, true)).not.toContain('aria-label="Change tracking controls"');
    const refresh = document.querySelector<HTMLButtonElement>('.header-actions #review-refresh')!;
    expect(refresh.getAttribute('aria-label')).toBe('Refresh review');
    expect(document.querySelector('.changes-toolbar button')).toBeNull();
    render({ ...state, review: { ...review, busy: true }, screen: 'changes' });
    expect(refresh.getAttribute('aria-label')).toBe('Retry change capture');
    refresh.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'refreshReview', selection: undefined });
    render({ ...state, review, reviewBusy: true, screen: 'changes' });
    expect(refresh.disabled).toBe(true);
  });
  it('defaults history to the current workspace and scopes provider totals to the chosen folder', () => {
    const value: ViewState = { ...state, conversations: [
      { ...conversation, key: 'root', cwd: '/project', title: 'Root thread' },
      { ...conversation, key: 'nested', cwd: '/project/app', title: 'App thread' },
    ] };
    render(value);
    const picker = document.querySelector<HTMLSelectElement>('#history-workspace')!;
    expect(picker.value).toBe(''); expect(picker.selectedOptions[0]!.text).toContain('Current workspace');
    picker.value = '/project/app'; picker.dispatchEvent(new Event('change'));
    expect(document.querySelector('#conversations')!.textContent).toContain('App thread');
    expect(document.querySelector('#conversations')!.textContent).not.toContain('Root thread');
    expect(document.querySelector('.history-filters [data-provider="all"]')!.getAttribute('aria-label')).toBe('All: 1 conversations');
    render({ ...value, syncing: true }); expect(picker.value).toBe('/project/app');
    render({ ...value, project: '/other', projectName: 'other', conversations: [] }); expect(picker.value).toBe('');
  });
  it('excludes internal Codex sessions from history and keeps totals for other providers', () => {
    render({ ...state, conversations: [
      ...state.conversations!,
      { ...conversation, provider: 'Codex', key: 'Codex:child', id: 'child', cwd: '/project/child', title: 'Internal agent', hiddenFromHistory: true },
    ] });
    headerAction('history');
    document.querySelector<HTMLButtonElement>('.history-filters [data-provider="Codex"]')!.click();
    expect(document.querySelectorAll('.conversation-link')).toHaveLength(1);
    expect(document.querySelector('.history-filters [data-provider="Claude"]')?.getAttribute('aria-label')).toBe('Claude Code: 1 conversations');
    expect(document.querySelector('.history-filters [data-provider="Codex"]')?.getAttribute('aria-label')).toBe('Codex: 1 conversations');
    expect(document.querySelector('.history-filters [data-provider="all"]')?.getAttribute('aria-label')).toBe('All: 2 conversations');
    expect(document.querySelector('#history-workspace option[value="/project/child"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('.history-filters [data-provider="Claude"]')!.click();
    expect(document.querySelector('.conversation-link')?.getAttribute('data-focus-key')).toBe('Claude:c1');
  });
  it('reopens History with all providers and an empty search instead of hiding Claude behind old filters', () => {
    render(state);
    headerAction('history');
    document.querySelector<HTMLButtonElement>('.history-filters [data-provider="Codex"]')!.click();
    const search = document.querySelector<HTMLInputElement>('#conversation-search')!;
    search.value = 'missing'; search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.conversation-link')).toHaveLength(0);
    document.querySelector<HTMLButtonElement>('#sidebar-navigation')!.click();
    headerAction('history');
    expect(search.value).toBe('');
    expect(document.querySelector('.history-filters [data-provider="all"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelectorAll('.conversation-link')).toHaveLength(2);
    expect(document.querySelector('.conversation-link[data-focus-key="Claude:c1"]')).not.toBeNull();
  });
  it('shows the chat title in the sidebar and opens history without a host command', () => {
    render(state); postMessage.mockClear();
    expect(document.querySelector('#panel-title')?.textContent).toBe('Fix login');
    expect(document.querySelector('#thread-heading h2')).toBeNull();
    const navigation = document.querySelector<HTMLButtonElement>('#sidebar-navigation')!;
    expect(navigation.hidden).toBe(true);
    expect(document.querySelector('#project')).toBeNull();
    expect(document.querySelector<HTMLElement>('#history-view')!.hidden).toBe(true);
    headerAction('history');
    expect(document.querySelector<HTMLElement>('#history-view')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#thread-view')!.hidden).toBe(true);
    expect(document.querySelector('#panel-title')?.textContent).toBe('Conversations');
    expect(navigation.hidden).toBe(false);
    expect(navigation.getAttribute('aria-label')).toBe('Back to chat');
    expect(postMessage).not.toHaveBeenCalled();
    const search = document.querySelector<HTMLInputElement>('#conversation-search')!;
    search.value = 'no match'; search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.conversation-link')).toHaveLength(0);
    navigation.focus();
    navigation.click();
    expect(document.querySelector<HTMLElement>('#thread-view')!.hidden).toBe(false);
    expect(navigation.hidden).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('panel-title'));
  });
  it('returns from Manage CLIs to chat and from a selected chat to its filtered history', () => {
    const blank = { ...state, conversation: undefined };
    render(blank);
    const title = document.getElementById('panel-title')!;
    const navigation = document.querySelector<HTMLButtonElement>('#sidebar-navigation')!;
    expect(title.textContent).toBe('New chat');

    render({ ...blank, screen: 'cli' });
    expect(title.textContent).toBe('Manage CLIs');
    expect(navigation.getAttribute('aria-label')).toBe('Back to chat');
    navigation.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'screen', selection: 'conversations' });
    render(blank);

    headerAction('history');
    const search = document.querySelector<HTMLInputElement>('#conversation-search')!;
    search.value = 'login';
    search.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('.conversation-link')!.click();
    render(state);
    const opened = { ...state, conversationOpenRevision: 1 };
    render(opened);
    expect(title.textContent).toBe('Fix login');
    expect(navigation.getAttribute('aria-label')).toBe('Back to Conversations');
    navigation.click();
    expect(title.textContent).toBe('Conversations');
    expect(search.value).toBe('login');
    navigation.click();
    expect(title.textContent).toBe('Fix login');
    expect(navigation.hidden).toBe(true);
  });
  it.each(['assistant', 'user'] as const)('formats %s code, headings and lists while removing active and command links', role => {
    render({ ...state, conversation: { conversation, messages: [{ id: 'md', role, text: '## Changes\n\n- **Fixed** login\n\n```ts\nconst ok = true;\n```\n\n[bad](command:workbench.action.closeWindow) [web](https://example.com)\n\n<img src=x onerror=bad()>' }] } });
    expect(document.querySelector('.markdown h2')?.textContent).toBe('Changes');
    expect(document.querySelector('.markdown li strong')?.textContent).toBe('Fixed');
    expect(document.querySelector('.markdown pre code')?.textContent).toContain('const ok = true;');
    const links = [...document.querySelectorAll('.markdown a')];
    expect(links[0]?.getAttribute('href')).toBeNull();
    expect(links[1]?.getAttribute('href')).toBe('https://example.com');
    expect(document.querySelector('.markdown img')).toBeNull();
  });
  it('folds overflowing user messages, preserves expansion across updates and rechecks on resize', () => {
    let height = 600;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.id === 'message-content-long' ? height : 80;
    });
    const messages = [
      { id: 'long', role: 'user' as const, text: 'Long message', attachments: [{ name: 'screen.png', mimeType: 'image/png', data: 'AQID' }] },
      { id: 'short', role: 'user' as const, text: 'Short message' },
      { id: 'reply', role: 'assistant' as const, text: 'Reply' },
    ];
    const show = (revision: string, key = conversation.key) => render({ ...state, conversation: { conversation: { ...conversation, key, revision }, messages } });
    const toggle = () => document.querySelector<HTMLButtonElement>('[data-message-id="long"] .message-toggle')!;
    show('fold-1');
    const bubble = document.querySelector('[data-message-id="long"] > .message-bubble')!;
    const author = bubble.parentElement!.querySelector(':scope > .message-author');
    expect(author?.textContent).toBe('You');
    expect(bubble.previousElementSibling).toBe(author);
    const actions = bubble.nextElementSibling!;
    expect([...bubble.querySelectorAll('button')]).toEqual([toggle()]);
    expect(bubble.querySelector('.message-text')!.nextElementSibling).toBe(toggle());
    expect(toggle().nextElementSibling).toBe(bubble.querySelector('.message-attachments'));
    expect(bubble.querySelector('.message-attachments img')?.getAttribute('alt')).toBe('screen.png');
    expect(actions).toBe(bubble.parentElement!.lastElementChild);
    expect([...actions.querySelectorAll('button')]).toEqual([actions.querySelector('.message-restore'), actions.querySelector('.message-edit')]);
    expect(toggle().hidden).toBe(false);
    expect(toggle().textContent).toBe('Show more');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(toggle().getAttribute('aria-controls')!)?.classList.contains('message-collapsed')).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-message-id="short"] .message-toggle')!.hidden).toBe(true);
    expect(document.querySelector('[data-message-id="reply"] .message-toggle')).toBeNull();
    toggle().click();
    expect(toggle().textContent).toBe('Show less');
    expect(document.querySelector('#message-content-long')!.classList.contains('message-collapsed')).toBe(false);
    show('fold-2');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    show('fold-3', 'another-conversation');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    show('fold-4');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    toggle().click();
    expect(toggle().textContent).toBe('Show more');
    height = 200; window.dispatchEvent(new Event('resize'));
    expect(toggle().hidden).toBe(true);
    height = 600; window.dispatchEvent(new Event('resize'));
    expect(toggle().hidden).toBe(false);
  });
  it('shows step output and routes file selection to the editor without a panel patch', () => {
    const selection = { sessionId: 's1', stepId: 'step1' }, change = { path: 'login.ts', kind: 'modified' as const, binary: false };
    render({ ...state, screen: 'changes', changePreview: { title: 'Step · Fix', selection, cumulative: false, files: [change], output: 'Done', file: { change, before: 'old\n', after: 'new\n', patch: '--- before\n+++ after\n@@ -1 +1 @@\n-old\n+new\n' } } });
    expect(document.querySelector<HTMLElement>('#screen-conversations')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#screen-changes')!.hidden).toBe(false);
    expect(document.querySelector('.patch-line')).toBeNull();
    expect(document.querySelector('#change-output')!.textContent).toContain('Done');
    postMessage.mockClear();
    document.querySelector<HTMLSelectElement>('.change-files')!.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'previewFile', selection: 'login.ts' });
    document.querySelector<HTMLButtonElement>('[data-focus-key="open-diff-editor"]')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'editor-file', selection: { ...selection, file: 'login.ts' } });
  });
});
