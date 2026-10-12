import { describe, expect, it } from 'vitest';
import { ChatQueue } from '../src/core/chat-queue';
import { ChatQueueStore } from '../src/core/chat-queue-store';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatRequest, ChatState } from '../src/providers/chat';
const chat: ChatState = { requestId: 'active', provider: 'Codex', conversationKey: 'Codex:draft-active', status: 'running', prompts: [], model: 'native-model', accessMode: 'full-access', reasoningEffort: 'low', fastMode: true };
const request = (id: string): ChatRequest => ({ requestId: id, project: '/project', provider: 'Codex', text: id, model: 'untrusted-other-model' });
const conversation = { key: 'Codex:native', id: 'native', provider: 'Codex' as const, title: 'Chat', cwd: '/project', updatedAt: 1, revision: '1' };
describe('host message queue', () => {
  it('restores Windows projects independently of drive case and extended prefixes', () => {
    const original = new ChatQueue(); original.enqueue({ ...request('one'), project: 'L:\\Code\\repo' }, chat, chat.conversationKey);
    const restored = new ChatQueue(original.snapshot());
    expect(restored.state('\\\\?\\l:\\Code\\repo')!.items[0]!.project).toBe('\\\\?\\l:\\Code\\repo');
    expect(restored.state('L:\\Code\\other')).toBeUndefined();
  });
  it('atomically persists the latest queue and reloads independently of VS Code memento flushing', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-queue-'));
    try {
      const store = new ChatQueueStore(directory, 'workspace'), queue = new ChatQueue(); queue.enqueue(request('one'), chat, chat.conversationKey);
      const first = store.save(queue.snapshot()); queue.enqueue(request('two'), chat, chat.conversationKey); const second = store.save(queue.snapshot());
      await Promise.all([first, second]);
      const restored = new ChatQueue(await new ChatQueueStore(directory, 'workspace').read());
      expect(restored.state('/project')!.items.map(item => item.text)).toEqual(['one', 'two']);
      expect(await new ChatQueueStore(directory, 'other-workspace').read()).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('runs FIFO with the active settings and binds early messages to the eventual native session', () => {
    const queue = new ChatQueue();
    queue.enqueue(request('one'), chat, chat.conversationKey); queue.enqueue(request('two'), chat, chat.conversationKey);
    queue.bind('/project', chat.conversationKey!, conversation.key);
    expect(queue.next('/project', conversation)).toMatchObject({ requestId: 'one', conversationKey: conversation.key, model: 'native-model', accessMode: 'full-access', reasoningEffort: 'low', fastMode: true });
    expect(queue.next('/project', conversation)?.requestId).toBe('two'); expect(queue.state('/project')).toBeUndefined();
  });
  it('rejects other conversations, duplicate IDs and edit/resend while an agent is running', () => {
    const queue = new ChatQueue(); queue.enqueue(request('one'), chat, chat.conversationKey);
    expect(() => queue.enqueue(request('two'), chat, 'Codex:elsewhere')).toThrow('active conversation');
    expect(() => queue.enqueue({ ...request('two'), provider: 'Claude' }, chat, chat.conversationKey)).toThrow();
    expect(() => queue.enqueue(request('one'), chat, chat.conversationKey)).toThrow('already queued');
    expect(() => queue.enqueue({ ...request('two'), edit: { messageId: 'm', revision: 'r' } }, chat, chat.conversationKey)).toThrow();
    expect(() => queue.enqueue(request('other'), { ...chat, conversationKey: 'Codex:other' }, 'Codex:other')).toThrow('existing queue');
  });
  it('supports editing/removal and rejects stale actions or empty text', () => {
    const queue = new ChatQueue(); queue.enqueue(request('one'), chat, chat.conversationKey); queue.enqueue(request('two'), chat, chat.conversationKey);
    queue.edit('/project', 'one', 'Changed'); expect(queue.state('/project')!.items[0]!.text).toBe('Changed');
    expect(() => queue.edit('/project', 'one', ' ')).toThrow();
    queue.remove('/project', 'one'); expect(queue.state('/project')!.items.map(row => row.requestId)).toEqual(['two']);
    expect(() => queue.remove('/project', 'one')).toThrow('already started');
  });
  it('pauses after Stop/failure/root changes and restores failed sends without changing order', () => {
    const queue = new ChatQueue(); queue.enqueue(request('one'), chat, chat.conversationKey); queue.enqueue(request('two'), chat, chat.conversationKey);
    queue.bind('/project', chat.conversationKey!, conversation.key); queue.pause('/project', 'Stopped');
    expect(queue.next('/project', conversation)).toBeUndefined(); queue.resume('/project');
    const first = queue.next('/project', conversation)!; queue.restore(first, 'Save dirty file');
    expect(queue.state('/project')!.items.map(row => row.requestId)).toEqual(['one', 'two']); expect(queue.next('/project', conversation)).toBeUndefined();
    queue.resume('/project'); expect(queue.next('/project', { ...conversation, key: 'Codex:wrong' })).toBeUndefined();
    expect(queue.state('/project')!.paused).toContain('Open'); expect(queue.state('/other')).toBeUndefined();
  });
  it('persists messages but resumes manually after an extension reload', () => {
    const original = new ChatQueue(); original.enqueue(request('one'), chat, chat.conversationKey); original.bind('/project', chat.conversationKey!, conversation.key);
    const restored = new ChatQueue(JSON.parse(JSON.stringify(original.snapshot())));
    expect(restored.next('/project', conversation)).toBeUndefined(); expect(restored.state('/project')!.paused).toContain('Reloaded');
    restored.resume('/project'); expect(restored.next('/project', conversation)?.text).toBe('one');
    expect(new ChatQueue([{ project: '/project', conversationKey: 'bad', items: [{ bad: true }] }]).snapshot()).toEqual([]);
  });
});
