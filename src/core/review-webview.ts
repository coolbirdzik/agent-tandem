import type { ReviewFile, ReviewWebviewFile } from './review';
import type { ReviewConversation } from './review-conversations';
import { fileConversations, reviewGroup } from './review-groups';

export interface ReviewContext {
  group: string; title: string; conversation?: ReviewConversation; canOpenConversation?: boolean;
  files: Pick<ReviewFile, 'path' | 'kind' | 'additions' | 'deletions'>[];
}
export function reviewContext(files: ReviewFile[], selected: ReviewFile): ReviewContext {
  const group = reviewGroup(selected), conversation = fileConversations(selected).find(source => source.key === group);
  return { group, conversation, title: conversation?.title ?? (group === 'shared' ? 'Shared workspace changes' : 'Unassigned workspace changes'),
    files: files.filter(file => reviewGroup(file) === group).map(({ path, kind, additions, deletions }) => ({ path, kind, additions, deletions })) };
}

export interface ReviewEditorState {
  project?: string; revision?: string; group?: string;
  files: Pick<ReviewFile, 'path' | 'kind' | 'additions' | 'deletions'>[];
  file?: ReviewWebviewFile; busy: boolean; error?: string; notice?: string;
  undo?: { id: string; createdAt: number; files: string[] };
  navigation?: 'first' | 'last';
  context?: ReviewContext;
}
