import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCodexChat } from '../src/providers/codex-chat';
import { runClaudeChat } from '../src/providers/claude-chat';
import { agentQuestions, chatRequest, editChat, promptAnswer, questionAnswers, type ChatCallbacks, type ChatRequest, type PromptAnswer } from '../src/providers/chat';
import { codexMessages, type ConversationMessage } from '../src/providers/conversations';
import type { query } from '@anthropic-ai/claude-agent-sdk';
const request: ChatRequest = { requestId: 'r1', project: process.cwd(), provider: 'Codex', text: 'hello' };
function sink() {
  const messages: ConversationMessage[] = [];
  const callbacks: ChatCallbacks = {
    session: vi.fn(), activity: vi.fn(), prompt: vi.fn(async () => ({ id: 'p1', allow: true })),
    message: vi.fn((message, append) => {
      const previous = messages.find(m => m.id === message.id);
      if (previous) Object.assign(previous, message, { text: append ? previous.text + message.text : message.text }); else messages.push({ ...message });
    }),
  };
  return { messages, callbacks };
}
const launchWithModel = (modelCase = 'supported') => () => spawn(process.execPath, [path.resolve('tests/fixtures/codex-chat-server.mjs')], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_TANDEM_MODEL_CASE: modelCase },
});
const launch = launchWithModel();
describe('Codex chat transport', () => {
  it('attributes only the new native turn to the account read from the running process', async () => {
    const callbacks = sink().callbacks, attributeUsage = vi.fn(); callbacks.attributeUsage = attributeUsage;
    await runCodexChat({ ...request, conversationKey: 'Codex:thread-fixture' }, callbacks, new AbortController().signal, process.execPath, launch);
    expect(attributeUsage).toHaveBeenCalledWith('Codex:turn:turn-fixture', expect.objectContaining({ provider: 'Codex', email: 'native-codex@example.test', method: 'ChatGPT' }));
    expect(attributeUsage.mock.calls.every(([key]) => key === 'Codex:turn:turn-fixture')).toBe(true);
    attributeUsage.mockClear();
    await runCodexChat(request, callbacks, new AbortController().signal, process.execPath, launchWithModel('api'));
    expect(attributeUsage).not.toHaveBeenCalled();
  });
  it.each(['first', 'first\n[Image]'])('forks image history with either live or refreshed user text: %s', async first => {
    const { messages, callbacks } = sink();
    await runCodexChat({ ...request, conversationKey: 'Codex:thread-fixture', text: 'branch-check', fork: { userIndex: 1, userTexts: [first, 'second', 'third'] } }, callbacks, new AbortController().signal, process.execPath, launchWithModel('image-history'));
    expect(JSON.parse(messages[0]!.text)).toEqual({ threadId: 'thread-branch', forkBoundary: 'history-turn-0' });
  });
  it('sends multimodal image bytes and native audio/file references to turn/start on a resumed session', async () => {
    const image = { name: 'screen.png', mimeType: 'image/png', data: 'AQID' }, audio = { name: 'clip.wav', mimeType: 'audio/wav', data: 'BAUG' }, file = { name: 'notes.txt', mimeType: 'text/plain', data: 'aGk=' };
    const { messages, callbacks } = sink();
    await runCodexChat({ ...request, conversationKey: 'Codex:thread-fixture', text: 'attachment-check', attachments: [image, audio, file], preparedAttachments: [{ ...audio, path: '/uploads/clip.wav' }, { ...file, path: '/uploads/notes.txt' }] }, callbacks, new AbortController().signal, process.execPath, launch);
    expect(JSON.parse(messages[0]!.text)).toEqual([{ type: 'text', text: 'attachment-check', text_elements: [] }, { type: 'image', url: 'data:image/png;base64,AQID' }, { type: 'localAudio', path: '/uploads/clip.wav' }, { type: 'mention', name: 'notes.txt', path: '/uploads/notes.txt' }]);
  });
  it.each(['start', 'resume', 'fork'] as const)('enables questions in Default mode on %s and returns answers with native IDs', async kind => {
    const { callbacks, messages } = sink();
    callbacks.prompt = vi.fn(async () => ({ id: 'p', answers: { render: 'CodeLens per hunk (Recommended)', scope: 'Pending review only' } }));
    await runCodexChat({ ...request, text: 'questions', ...(kind !== 'start' ? { conversationKey: 'Codex:thread-fixture' } : {}), ...(kind === 'fork' ? { fork: { userIndex: 1, userTexts: ['first', 'second', 'third'] } } : {}) }, callbacks, new AbortController().signal, process.execPath, launch);
    expect(callbacks.prompt).toHaveBeenCalledWith(expect.objectContaining({ questions: [expect.objectContaining({ id: 'render', header: 'Rendering' }), expect.objectContaining({ id: 'scope' })] }), expect.any(AbortSignal));
    expect(JSON.parse(messages[0]!.text)).toEqual({ answers: { render: { answers: ['CodeLens per hunk (Recommended)'] }, scope: { answers: ['Pending review only'] } }, config: { 'features.default_mode_request_user_input': true } });
  });
  it('interrupts pending Codex questions without sending an empty answer', async () => {
    const { callbacks, messages } = sink(), abort = new AbortController();
    callbacks.prompt = vi.fn((_prompt, signal) => new Promise<PromptAnswer>(resolve => {
      signal.addEventListener('abort', () => resolve({ id: 'p', allow: false }), { once: true }); abort.abort();
    }));
    expect(await runCodexChat({ ...request, text: 'questions-wait' }, callbacks, abort.signal, process.execPath, launch)).toBe('interrupted');
    expect(messages).toEqual([]);
  });
  it.each(['start', 'resume', 'fork'] as const)('sets Fast mode on both thread and turn and explicitly clears it on %s', async kind => {
    for (const fastMode of [true, false, undefined]) {
      const output = sink();
      await runCodexChat({ ...request, text: 'fast-mode-check', fastMode, ...(kind !== 'start' ? { conversationKey: 'Codex:thread-fixture' } : {}), ...(kind === 'fork' ? { fork: { userIndex: 1, userTexts: ['first', 'second', 'third'] } } : {}) }, output.callbacks, new AbortController().signal, process.execPath, launch);
      expect(JSON.parse(output.messages[0]!.text)).toEqual(fastMode === undefined ? { threadSpeed: { config: { 'features.default_mode_request_user_input': true } } } : {
        threadSpeed: { serviceTier: fastMode ? 'fast' : 'default', config: { 'features.fast_mode': true, 'features.default_mode_request_user_input': true } }, turnTier: fastMode ? 'fast' : 'default',
      });
    }
  });
  it('forwards only the active thread latest usage without a guessed cache expiry', async () => {
    const callbacks = sink().callbacks, usage = vi.fn(); callbacks.usage = usage;
    await runCodexChat({ ...request, text: 'usage-check' }, callbacks, new AbortController().signal, process.execPath, launch);
    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ usedTokens: 4200, cachedTokens: 3000, windowTokens: 128000 }));
    expect(usage.mock.calls[0]![0]).not.toHaveProperty('cacheExpiresAt');
  });
  it.each(['start', 'resume', 'fork'] as const)('forwards reasoning effort and clears overrides for Auto on %s', async kind => {
    for (const reasoningEffort of ['high', '']) {
      const output = sink();
      await runCodexChat({ ...request, model: 'fixture-supported', reasoningEffort, text: 'effort-check', ...(kind !== 'start' ? { conversationKey: 'Codex:thread-fixture' } : {}), ...(kind === 'fork' ? { fork: { userIndex: 1, userTexts: ['first', 'second', 'third'] } } : {}) }, output.callbacks, new AbortController().signal, process.execPath, launch);
      expect(JSON.parse(output.messages[0]!.text)).toEqual({ effort: reasoningEffort || null });
    }
  });
  it.each(['start', 'resume', 'fork'] as const)('forwards the explicitly selected model to the thread and turn for %s', async kind => {
    const output = sink();
    await runCodexChat({ ...request, text: 'model-boundary-check', model: 'fixture-supported', ...(kind !== 'start' ? { conversationKey: 'Codex:thread-fixture' } : {}), ...(kind === 'fork' ? { fork: { userIndex: 1, userTexts: ['first', 'second', 'third'] } } : {}) }, output.callbacks, new AbortController().signal, process.execPath, launchWithModel('unavailable'));
    expect(JSON.parse(output.messages[0]!.text)).toEqual({ threadModel: 'fixture-supported', turnModel: 'fixture-supported' });
    expect(output.messages.some(message => message.toolName === 'Model')).toBe(false);
  });
  it('never silently replaces an explicitly selected unavailable Codex model', async () => {
    const output = sink();
    await expect(runCodexChat({ ...request, model: 'obsolete' }, output.callbacks, new AbortController().signal, process.execPath, launch)).rejects.toThrow('selected Codex model is unavailable');
    expect(output.messages).toEqual([]);
  });
  it('forks at the correct human turn when native legacy history also contains injected runtime context', async () => {
    const { callbacks, messages } = sink();
    await runCodexChat({ ...request, conversationKey: 'Codex:thread-fixture', text: 'branch-check', fork: { userIndex: 1, userTexts: ['first', 'second', 'third'] } }, callbacks, new AbortController().signal, process.execPath, launchWithModel('context-history'));
    expect(callbacks.session).toHaveBeenCalledWith('thread-branch');
    expect(JSON.parse(messages.find(message => message.id === 'branch-result')!.text)).toEqual({ threadId: 'thread-branch', forkBoundary: 'history-turn-0' });
  });
  it.each(['start', 'resume', 'fork'] as const)('sends full native access for %s, and resets to default when requested', async kind => {
    for (const accessMode of ['full-access', 'default'] as const) {
      const output = sink();
      await runCodexChat({ ...request, text: 'access-check', accessMode, ...(kind !== 'start' ? { conversationKey: 'Codex:thread-fixture' } : {}), ...(kind === 'fork' ? { fork: { userIndex: 1, userTexts: ['first', 'second', 'third'] } } : {}) }, output.callbacks, new AbortController().signal, process.execPath, launch);
      expect(JSON.parse(output.messages[0]!.text)).toEqual(accessMode === 'full-access' ? { approvalPolicy: 'never', sandbox: 'danger-full-access' } : { approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    }
  });
  it('edits an earlier turn by forking through its predecessor, keeping the original thread', async () => {
    const { callbacks, messages } = sink();
    await runCodexChat({ ...request, conversationKey: 'Codex:thread-fixture', text: 'branch-check', fork: { userIndex: 1, userTexts: ['first', 'second', 'third'] } }, callbacks, new AbortController().signal, process.execPath, launch);
    expect(callbacks.session).toHaveBeenCalledWith('thread-branch');
    expect(JSON.parse(messages[0]!.text)).toEqual({ threadId: 'thread-branch', forkBoundary: 'history-turn-0' });
  });
  it('editing the first Codex message starts a fresh context', async () => {
    const { callbacks, messages } = sink();
    await runCodexChat({ ...request, conversationKey: 'Codex:thread-fixture', text: 'branch-check', fork: { userIndex: 0, userTexts: ['first', 'second', 'third'] } }, callbacks, new AbortController().signal, process.execPath, launch);
    expect(callbacks.session).toHaveBeenCalledWith('thread-new');
    expect(JSON.parse(messages[0]!.text)).toEqual({ threadId: 'thread-new' });
  });
  it('refuses a stale Codex edit instead of guessing a fork boundary', async () => {
    const { callbacks } = sink();
    await expect(runCodexChat({ ...request, conversationKey: 'Codex:thread-fixture', fork: { userIndex: 1, userTexts: ['first', 'changed', 'third'] } }, callbacks, new AbortController().signal, process.execPath, launch)).rejects.toThrow('Provider history changed');
    expect(callbacks.session).not.toHaveBeenCalled();
  });
  it.each([0, 1])('edits response-only history with automatic open-page context at user index %s', async userIndex => {
    const records = ['<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>', 'first', 'second', 'third'].map((text, index) => ({
      type: 'response_item', payload: { type: 'message', role: 'user', id: `u${index}`, content: [{ type: 'input_text', text }] },
    }));
    const content = { conversation: { key: 'Codex:thread-fixture', id: 'thread-fixture', provider: 'Codex' as const, title: 'first', cwd: request.project, updatedAt: 0, revision: 'saved' }, messages: codexMessages(records) };
    const edited = { ...request, conversationKey: content.conversation.key, text: 'branch-check', edit: { messageId: `u${userIndex + 1}`, revision: 'saved' } };
    const { fork } = editChat(edited, content), { callbacks, messages } = sink();
    await runCodexChat({ ...edited, fork }, callbacks, new AbortController().signal, process.execPath, launch);
    expect(JSON.parse(messages.find(message => message.id === 'branch-result')!.text)).toEqual(userIndex ? { threadId: 'thread-branch', forkBoundary: 'history-turn-0' } : { threadId: 'thread-new' });
  });
  it('reports real tool start/completion for the working indicator', async () => {
    const { callbacks } = sink();
    await runCodexChat({ ...request, text: 'tool' }, callbacks, new AbortController().signal, process.execPath, launch);
    expect(callbacks.activity).toHaveBeenNthCalledWith(1, 'tool-1', 'Running a command…');
    expect(callbacks.activity).toHaveBeenNthCalledWith(2, 'tool-1', undefined);
  });
  it.each([undefined, 'Codex:thread-fixture'])('resolves an unavailable ChatGPT model using the paginated default catalog (%s)', async conversationKey => {
    const { callbacks, messages } = sink();
    await runCodexChat({ ...request, text: 'model-check', conversationKey }, callbacks, new AbortController().signal, process.execPath, launchWithModel('unavailable'));
    expect(messages.find(message => message.role === 'assistant')?.text).toBe('fixture-default');
    expect(messages.find(message => message.toolName === 'Model')?.text).toContain('fixture-unavailable');
  });
  it.each(['supported', 'api', 'custom'])('preserves the configured model for %s', async modelCase => {
    const { callbacks, messages } = sink();
    await runCodexChat({ ...request, text: 'model-check' }, callbacks, new AbortController().signal, process.execPath, launchWithModel(modelCase));
    expect(messages).toEqual([{ id: 'selected-model', role: 'assistant', text: 'unchanged' }]);
  });
  it('reports an empty ChatGPT catalog before sending inference', async () => {
    await expect(runCodexChat(request, sink().callbacks, new AbortController().signal, process.execPath, launchWithModel('empty'))).rejects.toThrow('no available chat models');
  });
  it.each([undefined, 'Codex:thread-fixture'])('starts/resumes and streams without duplicated or unrelated messages (%s)', async conversationKey => {
    const { callbacks, messages } = sink();
    expect(await runCodexChat({ ...request, conversationKey }, callbacks, new AbortController().signal, process.execPath, launch)).toBe('completed');
    expect(callbacks.session).toHaveBeenCalledWith('thread-fixture');
    expect(messages).toEqual([{ id: 'a1', role: 'assistant', text: 'Hello world' }]);
    expect(callbacks.message).toHaveBeenCalledWith({ id: 'a1', role: 'assistant', text: 'Hello ' }, true);
  });
  it('shows approvals and sends the explicit user decision back to Codex', async () => {
    const { callbacks, messages } = sink(); callbacks.prompt = vi.fn(async () => ({ id: 'p', allow: false }));
    await runCodexChat({ ...request, text: 'approve' }, callbacks, new AbortController().signal, process.execPath, launch);
    expect(callbacks.prompt).toHaveBeenCalledOnce(); expect(messages[0]?.text).toContain('decline');
  });
  it('sends the proposed persistent Codex command rule only for Always allow', async () => {
    const { callbacks, messages } = sink(); callbacks.prompt = vi.fn(async () => ({ id: 'p', allow: true, allowScope: 'always' as const }));
    await runCodexChat({ ...request, text: 'approve-persistent' }, callbacks, new AbortController().signal, process.execPath, launch);
    expect(callbacks.prompt).toHaveBeenCalledWith(expect.objectContaining({ allowOptions: expect.arrayContaining([expect.objectContaining({ scope: 'always', label: 'Always allow' })]) }), expect.any(AbortSignal));
    expect(JSON.parse(messages[0]!.text!.split('\n')[1]!)).toEqual({ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo', 'fixture'] } });
  });
  it.each(['approve', 'approve-file'])('sends native session approval for %s without persisting a rule', async text => {
    const { callbacks, messages } = sink(); callbacks.prompt = vi.fn(async () => ({ id: 'p', allow: true, allowScope: 'session' as const }));
    await runCodexChat({ ...request, text }, callbacks, new AbortController().signal, process.execPath, launch);
    expect(messages[0]?.text).toContain('acceptForSession');
    expect((vi.mocked(callbacks.prompt).mock.calls[0]![0].allowOptions ?? []).map(option => option.scope)).toEqual(['session']);
  });
  it('honors restricted Codex availableDecisions and leaves Allow once as a single approval', async () => {
    for (const text of ['approve-persistent', 'approve-limited']) {
      const { callbacks, messages } = sink();
      await runCodexChat({ ...request, text }, callbacks, new AbortController().signal, process.execPath, launch);
      expect(messages[0]?.text).toContain('\naccept\n');
      if (text === 'approve-limited') expect(vi.mocked(callbacks.prompt).mock.calls[0]![0].allowOptions).toEqual([]);
    }
  });
  it('persists only the network host offered by Codex for Always allow', async () => {
    const { callbacks, messages } = sink(); callbacks.prompt = vi.fn(async () => ({ id: 'p', allow: true, allowScope: 'always' as const }));
    await runCodexChat({ ...request, text: 'approve-network' }, callbacks, new AbortController().signal, process.execPath, launch);
    expect(JSON.parse(messages[0]!.text!.split('\n')[1]!)).toEqual({ applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: 'allow' } } });
    expect(vi.mocked(callbacks.prompt).mock.calls[0]![0].allowOptions?.[0]?.description).toContain('example.test');
  });
  it.each(['session', undefined, 'decline'] as const)('grants requested Codex access only at the selected scope (%s)', async scope => {
    const { callbacks, messages } = sink(); callbacks.prompt = vi.fn(async () => ({ id: 'p', allow: scope !== 'decline', allowScope: scope === 'session' ? scope : undefined }));
    await runCodexChat({ ...request, text: 'approve-permissions' }, callbacks, new AbortController().signal, process.execPath, launch);
    expect(JSON.parse(messages[0]!.text!.split('\n')[1]!)).toEqual({ permissions: scope === 'decline' ? {} : { network: { enabled: true } }, scope: scope === 'session' ? 'session' : 'turn' });
  });
  it('interrupts an active turn', async () => {
    const { callbacks } = sink(), abort = new AbortController();
    callbacks.session = () => { setTimeout(() => abort.abort(), 100); };
    expect(await runCodexChat({ ...request, text: 'wait' }, callbacks, abort.signal, process.execPath, launch)).toBe('interrupted');
  });
  it.each(['hung-init', 'hung-model', 'hung-turn-start', 'hung-interrupt'])('Stop settles %s and reaps the actual process without waiting for the RPC timeout', async mode => {
    const abort = new AbortController(); let child: ReturnType<typeof launch> | undefined;
    const launched = () => { child = launchWithModel(mode)(); setTimeout(() => abort.abort(), 100); return child; };
    const started = Date.now();
    expect(await runCodexChat({ ...request, text: 'wait' }, sink().callbacks, abort.signal, process.execPath, launched)).toBe('interrupted');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  }, 8000);
  it('handles Stop racing the launch before the abort listener is attached', async () => {
    const abort = new AbortController(); let child: ReturnType<typeof launch> | undefined;
    const launched = () => { child = launchWithModel('hung-init')(); abort.abort(); return child; };
    expect(await runCodexChat(request, sink().callbacks, abort.signal, process.execPath, launched)).toBe('interrupted');
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  });
  it('stops a pending permission request instead of waiting for the user answer', async () => {
    const { callbacks } = sink(); const abort = new AbortController();
    callbacks.prompt = vi.fn((_prompt, signal) => new Promise<PromptAnswer>(resolve => {
      signal.addEventListener('abort', () => resolve({ id: 'p', allow: false }), { once: true }); setTimeout(() => abort.abort(), 50);
    }));
    expect(await runCodexChat({ ...request, text: 'approve' }, callbacks, abort.signal, process.execPath, launch)).toBe('interrupted');
    expect(callbacks.prompt).toHaveBeenCalledOnce();
  });
  it.each(['fail', 'exit'])('reports provider failure instead of completing (%s)', async text => {
    await expect(runCodexChat({ ...request, text }, sink().callbacks, new AbortController().signal, process.execPath, launch)).rejects.toThrow(text === 'fail' ? 'authentication' : 'exited');
  });
});
describe('Claude SDK chat', () => {
  it('attributes newly streamed response IDs using native process identity, leaving replayed history unknown', async () => {
    const callbacks = sink().callbacks, attributeUsage = vi.fn(); callbacks.attributeUsage = attributeUsage;
    const accountInfo = vi.fn(async () => ({ email: 'native-claude@example.test', organization: 'org', tokenSource: 'oauth', subscriptionType: 'pro', accessToken: 'secret' }));
    const events = [
      { type: 'assistant', message: { id: 'old-history', model: 'sonnet', usage: {}, content: [] } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'new-main', model: 'sonnet', usage: {} } } },
      { type: 'stream_event', parent_tool_use_id: 'tool', event: { type: 'message_start', message: { id: 'new-subagent', model: 'sonnet', usage: {} } } },
      { type: 'result', is_error: false },
    ];
    const nativeQuery = (() => Object.assign((async function* () { for (const event of events) yield event; })(), { accountInfo, close: vi.fn() })) as unknown as typeof query;
    await runClaudeChat({ ...request, provider: 'Claude', conversationKey: 'Claude:old' }, callbacks, new AbortController(), nativeQuery, process.execPath);
    expect(accountInfo).toHaveBeenCalledOnce(); expect(attributeUsage).toHaveBeenCalledTimes(2);
    expect(attributeUsage.mock.calls.map(([id]) => id)).toEqual(['Claude:new-main', 'Claude:new-subagent']);
    expect(attributeUsage.mock.calls[0]![1]).toMatchObject({ provider: 'Claude', email: 'native-claude@example.test', organization: 'org' });
    expect(JSON.stringify(attributeUsage.mock.calls)).not.toContain('secret');
    accountInfo.mockRejectedValueOnce(new Error('Identity unavailable')); attributeUsage.mockClear();
    await runClaudeChat({ ...request, provider: 'Claude' }, callbacks, new AbortController(), nativeQuery, process.execPath);
    expect(attributeUsage).not.toHaveBeenCalled();
  });
  it('uses a streaming SDK user message for images and PDFs, keeping native resume/options', async () => {
    const image = { name: 'screen.png', mimeType: 'image/png', data: 'AQID' }, pdf = { name: 'spec.pdf', mimeType: 'application/pdf', data: 'BAUG' };
    const sdk = fakeQuery([{ type: 'result', subtype: 'success', session_id: 'c1', is_error: false }]);
    await runClaudeChat({ ...request, provider: 'Claude', conversationKey: 'Claude:c1', attachments: [image, pdf] }, sink().callbacks, new AbortController(), sdk.query, process.execPath);
    const input = sdk.fn.mock.calls[0]![0]; const stream = []; for await (const value of input.prompt) stream.push(value);
    expect(stream).toHaveLength(1); expect(stream[0]).toMatchObject({ type: 'user', session_id: 'c1', message: { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }, { type: 'document', title: 'spec.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'BAUG' } }] } });
    expect(input.options.resume).toBe('c1'); expect(input.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
  });
  function fakeQuery(events: unknown[], inspect?: (options: any) => void) {
    const close = vi.fn();
    const fn = vi.fn((options: any) => {
      inspect?.(options);
      const iterator = (async function* () { for (const event of events) yield event; })();
      return Object.assign(iterator, { close });
    });
    return { query: fn as unknown as typeof query, fn, close };
  }
  const questionInput = { questions: [
    { question: 'How should Accept/Reject appear on each change block?', header: 'Rendering', options: [{ label: 'CodeLens per hunk (Recommended)', description: 'Official API.' }, { label: 'Inset + CodeLens fallback', description: 'Works in every environment.' }], multiSelect: false },
    { question: 'Which keyboard shortcuts should be enabled?', header: 'Shortcuts', options: [{ label: 'Alt+Down' }, { label: 'Alt+Y' }], multiSelect: true },
  ] };
  it.each(['default', 'full-access', 'dont-ask', 'auto'] as const)('routes Claude questions through the hook in %s and maps answers to question text', async accessMode => {
    const { callbacks } = sink(); let options: any;
    callbacks.prompt = vi.fn(async () => ({ id: 'p', answers: { 'question-0': 'CodeLens per hunk (Recommended)', 'question-1': ['Alt+Down', 'Alt+Y'] } }));
    const sdk = fakeQuery([{ type: 'result', is_error: false }], value => { options = value.options; });
    await runClaudeChat({ ...request, provider: 'Claude', accessMode }, callbacks, new AbortController(), sdk.query, process.execPath);
    const hook = options.hooks.PreToolUse[0].hooks[0];
    const result = await hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: questionInput }, 'q-tool', { signal: new AbortController().signal });
    const expected = { ...questionInput, answers: { [questionInput.questions[0]!.question]: 'CodeLens per hunk (Recommended)', [questionInput.questions[1]!.question]: 'Alt+Down, Alt+Y' } };
    expect(result).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: expected } });
    expect(await options.canUseTool('AskUserQuestion', questionInput, { signal: new AbortController().signal, toolUseID: 'q-tool' })).toEqual({ behavior: 'allow', updatedInput: expected });
    expect(callbacks.prompt).toHaveBeenCalledOnce();
    expect(vi.mocked(callbacks.prompt).mock.calls[0]![0]).toEqual({ title: 'Claude Code needs your input', detail: '', questions: agentQuestions(questionInput.questions) });
    expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 'other', { signal: new AbortController().signal })).toEqual({});
  });
  it('handles Claude question callbacks without a hook and denies a cancelled question', async () => {
    const { callbacks } = sink(); let options: any;
    callbacks.prompt = vi.fn(async () => ({ id: 'p', answers: { 'question-0': 'Custom answer', 'question-1': ['Alt+Y'] } }));
    const sdk = fakeQuery([{ type: 'result', is_error: false }], value => { options = value.options; });
    await runClaudeChat({ ...request, provider: 'Claude' }, callbacks, new AbortController(), sdk.query, process.execPath);
    expect((await options.canUseTool('AskUserQuestion', questionInput, { signal: new AbortController().signal })).updatedInput.answers).toEqual({ [questionInput.questions[0]!.question]: 'Custom answer', [questionInput.questions[1]!.question]: 'Alt+Y' });
    const abort = new AbortController();
    callbacks.prompt = vi.fn((_prompt, signal) => new Promise<PromptAnswer>(resolve => { signal.addEventListener('abort', () => resolve({ id: 'p', allow: false }), { once: true }); abort.abort(); }));
    expect((await options.canUseTool('AskUserQuestion', questionInput, { signal: abort.signal })).behavior).toBe('deny');
  });
  it('reports the latest main-thread usage, ignores subagents and never uses cumulative result totals as context', async () => {
    const callbacks = sink().callbacks, usage = vi.fn(); callbacks.usage = usage;
    const sdk = fakeQuery([
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'a1', model: 'sonnet', content: [], usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 200 } } } },
      { type: 'assistant', parent_tool_use_id: 'subagent', message: { id: 'sub', model: 'opus', content: [], usage: { input_tokens: 999999 } } },
      { type: 'result', is_error: false, usage: { input_tokens: 999999 }, modelUsage: { sonnet: { inputTokens: 999999, contextWindow: 200000 }, opus: { contextWindow: 1000000 } } },
    ]);
    await runClaudeChat({ ...request, provider: 'Claude' }, callbacks, new AbortController(), sdk.query, process.execPath);
    expect(usage).toHaveBeenLastCalledWith(expect.objectContaining({ usedTokens: 330, windowTokens: 200000, cachedTokens: 100, cacheTtlMs: 300000, model: 'sonnet' }));
    expect(usage).toHaveBeenCalledTimes(2);
  });
  it.each(['start', 'resume', 'fork'] as const)('forwards an explicit Claude model for %s and leaves Default inherited', async kind => {
    for (const model of ['sonnet', '']) {
      const sdk = fakeQuery([{ type: 'result', subtype: 'success', session_id: 'c1', is_error: false }]);
      await runClaudeChat({ ...request, provider: 'Claude', model, reasoningEffort: model ? 'medium' : '', ...(kind !== 'start' ? { conversationKey: 'Claude:original' } : {}), ...(kind === 'fork' ? { fork: { userIndex: 1, userTexts: ['first', 'second'] } } : {}) }, sink().callbacks, new AbortController(), sdk.query, process.execPath, { getSessionMessages: async () => [
        { uuid: 'u1', type: 'user', session_id: 'original', parent_tool_use_id: null, message: { content: 'first' } },
        { uuid: 'a1', type: 'assistant', session_id: 'original', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'answer' }] } },
        { uuid: 'u2', type: 'user', session_id: 'original', parent_tool_use_id: null, message: { content: 'second' } },
      ] });
      expect(sdk.fn.mock.calls[0]![0].options.model).toBe(model || undefined);
      expect(sdk.fn.mock.calls[0]![0].options.effort).toBe(model ? 'medium' : undefined);
      const input = sdk.fn.mock.calls[0]![0];
      expect(input.prompt).toBe(request.text);
      expect(input.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
      expect(input.options.settingSources).toEqual(['user', 'project', 'local']);
      expect(input.options.resume).toBe(kind === 'start' ? undefined : 'original');
      expect(input.options.resumeSessionAt).toBe(kind === 'fork' ? 'a1' : undefined);
      expect(input.options.forkSession).toBe(kind === 'fork' ? true : undefined);
    }
  });
  it.each(['full-access', 'default', 'accept-edits', 'plan', 'dont-ask', 'auto'] as const)('passes native %s to Claude without changing permission rules', async accessMode => {
    const sdk = fakeQuery([{ type: 'result', subtype: 'success', session_id: 'c1', is_error: false }]);
    await runClaudeChat({ ...request, provider: 'Claude', conversationKey: 'Claude:c1', accessMode }, sink().callbacks, new AbortController(), sdk.query, process.execPath);
    const options = sdk.fn.mock.calls[0]![0].options;
    const expected = { 'full-access': 'bypassPermissions', default: 'default', 'accept-edits': 'acceptEdits', plan: 'plan', 'dont-ask': 'dontAsk', auto: 'auto' };
    expect(options.permissionMode).toBe(expected[accessMode]);
    expect(options.allowDangerouslySkipPermissions).toBe(accessMode === 'full-access');
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.canUseTool).toBeTypeOf('function');
  });
  it('forks Claude before the edited prompt, including preceding tool-result carriers', async () => {
    const records = [
      { uuid: 'u1', type: 'user', message: { content: 'first' } },
      { uuid: 'a1', type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } },
      { uuid: 'tr1', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }] } },
      { uuid: 'u2', type: 'user', message: { content: 'second' } },
      { uuid: 'u3', type: 'user', message: { content: 'third' } },
    ];
    for (const userIndex of [0, 1]) {
      const sdk = fakeQuery([{ type: 'result', subtype: 'success', session_id: 'fork', is_error: false }]);
      await runClaudeChat({ ...request, provider: 'Claude', conversationKey: 'Claude:original', fork: { userIndex, userTexts: ['first', 'second', 'third'] } }, sink().callbacks, new AbortController(), sdk.query, process.execPath, { getSessionMessages: async () => records });
      const options = sdk.fn.mock.calls[0]![0].options;
      expect(options.resume).toBe(userIndex ? 'original' : undefined);
      expect(options.resumeSessionAt).toBe(userIndex ? 'tr1' : undefined);
      expect(options.forkSession).toBe(userIndex ? true : undefined);
    }
  });
  it('refuses stale Claude history before starting inference', async () => {
    const sdk = fakeQuery([]);
    await expect(runClaudeChat({ ...request, provider: 'Claude', conversationKey: 'Claude:original', fork: { userIndex: 0, userTexts: ['first'] } }, sink().callbacks, new AbortController(), sdk.query, process.execPath, { getSessionMessages: async () => [] })).rejects.toThrow('Provider history changed');
    expect(sdk.fn).not.toHaveBeenCalled();
  });
  it('forks Claude using displayed user text when native history includes IDE context', async () => {
    const context = '<ide_opened_file>The user opened the file /Users/hung/Code/pm-event/checkin-app/package.json in the IDE. This may or may not be related to the current task.</ide_opened_file>';
    const sdk = fakeQuery([{ type: 'result', subtype: 'success', session_id: 'fork', is_error: false }]);
    await runClaudeChat({ ...request, provider: 'Claude', conversationKey: 'Claude:original', fork: { userIndex: 1, userTexts: ['first', 'rung được rồi mà, thử không cần patch xem'] } }, sink().callbacks, new AbortController(), sdk.query, process.execPath, { getSessionMessages: async () => [
      { uuid: 'u1', type: 'user', message: { content: `${context}\nfirst` } },
      { uuid: 'a1', type: 'assistant', message: { content: 'answer' } },
      { uuid: 'u2', type: 'user', message: { content: `${context}\nrung được rồi mà, thử không cần patch xem` } },
    ] });
    expect(sdk.fn.mock.calls[0]![0].options).toMatchObject({ resume: 'original', resumeSessionAt: 'a1', forkSession: true });
    expect(sdk.fn.mock.calls[0]![0].prompt).toBe(request.text);
  });
  it('Stop closes a stalled SDK iterator once and returns interrupted within a bounded time', async () => {
    const abort = new AbortController(), close = vi.fn();
    const sdk = (() => { setTimeout(() => abort.abort(), 50); return { next: () => new Promise(() => undefined), close }; }) as unknown as typeof query;
    const started = Date.now();
    expect(await runClaudeChat({ ...request, provider: 'Claude' }, sink().callbacks, abort, sdk, process.execPath)).toBe('interrupted');
    expect(Date.now() - started).toBeLessThan(2500); expect(close).toHaveBeenCalledOnce();
  });
  it('ignores a late SDK message after Stop', async () => {
    const abort = new AbortController(), close = vi.fn(); const { callbacks } = sink();
    const sdk = (() => { setTimeout(() => abort.abort(), 20); return { next: () => new Promise(resolve => setTimeout(() => resolve({ done: false, value: { type: 'system', session_id: 'late' } }), 100)), close }; }) as unknown as typeof query;
    expect(await runClaudeChat({ ...request, provider: 'Claude' }, callbacks, abort, sdk, process.execPath)).toBe('interrupted');
    expect(callbacks.session).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  });
  it('uses the original session, streams text, replaces it with final content, and closes the query', async () => {
    const { messages, callbacks } = sink();
    const sdk = fakeQuery([
      { type: 'system', subtype: 'init', session_id: 'c1' },
      { type: 'stream_event', session_id: 'c1', event: { type: 'message_start', message: { id: 'a1' } } },
      { type: 'stream_event', session_id: 'c1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } },
      { type: 'assistant', session_id: 'c1', message: { id: 'a1', content: [{ type: 'text', text: 'Hello world' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'test.ts' } }] } },
      { type: 'user', session_id: 'c1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }] } },
      { type: 'result', subtype: 'success', session_id: 'c1', is_error: false },
    ]);
    expect(await runClaudeChat({ ...request, provider: 'Claude', conversationKey: 'Claude:c1' }, callbacks, new AbortController(), sdk.query, process.execPath)).toBe('completed');
    expect(sdk.fn.mock.calls[0]?.[0].options.resume).toBe('c1');
    expect(sdk.fn.mock.calls[0]?.[0].options.cwd).toBe(request.project);
    expect(messages.filter(m => m.role === 'assistant')).toEqual([{ id: 'a1', role: 'assistant', text: 'Hello world' }]);
    expect(messages[1]?.toolName).toBe('Read'); expect(sdk.close).toHaveBeenCalledOnce();
    expect(callbacks.activity).toHaveBeenNthCalledWith(1, 't1', 'Using Read…'); expect(callbacks.activity).toHaveBeenNthCalledWith(2, 't1');
  });
  it('requires a final result and exposes authentication errors', async () => {
    const sdk = fakeQuery([{ type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['Log in first.'] }]);
    await expect(runClaudeChat({ ...request, provider: 'Claude' }, sink().callbacks, new AbortController(), sdk.query, process.execPath)).rejects.toThrow('Log in first');
    await expect(runClaudeChat({ ...request, provider: 'Claude' }, sink().callbacks, new AbortController(), fakeQuery([]).query, process.execPath)).rejects.toThrow('without a completed');
  });
  it('routes tool permissions through the panel callback', async () => {
    const { callbacks } = sink(); let options: any;
    const sdk = fakeQuery([{ type: 'result', is_error: false }], value => { options = value.options; });
    await runClaudeChat({ ...request, provider: 'Claude' }, callbacks, new AbortController(), sdk.query, process.execPath);
    const input = { command: 'echo test' };
    expect(await options.canUseTool('Bash', input, { signal: new AbortController().signal })).toEqual({ behavior: 'allow', updatedInput: input });
    expect(callbacks.prompt).toHaveBeenCalledOnce();
  });
  it.each(['always', 'session', undefined, 'decline'] as const)('applies only the selected Claude permission scope (%s)', async scope => {
    const { callbacks } = sink(); let options: any;
    callbacks.prompt = vi.fn(async () => ({ id: 'p', allow: scope !== 'decline', allowScope: scope === 'always' || scope === 'session' ? scope : undefined }));
    const sdk = fakeQuery([{ type: 'result', is_error: false }], value => { options = value.options; });
    await runClaudeChat({ ...request, provider: 'Claude' }, callbacks, new AbortController(), sdk.query, process.execPath);
    const persistent = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo fixture:*' }], behavior: 'allow', destination: 'localSettings' };
    const session = { ...persistent, destination: 'session' }, global = { ...persistent, destination: 'userSettings' };
    const input = { command: 'echo fixture' };
    const result = await options.canUseTool('Bash', input, { signal: new AbortController().signal, suggestions: [persistent, session, global] });
    expect(result).toEqual(scope === 'decline' ? { behavior: 'deny', message: 'The user declined this action.' } : {
      behavior: 'allow', updatedInput: input, ...(scope === 'always' || scope === 'session' ? { updatedPermissions: [scope === 'always' ? persistent : session] } : {}),
    });
    expect(vi.mocked(callbacks.prompt).mock.calls[0]![0].allowOptions?.map(option => option.scope)).toEqual(['always', 'session']);
  });
  it('hides suppressed Claude remember options and declines when the request was stopped', async () => {
    const { callbacks } = sink(); let options: any;
    callbacks.prompt = vi.fn(async () => ({ id: 'p', allow: true, allowScope: 'always' as const }));
    const sdk = fakeQuery([{ type: 'result', is_error: false }], value => { options = value.options; });
    const abort = new AbortController();
    await runClaudeChat({ ...request, provider: 'Claude' }, callbacks, abort, sdk.query, process.execPath);
    const context = { signal: new AbortController().signal, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' }], suppressAlwaysAllowRule: true };
    expect(await options.canUseTool('Bash', {}, context)).toEqual({ behavior: 'allow', updatedInput: {} });
    expect(vi.mocked(callbacks.prompt).mock.calls[0]![0].allowOptions).toEqual([]);
    abort.abort(); expect((await options.canUseTool('Bash', {}, context)).behavior).toBe('deny');
  });
});
it('rejects invalid or declined remembered permission answers at the host boundary', () => {
  expect(promptAnswer({ id: 'p', allow: true, allowScope: 'always' })).toEqual({ id: 'p', allow: true, allowScope: 'always' });
  for (const value of [null, {}, { id: 'p', allow: false, allowScope: 'always' }, { id: 'p', allowScope: 'session' }, { id: 'p', allow: true, allowScope: 'all' }, { id: 'p', answers: [] }]) expect(() => promptAnswer(value)).toThrow();
});
it('validates question answers at the host boundary, including multi-select and missing answers', () => {
  const questions = agentQuestions([{ question: 'Pick?', id: 'pick' }, { question: 'Many?', id: 'many', multiSelect: true }]);
  const answer = { id: 'p', answers: { pick: 'Custom', many: ['A', 'B'] } };
  expect(promptAnswer(answer)).toEqual(answer);
  expect(questionAnswers(questions, answer)).toEqual({ pick: ['Custom'], many: ['A', 'B'] });
  for (const answers of [{}, { pick: ' ' }, { pick: ['A', 'B'] }, { pick: 'A', many: [] }] as Array<NonNullable<PromptAnswer['answers']>>) expect(() => questionAnswers(questions, { id: 'p', answers })).toThrow();
  for (const answers of [{ pick: [1] }, { pick: [] }]) expect(() => promptAnswer({ id: 'p', answers })).toThrow();
});
it('validates chat messages at the host boundary', () => {
  expect(chatRequest(request)).toEqual(request);
  for (const value of [null, {}, { ...request, text: '  ' }, { ...request, provider: 'shell' }, { ...request, text: 'x'.repeat(200_001) }]) expect(() => chatRequest(value)).toThrow();
});
it('validates edit targets and derives a prefix without accepting client fork instructions', () => {
  const conversation = { key: 'Codex:c1', id: 'c1', provider: 'Codex' as const, title: 'Test', cwd: request.project, updatedAt: 1, revision: 'rev1' };
  const content = { conversation, messages: [{ id: 'u1', role: 'user' as const, text: 'first' }, { id: 'a1', role: 'assistant' as const, text: 'answer' }, { id: 'u2', role: 'user' as const, text: 'second' }, { id: 'a2', role: 'assistant' as const, text: 'later' }] };
  const edited = { ...request, conversationKey: 'Codex:c1', edit: { messageId: 'u2', revision: 'rev1' } };
  expect(editChat(edited, content)).toEqual({ messages: content.messages.slice(0, 2), fork: { userIndex: 1, userTexts: ['first', 'second'] } });
  expect(content.messages).toHaveLength(4);
  for (const edit of [{ messageId: 'a1', revision: 'rev1' }, { messageId: 'u2', revision: 'stale' }, { messageId: 'unknown', revision: 'rev1' }]) expect(() => editChat({ ...edited, edit }, content)).toThrow();
  for (const edit of [null, {}, { messageId: 'u1' }, { messageId: 'u1', revision: '' }]) expect(() => chatRequest({ ...request, edit })).toThrow();
  expect(chatRequest({ ...edited, fork: { userIndex: 100 } })).not.toHaveProperty('fork');
});
