import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
let threadId = 'thread-fixture', readSource = false, forkBoundary, access, threadModel;
let mode = '', turnId = 'turn-fixture';
let threadSpeed;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line), p = message.params;
  if (process.env.AGENT_DOCK_RPC_LOG) appendFileSync(process.env.AGENT_DOCK_RPC_LOG, JSON.stringify(message) + '\n');
  const modelCase = process.env.AGENT_DOCK_MODEL_CASE;
  if (message.method === 'initialize' && modelCase !== 'hung-init') write({ id: message.id, result: {} });
  if (message.method === 'account/read' && modelCase === 'hung-model') return;
  if (['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) { access = { approvalPolicy: p.approvalPolicy, sandbox: p.sandbox }; threadModel = p.model; }
  if (['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) threadSpeed = { serviceTier: p.serviceTier, config: p.config };
  if (message.method === 'thread/read') {
    readSource = true;
    const turns = ['first', 'second', 'third'].map((text, index) => ({ id: `history-turn-${index}`, items: [{ type: 'userMessage', content: [{ type: 'text', text }] }] }));
    if (modelCase === 'image-history') turns[0].items[0].content.push({ type: 'image', url: 'data:image/png;base64,AQID' });
    if (modelCase === 'context-history') turns.unshift({ id: 'page-context-turn', items: [{ type: 'userMessage', content: [{ type: 'text', text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>' }] }] });
    if (modelCase === 'context-history') turns.unshift({ id: 'runtime-context-turn', items: [{ type: 'userMessage', content: [{ type: 'text', text: '<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n- GitHub\n</recommended_plugins>\n<environment_context><cwd>H:\\Code\\aot-new</cwd><shell>powershell</shell></environment_context>' }] }] });
    write({ id: message.id, result: { thread: { id: threadId, turns } } });
  }
  if (message.method === 'thread/start' && readSource) threadId = 'thread-new';
  if (message.method === 'thread/fork') {
    threadId = 'thread-branch'; forkBoundary = p.lastTurnId;
    write({ id: message.id, result: { thread: { id: threadId }, model: 'fixture-supported', modelProvider: 'openai' } });
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') write({ id: message.id, result: { thread: { id: p.threadId ?? threadId },
    model: modelCase === 'supported' ? 'fixture-supported' : 'fixture-unavailable', modelProvider: modelCase === 'custom' ? 'custom' : 'openai' } });
  if (message.method === 'account/read') write({ id: message.id, result: { account: { type: modelCase === 'api' ? 'apiKey' : 'chatgpt', ...(modelCase !== 'api' ? { email: 'native-codex@example.test' } : {}) } } });
  if (message.method === 'model/list') write({ id: message.id, result: {
    data: modelCase === 'empty' ? [] : p.cursor ? [{ model: 'fixture-default', isDefault: true }] : [{ model: 'fixture-supported', isDefault: false,
      defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'ultra' }] }],
    nextCursor: modelCase === 'empty' || p.cursor ? null : 'page-two' } });
  if (message.method === 'turn/start') {
    if (modelCase === 'hung-turn-start') { write({ method: 'turn/started', params: { threadId, turn: { id: turnId } } }); return; }
    mode = p.input[0]?.text;
    if (mode === 'attachment-check') {
      write({ id: message.id, result: { turn: { id: turnId } } });
      write({ method: 'item/completed', params: { threadId, item: { id: 'attachments', type: 'agentMessage', text: JSON.stringify(p.input) } } });
      complete('completed'); return;
    }
    if (mode === 'fast-mode-check') {
      write({ id: message.id, result: { turn: { id: turnId } } });
      write({ method: 'item/completed', params: { threadId, item: { id: 'speed-result', type: 'agentMessage', text: JSON.stringify({ threadSpeed, turnTier: p.serviceTier }) } } });
      complete('completed'); return;
    }
    if (mode === 'usage-check') {
      write({ id: message.id, result: { turn: { id: turnId } } });
      const tokenUsage = { last: { totalTokens: 4200, cachedInputTokens: 3000 }, total: { totalTokens: 90000 }, modelContextWindow: 128000 };
      write({ method: 'thread/tokenUsage/updated', params: { threadId: 'other-thread', tokenUsage: { ...tokenUsage, last: { totalTokens: 1 } } } });
      write({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage } });
      complete('completed'); return;
    }
    if (mode === 'effort-check') {
      write({ id: message.id, result: { turn: { id: turnId } } });
      write({ method: 'item/completed', params: { threadId, item: { id: 'effort-result', type: 'agentMessage', text: JSON.stringify({ effort: p.effort }) } } });
      complete('completed'); return;
    }
    if (mode === 'access-check') {
      write({ id: message.id, result: { turn: { id: turnId } } });
      write({ method: 'item/completed', params: { threadId, item: { id: 'access-result', type: 'agentMessage', text: JSON.stringify(access) } } });
      complete('completed'); return;
    }
    if (mode === 'branch-check') {
      write({ id: message.id, result: { turn: { id: turnId } } });
      write({ method: 'item/completed', params: { threadId, item: { id: 'branch-result', type: 'agentMessage', text: JSON.stringify({ threadId, forkBoundary }) } } });
      complete('completed'); return;
    }
    if (mode === 'model-boundary-check') {
      write({ id: message.id, result: { turn: { id: turnId } } });
      write({ method: 'item/completed', params: { threadId, item: { id: 'model-boundary', type: 'agentMessage', text: JSON.stringify({ threadModel, turnModel: p.model }) } } });
      complete('completed'); return;
    }
    if (mode === 'model-check') {
      write({ id: message.id, result: { turn: { id: turnId } } });
      write({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
      write({ method: 'item/completed', params: { threadId, item: { id: 'selected-model', type: 'agentMessage', text: p.model ?? 'unchanged' } } });
      complete('completed'); return;
    }
    write({ id: message.id, result: { turn: { id: turnId } } });
    write({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
    if (mode === 'exit') { process.exit(1); return; }
    if (mode === 'wait') return;
    if (mode === 'fail') { complete('failed', { message: 'Fixture authentication failed.' }); return; }
    if (mode === 'tool') {
      write({ method: 'item/started', params: { threadId, item: { id: 'tool-1', type: 'commandExecution', command: 'echo fixture', status: 'inProgress' } } });
      write({ method: 'item/completed', params: { threadId, item: { id: 'tool-1', type: 'commandExecution', command: 'echo fixture', aggregatedOutput: 'fixture', status: 'completed' } } });
    }
    if (mode === 'questions' || mode === 'questions-wait') {
      write({ id: 'question-1', method: 'item/tool/requestUserInput', params: { threadId, turnId, questions: [
        { id: 'render', header: 'Rendering', question: 'How should Accept/Reject appear on each change block?', options: [{ label: 'CodeLens per hunk (Recommended)', description: 'Official API, one row per hunk.' }, { label: 'Inset + CodeLens fallback', description: 'Works in every environment.' }] },
        { id: 'scope', header: 'Scope', question: 'Where should this apply?', options: null },
      ] } }); return;
    }
    if (mode.startsWith('approve')) {
      write({ id: 'stale-approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'earlier-turn', command: 'wrong command' } });
      write({ id: 'approval-1', method: mode === 'approve-permissions' ? 'item/permissions/requestApproval' : mode === 'approve-file' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', params: {
        threadId, turnId, reason: 'Run a fixture command?', command: 'echo fixture',
        ...(mode === 'approve-persistent' || mode === 'approve-limited' ? { proposedExecpolicyAmendment: ['echo', 'fixture'] } : {}),
        ...(mode === 'approve-limited' ? { availableDecisions: ['accept', 'decline'] } : {}),
        ...(mode === 'approve-network' ? { networkApprovalContext: { host: 'example.test', protocol: 'https' }, availableDecisions: ['accept', 'acceptForSession', 'decline', { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: 'allow' } } }] } : {}),
        ...(mode === 'approve-permissions' ? { permissions: { network: { enabled: true } } } : {}),
      } }); return;
    }
    reply();
  }
  if (message.id === 'approval-1' && message.result) {
    write({ method: 'item/completed', params: { threadId, item: { id: 'tool-1', type: 'commandExecution', command: 'echo fixture', aggregatedOutput: typeof message.result.decision === 'string' ? message.result.decision : JSON.stringify(message.result.decision ?? message.result), status: 'completed' } } }); reply();
  }
  if (message.id === 'question-1' && message.result) {
    write({ method: 'item/completed', params: { threadId, item: { id: 'question-result', type: 'agentMessage', text: JSON.stringify({ ...message.result, config: threadSpeed.config }) } } }); complete('completed');
  }
  if (message.method === 'turn/interrupt' && !['hung-turn-start', 'hung-interrupt'].includes(modelCase)) { write({ id: message.id, result: {} }); complete('interrupted'); }
});
function complete(status, error) { write({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status, error } } }); }
function reply() {
  // Unrelated threads and misleading earlier turns must not finish this turn.
  write({ method: 'item/agentMessage/delta', params: { threadId: 'other-thread', itemId: 'wrong', delta: 'wrong' } });
  write({ method: 'turn/completed', params: { threadId, turn: { id: 'earlier-turn', status: 'completed' } } });
  write({ method: 'item/started', params: { threadId, item: { id: 'a1', type: 'agentMessage', text: '' } } });
  for (const delta of ['Hello ', 'world']) write({ method: 'item/agentMessage/delta', params: { threadId, itemId: 'a1', delta } });
  write({ method: 'item/completed', params: { threadId, item: { id: 'a1', type: 'agentMessage', text: 'Hello world' } } });
  complete('completed');
}
