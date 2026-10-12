import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { findExecutable } from './probe';
import { agentQuestions, questionAnswers, validateForkUsers, type AgentPrompt, type ProviderChatRequest, type ChatCallbacks, type ChatResult } from './chat';
import { terminateProcessTree } from './process';
import { codexAccess } from './access';
import { isRuntimeContextOnly } from './history-context';
import { codexUsage } from './context-usage';
import { codexInput } from './chat-input';
import { codexAccount } from './account-status';
import { usageAccount, type UsageAccount } from '../core/usage-account';

/** One transport per turn. Provider history remains owned by Codex. */
export async function runCodexChat(request: ProviderChatRequest, callbacks: ChatCallbacks, signal: AbortSignal, configured = '',
  launch: (executable: string, cwd: string) => ChildProcessWithoutNullStreams = (executable, cwd) => spawn(executable, ['app-server'], { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })): Promise<ChatResult> {
  const executable = await findExecutable('codex', configured);
  if (signal.aborted) return 'interrupted';
  const child = launch(executable, request.project);
  const lines = createInterface({ input: child.stdout });
  child.stderr.on('data', () => undefined);
  let nextId = 0, threadId = '', turnId = '', failure: Error | undefined, finished = false;
  let accountIdentity: UsageAccount | undefined;
  const attributeTurn = () => { if (turnId && accountIdentity) callbacks.attributeUsage?.(`Codex:turn:${turnId}`, accountIdentity); };
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let resolveDone!: (result: ChatResult) => void, rejectDone!: (error: Error) => void;
  const done = new Promise<ChatResult>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  void done.catch(() => undefined);
  const write = (value: unknown) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n'); };
  const rejectPending = (error: Error) => {
    failure = error;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };
  const fail = (error: Error) => {
    rejectPending(error); if (!finished) rejectDone(error);
  };
  const call = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, 30_000);
    pending.set(id, { resolve, reject, timer }); write({ id, method, params });
  });
  child.on('error', error => fail(new Error(`Could not start Codex: ${error.message}`)));
  child.on('exit', () => {
    if (signal.aborted) { finished = true; rejectPending(new Error('Stopped.')); resolveDone('interrupted'); }
    else if (!finished) fail(new Error('Codex exited before completing the response.'));
  });
  child.stdin.on('error', () => { if (!finished) fail(new Error('Codex connection closed.')); });
  const prompts = new AbortController();
  let stopTimer: NodeJS.Timeout | undefined;
  let stopping = false;
  const stop = () => {
    if (finished || stopping) return;
    stopping = true;
    prompts.abort();
    if (threadId && turnId) {
      // Do not wait behind a stuck turn/start RPC or create another timed RPC.
      write({ id: ++nextId, method: 'turn/interrupt', params: { threadId, turnId } });
      stopTimer = setTimeout(() => { finished = true; resolveDone('interrupted'); }, 1000);
    } else { finished = true; resolveDone('interrupted'); }
    rejectPending(new Error('Stopped.'));
  };
  signal.addEventListener('abort', stop, { once: true });
  const item = (value: any) => {
    if (value.type === 'agentMessage') callbacks.message({ id: value.id, role: 'assistant', text: value.text ?? '' });
    else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(value.type)) {
      callbacks.message({ id: value.id, role: 'tool', toolName: value.type === 'commandExecution' ? 'Terminal' : value.type,
        text: value.type === 'commandExecution' ? [value.command, value.aggregatedOutput, value.status].filter(Boolean).join('\n') : JSON.stringify(value, null, 2) });
    }
  };
  const handle = async (message: any) => {
    if (message.method && message.id !== undefined) {
      const p = message.params ?? {};
      if (p.threadId && threadId && p.threadId !== threadId) { write({ id: message.id, error: { code: -32600, message: 'Wrong thread.' } }); return; }
      if (p.turnId && turnId && p.turnId !== turnId) { write({ id: message.id, error: { code: -32600, message: 'Wrong turn.' } }); return; }
      if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
        const available: unknown[] | undefined = Array.isArray(p.availableDecisions) ? p.availableDecisions : undefined;
        const supports = (name: string) => !available || available.some(decision => decision === name || (!!decision && typeof decision === 'object' && Object.hasOwn(decision, name)));
        const prefix = message.method === 'item/commandExecution/requestApproval' && Array.isArray(p.proposedExecpolicyAmendment)
          && p.proposedExecpolicyAmendment.length && p.proposedExecpolicyAmendment.every((part: unknown) => typeof part === 'string' && part.length) ? p.proposedExecpolicyAmendment : undefined;
        const networkChoice = available?.find((decision: any) => decision?.applyNetworkPolicyAmendment?.network_policy_amendment?.action === 'allow'
          && typeof decision.applyNetworkPolicyAmendment.network_policy_amendment.host === 'string'
          && decision.applyNetworkPolicyAmendment.network_policy_amendment.host.length) as any;
        const networkRule = networkChoice?.applyNetworkPolicyAmendment.network_policy_amendment;
        const persistentDecision = networkRule ? { applyNetworkPolicyAmendment: { network_policy_amendment: { host: networkRule.host, action: 'allow' } } }
          : prefix && supports('acceptWithExecpolicyAmendment') ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } } : undefined;
        const allowOptions: AgentPrompt['allowOptions'] = [];
        if (persistentDecision) allowOptions.push({ scope: 'always', label: 'Always allow', description: networkRule ? `Save a Codex network rule allowing ${networkRule.host}.` : `Save a Codex rule for commands starting with ${JSON.stringify(prefix)}.` });
        if (supports('acceptForSession')) allowOptions.push({ scope: 'session', label: 'Always allow for this run', description: 'Remember this approval during the current agent run.' });
        const answer = await callbacks.prompt({ title: p.reason ?? 'Allow agent action?', detail: JSON.stringify(p, null, 2), allowOptions }, prompts.signal);
        const allowed = answer.allow && !prompts.signal.aborted && !signal.aborted;
        const decision = !allowed ? 'decline' : answer.allowScope === 'always' && persistentDecision
          ? persistentDecision
          : answer.allowScope === 'session' && supports('acceptForSession') ? 'acceptForSession' : 'accept';
        write({ id: message.id, result: { decision } });
      } else if (message.method === 'item/permissions/requestApproval') {
        const answer = await callbacks.prompt({ title: p.reason ?? 'Allow requested agent access?', detail: JSON.stringify(p.permissions, null, 2), allowOptions: [
          { scope: 'session', label: 'Always allow for this run', description: 'Grant only the requested access for the current agent run.' },
        ] }, prompts.signal);
        const allowed = answer.allow && !prompts.signal.aborted && !signal.aborted;
        write({ id: message.id, result: { permissions: allowed ? p.permissions : {}, scope: allowed && answer.allowScope === 'session' ? 'session' : 'turn' } });
      } else if (message.method === 'item/tool/requestUserInput') {
        const questions = agentQuestions(p.questions);
        const answer = await callbacks.prompt({ title: 'Codex needs your input', detail: '', questions }, prompts.signal);
        if (prompts.signal.aborted || signal.aborted) return;
        const answers = questionAnswers(questions, answer);
        write({ id: message.id, result: { answers: Object.fromEntries(questions.map(q => [q.id, { answers: answers[q.id] }])) } });
      } else write({ id: message.id, error: { code: -32601, message: 'This agent request is not supported by AgentTandem.' } });
      return;
    }
    if (message.id !== undefined) {
      const p = pending.get(message.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(message.id);
      if (message.error) p.reject(new Error(message.error.message ?? 'Codex rejected the request.')); else p.resolve(message.result);
      return;
    }
    const p = message.params ?? {};
    if (!threadId || p.threadId !== threadId) return;
    if (message.method === 'turn/started') { turnId = p.turn.id; attributeTurn(); if (signal.aborted) stop(); }
    if (signal.aborted && message.method !== 'turn/completed') return;
    if (message.method === 'thread/tokenUsage/updated' && (!p.turnId || !turnId || p.turnId === turnId)) {
      const usage = codexUsage(p.tokenUsage, Date.now()); if (usage) callbacks.usage?.(usage);
    }
    if (message.method === 'item/agentMessage/delta') callbacks.message({ id: p.itemId, role: 'assistant', text: p.delta }, true);
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const labels: Record<string, string> = { commandExecution: 'Running a command…', fileChange: 'Editing files…', mcpToolCall: 'Using a tool…', dynamicToolCall: 'Using a tool…', webSearch: 'Searching the web…' };
      if (labels[p.item.type]) callbacks.activity?.(p.item.id, message.method === 'item/started' ? labels[p.item.type] : undefined);
      item(p.item);
    }
    if (message.method === 'turn/completed') {
      if (turnId && p.turn.id !== turnId) return;
      finished = true;
      if (signal.aborted) resolveDone('interrupted');
      else if (p.turn.status === 'failed') rejectDone(new Error(p.turn.error?.message ?? 'Codex failed to respond.'));
      else resolveDone(p.turn.status === 'interrupted' ? 'interrupted' : 'completed');
    }
  };
  lines.on('line', line => {
    try { void handle(JSON.parse(line)).catch(fail); }
    catch { fail(new Error('Codex returned an invalid protocol message.')); }
  });
  try {
    if (signal.aborted) { stop(); return await done; }
    await call('initialize', { clientInfo: { name: 'agent_tandem', title: 'AgentTandem', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    write({ method: 'initialized', params: {} });
    const existing = request.conversationKey?.slice('Codex:'.length);
    let method = existing ? 'thread/resume' : 'thread/start';
    let sourceThread = existing, lastTurnId: string | undefined;
    if (request.fork && existing) {
      const stored = await call('thread/read', { threadId: existing, includeTurns: true });
      const rawUsers = (stored.thread.turns as Array<{ id: string; items: any[] }>).flatMap(turn => turn.items.filter(item => item.type === 'userMessage').map(item => ({ turnId: turn.id,
        plainText: item.content.filter((input: any) => input.type === 'text').map((input: any) => input.text).join('\n'),
        text: item.content.map((input: any) => input.type === 'text' ? input.text : input.type === 'image' || input.type === 'localImage' ? '[Image]' : input.type === 'audio' || input.type === 'localAudio' ? '[Audio]' : input.type === 'mention' ? `[File: ${input.name}]` : '').filter(Boolean).join('\n') })));
      // Explicit user events can contain a literal pasted context block. Keep
      // those when the native history already matches the displayed prompts.
      const matches = rawUsers.length === request.fork.userTexts.length && rawUsers.every((user, index) => user.text === request.fork!.userTexts[index] || user.plainText === request.fork!.userTexts[index]);
      const users = (matches ? rawUsers : rawUsers.filter(user => !isRuntimeContextOnly(user.text))).map((user, index) => ({ ...user, text: user.plainText === request.fork!.userTexts[index] ? user.plainText : user.text }));
      validateForkUsers(request, users.map(user => user.text));
      const target = users[request.fork.userIndex];
      if (!target) throw new Error('The edited message is no longer in provider history.');
      lastTurnId = users[request.fork.userIndex - 1]?.turnId;
      if (lastTurnId === target.turnId) throw new Error('This message was sent inside another running turn. Edit the first message of that turn instead.');
      method = lastTurnId ? 'thread/fork' : 'thread/start';
      if (!lastTurnId) sourceThread = undefined;
    }
    // Explicit Standard clears Fast inherited from CLI config or a resumed thread.
    // CLI defaults keep the question tool disabled in Default collaboration mode.
    const config = { 'features.default_mode_request_user_input': true, ...(request.fastMode !== undefined ? { 'features.fast_mode': true } : {}) };
    const speed = request.fastMode === undefined ? { config } : { serviceTier: request.fastMode ? 'fast' : 'default', config };
    const result = await call(method, { ...(sourceThread ? { threadId: sourceThread } : {}), ...(lastTurnId ? { lastTurnId } : {}), cwd: request.project, ...(request.model ? { model: request.model } : {}), ...speed, ...codexAccess(request.accessMode) });
    threadId = result.thread.id; callbacks.session(threadId);
    if (signal.aborted) return 'interrupted';
    // A shared CLI config can name an API-only model while this process is
    // signed in with ChatGPT. Resolve that mismatch before submitting a turn.
    let model: string | undefined = request.model || undefined;
    if (result.modelProvider === 'openai') {
      const account = await call('account/read', {});
      accountIdentity = usageAccount('Codex', codexAccount(account.account, account.workspaceRouting));
      if (account.account?.type === 'chatgpt') {
        const models: Array<{ model: string; isDefault: boolean }> = [];
        let cursor: string | null = null;
        do {
          const page = await call('model/list', { limit: 100, cursor });
          models.push(...page.data); cursor = page.nextCursor ?? null;
        } while (cursor && !signal.aborted);
        if (request.model && !models.some(entry => entry.model === request.model)) throw new Error('The selected Codex model is unavailable. Refresh models and choose again.');
        if (!request.model && !models.some(entry => entry.model === result.model)) {
          model = (models.find(entry => entry.isDefault) ?? models[0])?.model;
          if (!model) throw new Error('Codex has no available chat models. Check your Codex sign-in.');
          callbacks.message({ id: `model:${request.requestId}`, role: 'tool', toolName: 'Model',
            text: `${result.model} is unavailable in the ChatGPT model catalog. Using ${model}.` });
        }
      }
    }
    if (signal.aborted) return 'interrupted';
    const started = await call('turn/start', { threadId, ...(model ? { model } : {}), ...(request.fastMode !== undefined ? { serviceTier: speed.serviceTier } : {}), effort: request.reasoningEffort || null, input: codexInput(request) });
    turnId = started.turn.id;
    attributeTurn();
    if (signal.aborted) stop();
    return await done;
  } catch (error) { if (signal.aborted) return await done; throw error; }
  finally {
    finished = true; prompts.abort(); signal.removeEventListener('abort', stop); if (stopTimer) clearTimeout(stopTimer);
    fail(new Error('Connection finished.')); lines.close();
    await terminateProcessTree(child);
    child.stdin.end();
  }
}
