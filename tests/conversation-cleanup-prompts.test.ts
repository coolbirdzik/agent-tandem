import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CleanupConversation, ConversationCleanupPlan } from '../src/core/conversation-cleanup';
const host = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));
vi.mock('vscode', () => ({ window: { showWarningMessage: host.warning, showErrorMessage: host.error } }));
import { conversationCleanupPrompts } from '../src/host/conversation-cleanup-prompts';

const row: CleanupConversation = { key: 'Codex:id', id: 'id', provider: 'Codex', title: '<Old chat>', project: '/repo', archived: true, updatedAt: 1, bytes: 1, files: [] };
const plan: ConversationCleanupPlan = { token: 'token', createdAt: Date.now(), conversations: [row], bytes: 1 };
beforeEach(() => { vi.resetAllMocks(); });
describe('Conversation cleanup prompts', () => {
  it('confirms the exact count and every matching condition and defaults to cancellation', async () => {
    const filter = { before: 2000, after: 1000, provider: 'Codex', archived: true, query: ' old chat ' };
    const prompts = conversationCleanupPrompts({ filter });
    expect(await prompts.confirm!(plan)).toBe(false);
    const [message, options, action] = host.warning.mock.lastCall!;
    expect(message).toBe('Delete 1 conversation permanently?'); expect(options.modal).toBe(true);
    for (const text of ['All conversations matching', 'Provider: Codex', 'before:', 'on or after:', 'Archived', 'Search: old chat', 'subagent history']) expect(options.detail).toContain(text);
    host.warning.mockResolvedValue(action); expect(await prompts.confirm!(plan)).toBe(true);
  });
  it('offers Skip, Skip All and Cancel and explains the scope of Skip All', async () => {
    const prompts = conversationCleanupPrompts({});
    for (const [choice, expected] of [['Skip', 'skip'], ['Skip All', 'skipAll'], ['Cancel', 'cancel'], [undefined, 'cancel']]) {
      host.error.mockResolvedValue(choice ? { title: choice } : undefined);
      expect(await prompts.onError!(row, 'Locked transcript')).toBe(expected);
    }
    const [message, options, ...actions] = host.error.mock.lastCall!;
    expect(message).toContain('<Old chat>'); expect(options).toMatchObject({ modal: true, detail: expect.stringContaining('Locked transcript') });
    expect(options.detail).toContain('same provider and exact error');
    expect(actions).toEqual([{ title: 'Skip' }, { title: 'Skip All' }, { title: 'Cancel', isCloseAffordance: true }]);
  });
});
