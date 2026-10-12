import type { query as sdkQuery, SDKMessage, SpawnedProcess, EffortLevel, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { findExecutable } from './probe';
import { agentQuestions, questionAnswers, validateForkUsers, type ProviderChatRequest, type ChatCallbacks, type ChatResult } from './chat';
import { claudeMessages, type ClaudeHistoryAPI } from './conversations';
import { terminateProcessTree } from './process';
import { claudeAccess } from './access';
import { claudeUsage, type ContextUsage } from './context-usage';
import { claudePrompt } from './chat-input';
import { claudeAccount } from './account-status';
import { usageAccount, type UsageAccount } from '../core/usage-account';

export async function runClaudeChat(request: ProviderChatRequest, callbacks: ChatCallbacks, abortController: AbortController,
  query: typeof sdkQuery, configured = '', history?: Pick<ClaudeHistoryAPI, 'getSessionMessages'>, previousUsage?: ContextUsage): Promise<ChatResult> {
  const executable = await findExecutable('claude', configured);
  if (abortController.signal.aborted) return 'interrupted';
  let resume = request.conversationKey?.slice('Claude:'.length), resumeSessionAt: string | undefined;
  if (request.fork && resume) {
    if (!history) throw new Error('Claude session history is required to edit a message.');
    const records = await history.getSessionMessages(resume, { dir: request.project });
    const users = claudeMessages(records).filter(message => message.role === 'user');
    validateForkUsers(request, users.map(message => message.text));
    const target = users[request.fork.userIndex];
    const index = records.findIndex(record => record.uuid === target?.id);
    if (index < 0) throw new Error('The edited message is no longer in provider history.');
    resumeSessionAt = records[index - 1]?.uuid;
    if (!resumeSessionAt) resume = undefined;
    if (abortController.signal.aborted) return 'interrupted';
  }
  let child: ChildProcessWithoutNullStreams | undefined;
  let usage: ContextUsage | undefined = previousUsage, responseStartedAt: number | undefined;
  let responseUsage: Record<string, unknown> = {}, responseModel: string | undefined;
  const publishUsage = (next: ContextUsage) => { usage = next; callbacks.usage?.(next); };
  let termination: Promise<void> | undefined;
  const terminate = () => termination ??= child ? terminateProcessTree(child) : Promise.resolve();
  const questionReplies = new Map<string, Promise<PermissionResult>>();
  const askQuestions = (input: Record<string, unknown>, signal: AbortSignal, toolUseID?: string): Promise<PermissionResult> => {
    const existing = toolUseID ? questionReplies.get(toolUseID) : undefined;
    if (existing) return existing;
    const reply = (async (): Promise<PermissionResult> => {
      if (signal.aborted || abortController.signal.aborted) return { behavior: 'deny', message: 'The question was cancelled.' };
      const questions = agentQuestions(input.questions);
      const answer = await callbacks.prompt({ title: 'Claude Code needs your input', detail: '', questions }, AbortSignal.any([signal, abortController.signal]));
      if (signal.aborted || abortController.signal.aborted || !answer.answers) return { behavior: 'deny', message: 'The question was cancelled.' };
      const answers = questionAnswers(questions, answer);
      return { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(questions.map(q => [q.question, answers[q.id]!.join(', ')])) } };
    })();
    if (toolUseID) questionReplies.set(toolUseID, reply);
    return reply;
  };
  const messages = query({ prompt: claudePrompt(request), options: {
    cwd: request.project, ...(request.model ? { model: request.model } : {}), ...(request.reasoningEffort ? { effort: request.reasoningEffort as EffortLevel } : {}), resume, ...(resumeSessionAt ? { resumeSessionAt, forkSession: true } : {}),
    ...(request.preparedAttachments?.length ? { additionalDirectories: [...new Set(request.preparedAttachments.map(item => item.path.replace(/[\\/][^\\/]+$/, '')))] } : {}),
    pathToClaudeCodeExecutable: executable, abortController, includePartialMessages: true,
    // Match the CLI coding prompt; the native CLI owns its snapshots/cache markers.
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'], ...claudeAccess(request.accessMode),
    // Questions must reach the UI even when a mode/rule auto-approves tools.
    hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', timeout: 86400, hooks: [async (input, toolUseID, options) => {
      if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'AskUserQuestion') return {};
      const result = await askQuestions(input.tool_input as Record<string, unknown>, options.signal, toolUseID);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.behavior,
        ...(result.behavior === 'allow' ? { updatedInput: result.updatedInput } : { permissionDecisionReason: result.message }) } };
    }] }] },
    spawnClaudeCodeProcess: options => {
      abortController.signal.throwIfAborted();
      child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      const ownedChild = child;
      ownedChild.stderr.on('data', () => undefined);
      const forceStop = () => { void terminate().catch(() => undefined); };
      options.signal.addEventListener('abort', forceStop, { once: true });
      ownedChild.once('exit', () => options.signal.removeEventListener('abort', forceStop));
      const owned: SpawnedProcess = {
        stdin: ownedChild.stdin, stdout: ownedChild.stdout,
        get killed() { return ownedChild.killed; }, get exitCode() { return ownedChild.exitCode; }, get signalCode() { return ownedChild.signalCode; },
        kill() { forceStop(); return true; },
        on(event, listener) { ownedChild.on(event, listener); }, once(event, listener) { ownedChild.once(event, listener); }, off(event, listener) { ownedChild.off(event, listener); },
      };
      if (options.signal.aborted) forceStop();
      return owned;
    },
    canUseTool: async (tool, input, options) => {
      if (tool === 'AskUserQuestion') return askQuestions(input, options.signal, options.toolUseID);
      const persistent = !options.suppressAlwaysAllowRule ? options.suggestions?.filter(update => update.destination === 'localSettings') ?? [] : [];
      const session = !options.suppressAlwaysAllowRule ? options.suggestions?.filter(update => update.destination === 'session') ?? [] : [];
      const allowOptions = [];
      if (persistent.length) allowOptions.push({ scope: 'always' as const, label: 'Always allow', description: 'Remember this permission in this project (.claude/settings.local.json).' });
      if (session.length) allowOptions.push({ scope: 'session' as const, label: 'Always allow for this run', description: 'Remember this permission during the current agent run.' });
      const rules = persistent.length ? `\n\nPermission to remember:\n${JSON.stringify(persistent, null, 2)}` : '';
      const answer = await callbacks.prompt({ title: options.title ?? `Allow ${tool}?`, detail: JSON.stringify(input, null, 2) + rules, allowOptions }, options.signal);
      if (!answer.allow || options.signal.aborted || abortController.signal.aborted) return { behavior: 'deny', message: 'The user declined this action.' };
      const updatedPermissions = answer.allowScope === 'always' ? persistent : answer.allowScope === 'session' ? session : [];
      return { behavior: 'allow', updatedInput: input, ...(updatedPermissions.length ? { updatedPermissions } : {}) };
    },
  } });
  let streamId = '', receivedResult = false;
  let accountIdentity: UsageAccount | undefined;
  let closed = false, stopTimer: NodeJS.Timeout | undefined;
  const close = () => { if (!closed) { closed = true; messages.close(); } };
  let resolveStopped!: (value: IteratorResult<SDKMessage>) => void;
  const stopped = new Promise<IteratorResult<SDKMessage>>(resolve => { resolveStopped = resolve; });
  const stop = () => {
    if (stopTimer) return;
    // Give the SDK/CLI stdin-EOF cleanup a chance, then bound a hung iterator.
    stopTimer = setTimeout(() => resolveStopped({ done: true, value: undefined }), 1000);
    close();
  };
  abortController.signal.addEventListener('abort', stop, { once: true });
  try {
    if (abortController.signal.aborted) stop();
    if (callbacks.attributeUsage && typeof messages.accountInfo === 'function' && !abortController.signal.aborted) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const identity = await Promise.race([messages.accountInfo(), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 5000); }), stopped.then(() => undefined)]);
        accountIdentity = usageAccount('Claude', identity && claudeAccount(identity));
      } catch { /* Missing identity must leave usage unknown, without failing chat. */ }
      finally { if (timer) clearTimeout(timer); }
    }
    while (!abortController.signal.aborted) {
      const next = await Promise.race([messages.next(), stopped]);
      if (next.done || abortController.signal.aborted) break;
      const message = next.value;
      if (message.session_id) callbacks.session(message.session_id);
      consume(message);
      if (message.type === 'result' && typeof messages.getContextUsage === 'function') {
        // Summary uses local estimates/last usage, without per-category API calls.
        // Older CLIs may reject this control request; telemetry cannot fail a turn.
        let timer: NodeJS.Timeout | undefined;
        try {
          const context = await Promise.race([messages.getContextUsage({ detail: 'summary' }), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1500); })]);
          if (context && !abortController.signal.aborted) publishUsage({ ...usage, usedTokens: context.totalTokens, windowTokens: context.rawMaxTokens ?? context.maxTokens, model: context.model });
        } catch { /* Optional capability in the selected CLI. */ }
        finally { if (timer) clearTimeout(timer); }
      }
    }
    if (abortController.signal.aborted) return 'interrupted';
    if (!receivedResult) throw new Error('Claude ended without a completed response.');
    return 'completed';
  } catch (error) { if (abortController.signal.aborted) return 'interrupted'; throw error; }
  finally {
    abortController.signal.removeEventListener('abort', stop); if (stopTimer) clearTimeout(stopTimer);
    // Reap children before review capture so a stopped tool cannot keep writing.
    await terminate(); close();
  }
  function consume(message: SDKMessage) {
    // Streaming message_start is a new API response, unlike replayed history on resume.
    // Attribute only IDs actually observed from this running CLI process.
    if (message.type === 'stream_event' && message.event.type === 'message_start' && accountIdentity) {
      callbacks.attributeUsage?.(`Claude:${message.event.message.id}`, accountIdentity);
    }
    if (message.type === 'stream_event' && !message.parent_tool_use_id) {
      const event = message.event;
      if (event.type === 'message_start') { streamId = event.message.id; responseStartedAt = Date.now(); responseUsage = { ...event.message.usage }; responseModel = event.message.model; }
      if (event.type === 'message_delta') {
        responseUsage = { ...responseUsage, ...event.usage };
        const next = claudeUsage(responseUsage, responseModel, responseStartedAt, usage); if (next) publishUsage(next);
      }
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') callbacks.activity?.(event.content_block.id, `Using ${event.content_block.name}…`);
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') callbacks.message({ id: streamId, role: 'assistant', text: event.delta.text }, true);
    }
    if (message.type === 'assistant') {
      if (!message.parent_tool_use_id) {
        const next = claudeUsage(message.message.usage, message.message.model, responseStartedAt ?? Date.now(), usage);
        if (next) publishUsage(next);
        if (message.context_usage) publishUsage({ ...usage, usedTokens: message.context_usage.total_tokens, windowTokens: message.context_usage.raw_max_tokens, model: message.context_usage.model });
      }
      const text = message.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (text) callbacks.message({ id: message.message.id, role: 'assistant', text });
      for (const block of message.message.content) if (block.type === 'tool_use') {
        callbacks.activity?.(block.id, `Using ${block.name}…`);
        callbacks.message({ id: block.id, role: 'tool', toolName: block.name, text: JSON.stringify(block.input, null, 2) });
      }
    }
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) if (block.type === 'tool_result') {
        callbacks.activity?.(block.tool_use_id);
        callbacks.message({ id: `${block.tool_use_id}:result`, role: 'tool', toolName: 'Result', text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2) });
      }
    }
    if (message.type === 'result') {
      // Model totals are cumulative and include tools/subagents: use only the
      // reported capacity for the main model, never their token sum as context.
      const modelUsage = usage?.model ? message.modelUsage?.[usage.model] : undefined;
      if (modelUsage?.contextWindow && usage) publishUsage({ ...usage, windowTokens: modelUsage.contextWindow });
      receivedResult = true;
      if (message.is_error) throw new Error(message.subtype === 'success' ? message.result : message.errors.join('\n'));
    }
  }
}
