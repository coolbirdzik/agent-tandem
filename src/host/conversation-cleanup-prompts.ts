import * as vscode from 'vscode';
import type { DeletionProgress } from '../core/conversation-cleanup';
import { conversationFilter, validCutoff } from '../core/conversation-filter';

export function conversationCleanupPrompts(request: { filter?: unknown; keys?: unknown; before?: unknown }): Pick<DeletionProgress, 'confirm' | 'onError'> {
  return {
    confirm: async plan => {
      const filter = request.filter !== undefined ? conversationFilter(request.filter)
        : request.keys !== undefined ? { before: validCutoff(request.before) } : undefined;
      const conditions = filter ? [
        request.filter !== undefined ? 'All conversations matching these filters.' : 'Selected conversations only.',
        `Provider: ${filter.provider ?? [...new Set(plan.conversations.map(row => row.provider))].join(', ')}`,
        `Last message before: ${new Date(filter.before).toLocaleString()} (exclusive)`,
        filter.after !== undefined ? `Last message on or after: ${new Date(filter.after).toLocaleString()} (inclusive)` : '',
        `Archive status: ${filter.archived === undefined ? 'Any' : filter.archived ? 'Archived' : 'Unarchived'}`,
        `Search: ${filter.query?.trim() || 'Any'}`
      ].filter(Boolean).join('\n') : 'Only the conversations in the reviewed deletion preview.';
      const count = plan.conversations.length;
      return await vscode.window.showWarningMessage(`Delete ${count} conversation${count === 1 ? '' : 's'} permanently?`, {
        modal: true,
        detail: `${conditions}\n\nThe count includes any subagent history that must be deleted with its parent. Protected conversations are kept. This cannot be undone.`
      }, 'Delete conversations') === 'Delete conversations';
    },
    onError: async (row, reason) => {
      const choice = await vscode.window.showErrorMessage(`Could not delete ${row.provider} conversation “${row.title}”.`, {
        modal: true,
        detail: `${reason}\n\nDeletion is paused. Skip continues with the next conversation. Skip All continues automatically for this same provider and exact error message during this run. Cancel stops the remaining deletions; conversations already deleted stay deleted.`
      }, { title: 'Skip' }, { title: 'Skip All' }, { title: 'Cancel', isCloseAffordance: true });
      return choice?.title === 'Skip' ? 'skip' : choice?.title === 'Skip All' ? 'skipAll' : 'cancel';
    }
  };
}
