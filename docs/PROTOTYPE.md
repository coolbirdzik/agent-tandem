# Step diff prototype

This document describes the version 0.1 recorder/diff demo. The main UI supports streaming chat and workspace review/revert for real GUI turns; see [Conversation sync](CONVERSATION-SYNC.md). The recorder demo uses real files, snapshots and native diff editors. Exact per-tool snapshots and the worktree/apply journal are not implemented yet.

## Usage

Run `npm ci` and `npm run build`, open VS Code and press F5 with the Run AgentDock configuration. In the Development Host, run AgentDock: Open Conversations, select More actions → Diagnostics and then Run demo. There is one AgentDock sidebar WebviewView; Changes contains the preview and Recorded demo steps.

A demo reads a file, edits whitespace, edits the same file again and adds a test, deletes an old fixture, and checks the final content. Operations affect only private extension storage. The open repository is not copied, sent to a provider or edited by the demo.

Select a step to view its inline diff in the panel, and select a file from Changed file. Cumulative compares the baseline with the selected step. Steps without changes display output. Open diff in editor is a separate button that opens a native editor; Open in tab creates an AgentDock editor tab only when clicked. Stop interrupts the demo and skips remaining steps.

## Implemented

| Component | Implementation |
| --- | --- |
| Model | Session/Step/Snapshot/ChangeSet with running/failed/interrupted states |
| Storage | JSON metadata, manifests and SHA-256 blobs outside the workspace |
| Recorder | Before/after capture for caller-owned operations; rejects concurrent writers |
| Snapshot URI | Fixed session and snapshot IDs, preserving file names/extensions |
| Native editor | Content provider + vscode.diff/vscode.changes, with file-picker fallback |
| Timeline | One conversations/changes/tools WebviewView using VS Code theme tokens; editor tabs are opt-in |
| Storage reload | Reads history and marks unfinished demos interrupted |
| Provider check | Codex handshake/model catalog; Claude version and API key availability |

Blobs are published after writes complete; missing or invalid hashes cause errors. Snapshots exceeding 10 MiB or 1,000 files are blocked rather than reported as complete checkpoints. The fixture recorder rejects symlinks, junctions and hardlinks.

Bytes are preserved. UTF-8 and UTF-16 text with BOM can be previewed; binary or undecodable text displays metadata. The prototype has no binary merge or full binary diff.

## Findings from real VS Code

Content providers are read-only in the UI, but another extension's `WorkspaceEdit` can still modify a virtual buffer in VS Code 1.140. The prototype listens for changes to snapshot-scheme buffers and asks the provider to restore immutable content. History blobs are unaffected.

This preserves AgentDock's snapshot view; it is not a security boundary between extensions with the same filesystem access. A read-only API is not assumed to be a sandbox.

## Verification evidence

- `npm run typecheck`: checks TypeScript host, webview and tests.
- `npm test`: filesystem fixtures for two steps editing one file, cumulative diffs, additions/deletions, Unicode/CRLF/BOM, binary, partial failures, Stop, concurrent writers, quota, links and corrupt data.
- `npm run test:extension`: real VS Code checks for conversation/step/cumulative actions that create no tabs, opt-in native diff/tabs, snapshot buffers, reload and Stop.
- `npm run probe:providers`: process/protocol checks only, without inference.

Runtime reports are written to `artifacts/extension-test.json` and `artifacts/extension-restart-test.json`. Logs go to `artifacts/extension-test.log` when redirected as described in the integration report. Tests start two separate Extension Hosts with the same profile to verify persistence; forced crashes and the MVP apply/revert journal have not been verified.

## Next steps

1. Connect the recorder to each provider's hooks and verify barriers and exact/grouped capture.
2. Add file/selection context to existing streaming chat and permissions.
3. Add worktrees from user repositories, dirty baselines, merge/apply journals and message-level revert.
4. Run real-provider cases and full reload/recovery before calling this an MVP.

Demo step previews remain read-only. Real chat has a separate pending-changes box with Accept/Revert based on whole-turn snapshots; it does not roll back conversations or restore an individual tool step.
