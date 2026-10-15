import type { ReviewFile } from './review';
import type { ReviewConversation } from './review-conversations';

export function fileConversations(file: ReviewFile): ReviewConversation[] {
  return [...new Map(file.captures?.flatMap(capture => capture.conversations ?? []).map(conversation => [conversation.key, conversation]) ?? []).values()];
}
export function reviewGroup(file: ReviewFile): string {
  const sources = fileConversations(file);
  if (!sources.length) return 'unassigned';
  if (sources.length > 1 || file.captures?.some(capture => !capture.conversations?.length)) return 'shared';
  return sources[0]!.key;
}

export const hasUnassignedCaptures = (file: ReviewFile) => !file.captures?.length || file.captures.some(capture => !capture.conversations?.length);
export const hasManualConversationLink = (file: ReviewFile) => !!file.captures?.some(capture => capture.assignment === 'manual');
