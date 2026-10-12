import { chatRequest, type ChatRequest, type ChatState } from '../providers/chat';
import type { Conversation } from '../providers/conversations';
import path from 'node:path';
import { attachmentBytes } from './attachments';
const projectKey = (project: string) => /^[a-z]:[\\/]|^\\\\/i.test(project) ? path.win32.resolve(project.replace(/^\\\\\?\\/, '')).toLowerCase() : path.resolve(project);

export interface ChatQueueState { project: string; provider: ChatRequest['provider']; conversationKey: string; items: ChatRequest[]; paused?: string }
/** Host-owned FIFO, bound to a conversation even while its native ID is being assigned. */
export class ChatQueue {
  private queues = new Map<string, ChatQueueState>();
  constructor(saved: unknown = []) {
    if (!Array.isArray(saved)) return;
    for (const row of saved) {
      try {
        if (!row || typeof row.project !== 'string' || typeof row.conversationKey !== 'string' || !Array.isArray(row.items)) continue;
        const items = row.items.map(chatRequest).filter((item: ChatRequest) => item.project === row.project && item.provider === row.provider && !item.edit);
        if (items.length) this.queues.set(projectKey(row.project), { project: row.project, provider: items[0]!.provider, conversationKey: row.conversationKey, items, paused: 'Reloaded. Resume when you are ready.' });
      } catch { /* Ignore corrupt saved queue data. */ }
    }
  }
  state(project?: string) {
    const queue = project ? this.queues.get(projectKey(project)) : undefined;
    if (queue && project && queue.project !== project) { queue.project = project; for (const item of queue.items) item.project = project; }
    return queue;
  }
  snapshot() { return [...this.queues.values()]; }
  enqueue(request: ChatRequest, chat: ChatState, selectedKey?: string) {
    if (request.edit || selectedKey !== chat.conversationKey || request.provider !== chat.provider || (request.conversationKey && request.conversationKey !== chat.conversationKey)) throw new Error('Queue messages in the active conversation.');
    const existing = this.state(request.project);
    if (existing && (existing.conversationKey !== chat.conversationKey || existing.provider !== chat.provider)) throw new Error('Remove or resume the existing queue before queuing another conversation.');
    const queue = existing ?? { project: request.project, provider: chat.provider, conversationKey: chat.conversationKey!, items: [] };
    if (queue.items.some(item => item.requestId === request.requestId) || request.requestId === chat.requestId) throw new Error('This message is already queued.');
    if (queue.items.length >= 50) throw new Error('The queue is full. Remove a message before adding more.');
    const bytes = [...queue.items, request].reduce((sum, item) => sum + (item.attachments ?? []).reduce((size, attachment) => size + attachmentBytes(attachment), 0), 0);
    if (bytes > 100 * 1024 * 1024) throw new Error('Queued attachments exceed 100 MB. Remove a queued attachment before adding more.');
    queue.items.push({ ...request, conversationKey: queue.conversationKey, accessMode: chat.accessMode, model: chat.model, reasoningEffort: chat.reasoningEffort, ...(chat.provider === 'Codex' ? { fastMode: chat.fastMode } : {}) });
    this.queues.set(projectKey(request.project), queue);
  }
  bind(project: string, before: string, after: string) {
    const queue = this.state(project); if (queue?.conversationKey !== before) return;
    queue.conversationKey = after;
    for (const item of queue.items) item.conversationKey = after;
  }
  pause(project: string, reason: string) { const queue = this.state(project); if (queue) queue.paused = reason; }
  resume(project: string) { const queue = this.state(project); if (queue) delete queue.paused; }
  remove(project: string, id: string) {
    const queue = this.state(project); if (!queue) throw new Error('This queue has closed.');
    const index = queue.items.findIndex(item => item.requestId === id); if (index < 0) throw new Error('This queued message has already started.');
    const [removed] = queue.items.splice(index, 1); if (!queue.items.length) this.queues.delete(projectKey(project)); return removed!;
  }
  edit(project: string, id: string, text: string) {
    const item = this.state(project)?.items.find(item => item.requestId === id); if (!item) throw new Error('This queued message has already started.');
    Object.assign(item, chatRequest({ ...item, text }));
  }
  next(project: string, conversation?: Conversation): ChatRequest | undefined {
    const queue = this.state(project); if (!queue || queue.paused) return;
    if (!conversation?.id || conversation.key !== queue.conversationKey) { queue.paused = 'Open the queued conversation and resume.'; return; }
    const item = queue.items.shift(); if (!queue.items.length) this.queues.delete(projectKey(project));
    return item ? { ...item, conversationKey: conversation.key } : undefined;
  }
  restore(request: ChatRequest, reason: string) {
    const queue = this.state(request.project) ?? { project: request.project, provider: request.provider, conversationKey: request.conversationKey!, items: [] };
    queue.items.unshift(request); queue.paused = reason; this.queues.set(projectKey(request.project), queue);
  }
}
