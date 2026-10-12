import type { ConversationContent, ConversationMessage, ConversationProvider } from './conversations';
import { accessMode, type AccessMode } from './access';
import { modelId } from './models';
import { effortId } from './effort';
import { fastMode } from './fast-mode';
import { chatAttachments, type ChatAttachment } from '../core/attachments';
import type { PreparedAttachment } from '../core/attachment-store';

export interface ChatEdit { messageId: string; revision: string }
export interface ChatRequest { requestId: string; project: string; provider: ConversationProvider; text: string; attachments?: ChatAttachment[]; conversationKey?: string; edit?: ChatEdit; accessMode?: AccessMode; model?: string; reasoningEffort?: string; fastMode?: boolean }
/** Fork boundaries are derived by the host, never accepted from the webview. */
export interface ProviderChatRequest extends ChatRequest { preparedAttachments?: PreparedAttachment[]; fork?: { userIndex: number; userTexts: string[] } }
export function editChat(request: ChatRequest, content: ConversationContent): { messages: ConversationMessage[]; fork: NonNullable<ProviderChatRequest['fork']> } {
  if (!request.edit || request.conversationKey !== content.conversation.key || request.provider !== content.conversation.provider || request.edit.revision !== content.conversation.revision) throw new Error('The conversation changed. Edit the message again.');
  const index = content.messages.findIndex(message => message.id === request.edit!.messageId && message.role === 'user');
  if (index < 0) throw new Error('Choose one of your messages to edit.');
  const users = content.messages.filter(message => message.role === 'user');
  return { messages: content.messages.slice(0, index), fork: { userIndex: users.findIndex(message => message.id === request.edit!.messageId), userTexts: users.map(message => message.text) } };
}
export function validateForkUsers(request: ProviderChatRequest, texts: string[]) {
  if (request.fork && (texts.length !== request.fork.userTexts.length || texts.some((text, index) => text !== request.fork!.userTexts[index]))) throw new Error('Provider history changed. Refresh and edit the message again.');
}
export interface AgentQuestion { id: string; question: string; header?: string; multiSelect?: boolean; isSecret?: boolean; options?: Array<{ label: string; description?: string }> }
export type AllowScope = 'always' | 'session';
export interface AgentPrompt { id: string; title: string; detail: string; questions?: AgentQuestion[]; allowOptions?: Array<{ scope: AllowScope; label: string; description: string }> }
export interface PromptAnswer { id: string; allow?: boolean; allowScope?: AllowScope; answers?: Record<string, string | string[]> }
/** Claude questions have no ID; Codex IDs must be kept for its RPC response. */
export function agentQuestions(value: unknown): AgentQuestion[] {
  if (!Array.isArray(value) || !value.length) throw new Error('The agent sent no questions.');
  const ids = new Set<string>();
  return value.map((q, index) => {
    if (!q || typeof q !== 'object' || typeof q.question !== 'string' || !q.question.trim()) throw new Error('The agent sent an invalid question.');
    const id = typeof q.id === 'string' && q.id ? q.id : `question-${index}`;
    if (ids.has(id)) throw new Error('The agent sent duplicate question IDs.');
    ids.add(id);
    if (q.options != null && (!Array.isArray(q.options) || q.options.some((option: any) => !option || typeof option.label !== 'string' || !option.label.trim()))) throw new Error('The agent sent invalid question options.');
    return { id, question: q.question, ...(typeof q.header === 'string' ? { header: q.header } : {}),
      multiSelect: q.multiSelect === true, isSecret: q.isSecret === true,
      ...(Array.isArray(q.options) ? { options: q.options.map((option: any) => ({ label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) })) } : {}) };
  });
}
export function questionAnswers(questions: AgentQuestion[], answer: PromptAnswer): Record<string, string[]> {
  return Object.fromEntries(questions.map(q => {
    const value = answer.answers?.[q.id], values = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(values) || !values.length || values.some(text => typeof text !== 'string' || !text.trim()) || (!q.multiSelect && values.length > 1)) throw new Error('Answer each agent question before replying.');
    return [q.id, values];
  }));
}
export interface ChatState { requestId: string; provider: ConversationProvider; conversationKey?: string; accessMode?: AccessMode; model?: string; reasoningEffort?: string; fastMode?: boolean; status: 'running' | 'completed' | 'failed' | 'interrupted'; prompts: AgentPrompt[]; phase?: 'preparing' | 'working' | 'stopping' | 'finishing'; activity?: string }
export interface ChatCallbacks {
  attributeUsage?(key: string, account: import('../core/usage-account').UsageAccount): void;
  usage?(usage: import('./context-usage').ContextUsage): void;
  session(id: string): void;
  message(message: ConversationMessage, append?: boolean): void;
  activity?(id: string, label?: string): void;
  prompt(prompt: Omit<AgentPrompt, 'id'>, signal: AbortSignal): Promise<PromptAnswer>;
}
export type ChatResult = 'completed' | 'interrupted';
export function promptAnswer(value: unknown): PromptAnswer {
  if (!value || typeof value !== 'object') throw new Error('Invalid agent answer.');
  const answer = value as PromptAnswer;
  if (typeof answer.id !== 'string' || !answer.id || (answer.allow !== undefined && typeof answer.allow !== 'boolean') ||
    (answer.allowScope !== undefined && (!['always', 'session'].includes(answer.allowScope) || answer.allow !== true)) ||
    (answer.answers !== undefined && (!answer.answers || typeof answer.answers !== 'object' || Array.isArray(answer.answers) || Object.values(answer.answers).some(a => typeof a !== 'string' && (!Array.isArray(a) || !a.length || a.some(text => typeof text !== 'string')))))) throw new Error('Invalid agent answer.');
  return answer;
}
export function chatRequest(value: unknown): ChatRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid chat request.');
  const r = value as Record<string, unknown>;
  const attachments = r.attachments === undefined ? undefined : chatAttachments(r.attachments);
  if (typeof r.requestId !== 'string' || !r.requestId || typeof r.project !== 'string' ||
    (r.provider !== 'Codex' && r.provider !== 'Claude') || typeof r.text !== 'string' || (!r.text.trim() && !attachments?.length) ||
    r.text.length > 200_000 || (r.conversationKey !== undefined && typeof r.conversationKey !== 'string')) throw new Error('Enter a message and choose an agent.');
  const edit = r.edit as ChatEdit | undefined;
  if (r.fastMode !== undefined && r.provider !== 'Codex') throw new Error('Fast mode is only supported for Codex.');
  if (edit !== undefined && (!edit || typeof edit !== 'object' || typeof edit.messageId !== 'string' || !edit.messageId || typeof edit.revision !== 'string' || !edit.revision || !r.conversationKey)) throw new Error('Choose a saved message to edit.');
  return { requestId: r.requestId, project: r.project, provider: r.provider, text: r.text, conversationKey: r.conversationKey as string | undefined,
    ...(attachments?.length ? { attachments } : {}),
    ...(r.model !== undefined ? { model: modelId(r.model) } : {}),
    ...(r.reasoningEffort !== undefined ? { reasoningEffort: effortId(r.reasoningEffort) } : {}),
    ...(r.fastMode !== undefined ? { fastMode: fastMode(r.fastMode) } : {}),
    ...(r.accessMode !== undefined ? { accessMode: accessMode(r.accessMode, r.provider) } : {}),
    ...(edit ? { edit: { messageId: edit.messageId, revision: edit.revision } } : {}) };
}
