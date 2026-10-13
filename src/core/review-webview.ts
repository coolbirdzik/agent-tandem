import type { ReviewFile, ReviewWebviewFile } from './review';

export interface ReviewEditorState {
  project?: string; revision?: string; group?: string;
  files: Pick<ReviewFile, 'path' | 'kind' | 'additions' | 'deletions'>[];
  file?: ReviewWebviewFile; busy: boolean; error?: string; notice?: string;
  undo?: { id: string; createdAt: number; files: string[] };
  navigation?: 'first' | 'last';
}
