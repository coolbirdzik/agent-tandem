# Review at your own pace

AgentDock opens to **Review**. Continue chatting in native Codex or Claude; saved edits appear here without another model request. Each conversation group collapses independently. New pending changes update the view badge and **Review · N files** in the status bar without taking focus from your editor or chat.

Click the status bar to open the most recently captured conversation's first file directly in the native VS Code diff. Next/Previous stays within that group. Open a different file or a group's **View changes** from the sidebar. **+** and History still open AgentDock chat when you need it.

The chat review box shows pending files belonging to the current conversation. **Browse workspace changes** opens the full list. **Accept group** and **Revert group** affect only that group, and editor navigation stays within it. Shared or unassigned files remain visible as separate groups.

The Review view's top **View all**, **Revert all** and **Accept all** apply to all pending files in the current workspace, including collapsed conversation groups. Revert all previews the complete scope before confirmation. Use group actions to review only one conversation.

| Action | Result |
| --- | --- |
| Accept | Keep the applied code and mark it reviewed. |
| Revert | Restore the saved baseline for that file or block. |
| Undo | Restore the files from the latest Revert and return them to pending review. |
| Pause tracking | Capture final saved edits and retain pending review. |

File/group Revert opens a preview of the exact scope and requires **Confirm Revert**. Click a preview filename to inspect its saved diff. Changes after preview invalidate confirmation. In the native diff, Accept/Reject acts directly on the individual visible block. All Revert paths retain **Undo** for the most recent Revert, including individual blocks. Chat's **Accept all** and **Revert all** apply to its displayed conversation scope.

Undo survives reload and restores only the reverted files, with their pending review and conversation identity. Unrelated changes remain intact. It refuses later saved edits, dirty buffers or decisions on the remaining hunks of those files. When no pending files remain, **Review · Undo** in the status bar opens the Undo control. A later Revert replaces the previous Undo.

Stop the external writer before final decisions. Save dirty buffers before reverting; stale changes are blocked to protect newer work. Pause tracking before restoring a message checkpoint.

Open **Settings & dashboard → Storage** to see where snapshots are stored and preview cleanup of unused data. Pending Revert, tracking baselines, checkpoints and Undo are protected by cleanup.
