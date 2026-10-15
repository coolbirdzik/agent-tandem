# Review at your own pace

AgentTandem opens to **Review**. Continue chatting in native Codex or Claude; saved edits appear here without another model request. Each conversation group collapses independently. New pending changes update the view badge and **Review · N files** in the status bar without taking focus from your editor or chat.

Click the status bar to open all pending changes in the active workspace in the Monaco inline diff, starting with the most recently captured file. Next/Previous moves through that workspace's pending files. Open a group's **View changes** from the sidebar to stay within one conversation. **+** and History still open AgentTandem chat when you need it.

The chat review box shows pending files belonging to the current conversation. **Browse workspace changes** opens the full list. **Accept group** and **Revert group** affect only that group, and editor navigation stays within it. Shared or unassigned files remain visible as separate groups.

The Review view's top **View all**, **Revert all** and **Accept all** apply to all pending files in the current workspace, including collapsed conversation groups. Revert all previews the complete scope before confirmation. Use group actions to review only one conversation.

| Action | Result |
| --- | --- |
| Accept | Keep the applied code and mark it reviewed. |
| Git commit | Automatically accept committed changes. Partial commits leave the uncommitted changes available for review. |
| Revert | Restore the saved baseline for that file or block. |
| Undo | Restore the files from the latest Revert and return them to pending review. |
| Pause tracking | Capture final saved edits and retain pending review. |

File/group Revert opens a preview of the exact scope and requires **Confirm Revert**. Click a preview filename to inspect its saved diff. Changes after preview invalidate confirmation. Inline Accept/Reject acts directly on the individual change above which it is displayed. All Revert paths retain **Undo** for the most recent Revert, including individual blocks. Chat's **Accept all** and **Revert all** apply to its displayed conversation scope.

Local and Marketplace editions default to Monaco review (`agentTandem.reviewEditor: webview`): full source, highlighted diffs, search with Ctrl+F and colored buttons above each edit. If you previously selected `native`, switch this setting to `webview` to see the buttons. The **Native diff** button opens VS Code's editor for the same snapshots; choose `native` to use it by default.

**Next file** skips the remaining changes in the current file. Use the inline Next file button or **Previous file / Next file** in the top toolbar (`Alt+PageUp` / `Alt+PageDown`). The filename dropdown jumps directly to a file. Native mode provides editor-title controls and a clickable **File x/y** status-bar counter. File navigation stays within the current review scope and wraps at its ends; **Next change** continues through individual edits.

Undo survives reload and restores only the reverted files, with their pending review and conversation identity. Unrelated changes remain intact. It refuses later saved edits, dirty buffers or decisions on the remaining hunks of those files. When no pending files remain, **Review · Undo** in the status bar opens the Undo control. A later Revert replaces the previous Undo.

Stop the external writer before final decisions. Save dirty buffers before reverting; stale changes are blocked to protect newer work. Pause tracking before restoring a message checkpoint.

Conversation groups require successful edit-tool evidence that reproduces the saved change. Codex patches called directly or through static, awaited `exec` calls are supported. Shell/script writes and edits without a complete content match remain unassigned; this does not mean they were necessarily manual. Unmatched saved captures are checked again when native history refreshes.

Open **Settings & dashboard → Storage** to see where snapshots are stored and preview cleanup of unused data. Pending Revert, tracking baselines, checkpoints and Undo are protected by cleanup.
