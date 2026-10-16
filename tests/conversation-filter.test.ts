import { describe, expect, it } from 'vitest';
import { conversationFilter, matchesConversation } from '../src/core/conversation-filter';

const row = (time: number) => ({ provider: 'Codex' as const, archived: false, title: 'Chat', project: '/repo', id: 'id', updatedAt: time + 1, lastMessageAt: time });
describe('Conversation filter', () => {
  it('bounds the last message time with an inclusive start and exclusive end', () => {
    const filter = conversationFilter({ after: 1000, before: 2000 });
    expect([999, 1000, 1999, 2000].map(time => matchesConversation(row(time), filter))).toEqual([false, true, true, false]);
    expect(conversationFilter({ before: 2000 })).toEqual({ before: 2000 });
  });
});
