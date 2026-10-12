# Keep your own agent workflow

Run Codex or Claude in their own CLI or native extension, or chat through AgentDock. Saved workspace changes are captured without an extra model request.

**Tracking on** appears beside quota in the bottom VS Code status bar. Pending changes replace it with **Review · N files**; click to open the latest conversation diff directly. The Review heading and **… → Change tracking** offer Pause/Resume and this guide. Capture updates badges without opening a panel or stealing focus.

Tracking starts automatically in a trusted local workspace. Your existing edits become the baseline; only later saved edits are captured. Pausing is remembered per workspace. Reloading preserves the baseline and catches edits made while the window was closed.

All file writers are included, even manual saves. Successful Claude Edit/Write/MultiEdit and Codex apply_patch records link a change to its native conversation only when the timestamp and complete captured content transition match. Shell edits, older captures without evidence, and unsupported edit records stay unassigned. Files touched by multiple conversations or mixed with unassigned edits appear under Shared workspace changes. Unsaved buffers and ignored files are excluded. In a multi-root workspace, tracking follows the selected local root.
