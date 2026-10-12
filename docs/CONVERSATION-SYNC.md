# Project conversation synchronization

AgentTandem must open existing repository conversations from Claude Code and Codex. This history is the primary UI data source; the snapshot demo only verifies native diffs.

## Implemented

- One **AgentTandem** WebviewView in the Activity Bar/sidebar, with conversations first. Conversation history opens from its button, changes from Review changes, and diagnostics from More actions. Conversations, tools and steps open in the same panel; only Open in tab/Open diff in editor create editor tabs.
- Provider icons and names on each conversation, header, reply and tool: Claude Code (orange starburst), Codex (blue terminal). The list can be filtered by provider.
- Uses the current workspace root automatically, without a picker. Multi-root workspaces follow the active file's root; closing it or switching to a file outside the workspace retains the current root. Opens the saved selection or most recent session automatically.
- Safe Markdown replies, code blocks and collapsible tool activity; history search and provider filters in the panel.
- Filters cwd at directory boundaries, including subdirectories, with case-insensitive Windows comparisons; excludes sibling repositories and worktrees outside the root.
- Retains original provider/session IDs and displays user/assistant messages and tool input/output in transcript order. System/developer instructions and reasoning blocks are hidden.
- Polls every 5 seconds using mtime + size revisions. Updates the open conversation when its transcript changes; manual refresh updates immediately.
- Persists the selected conversation and root in a workspace-specific preference file in extension storage, awaiting the write before selection completes. Stale reads cannot replace a newer session/project selection.
- Reports provider errors independently. Reading history requires no API key, CLI executable or Git, performs no inference and never writes to the original transcript.

## Data sources

**Codex:** reads session metadata and rollout JSONL under `$CODEX_HOME/sessions`, defaulting to `~/.codex/sessions`. The metadata index is cached in memory; messages are parsed only for sessions in the project. Supports `response_item` messages/tool calls/outputs and `event_msg` user/assistant fallbacks, avoids duplicates between formats and handles `thread_rolled_back`. Skips incomplete records and retries after writer updates. Each transcript has a 128 MiB read limit.

Codex app-server provides `thread/list` and `thread/read` for official integrations. The installed CLI is 0.99.0, whose list schema has no cwd filter. The current synchronizer uses read-only rollouts to read app/VS Code sessions from other versions without resuming or running a model. Rollout format is an internal compatibility adapter and may change; add version fixtures when upgrading providers. Archive/cloud history and the complete subagent tree are not synchronized yet. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

**Claude:** uses `listSessions` and `getSessionMessages` from `@anthropic-ai/claude-agent-sdk` 0.3.292. The SDK reads local history under `CLAUDE_CONFIG_DIR`, defaulting to `~/.claude`. Lists metadata to filter cwd and reads the selected session's directory. The SDK reconstructs the message branch through `parentUuid` instead of concatenating every JSONL line. It is bundled separately as ESM in the VSIX with its license; history reads do not spawn the CLI. [Claude SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)

## Verification evidence

- `npm run sync:conversations`: reads real Codex history for `L:\Code\agent-tandem`; writes provider/role counts to `artifacts/conversation-sync.json` without chat content. At this verification point, the project had no saved real Claude session.
- `npm test`: checks project boundaries, appended/incomplete records, message deduplication, rollback and independent provider failures.
- `npm run test:extension`: real VS Code 1.140.0, with separate history fixtures through `CODEX_HOME`/`CLAUDE_CONFIG_DIR`. Reads Codex and Claude through the bundled SDK, appends records externally and checks auto-sync/refresh. A second Extension Host restores the selected session. Real provider homes are unchanged.

## Next steps

The GUI can send new messages and resume original session IDs: Codex uses app-server `thread/start`, `thread/resume`, `turn/start`; Claude uses SDK `query` with `resume`. The composer supports Enter/Shift+Enter, drafts, streaming, Stop, errors and approvals. Agents run at the open root and can edit the project directly. The extension permits one active turn but does not lock external CLI/app writers. With Codex ChatGPT authentication, an out-of-catalog model is replaced with the default catalog model for the turn and disclosed in the Model tool; API key/custom providers retain their configured model.

GUI turns now capture before/after workspace snapshots and provide pending changes, diffs and per-file/all-file Accept/Revert. Code is applied immediately; Accept closes review. Unaccepted changes persist across turns and reloads. Revert uses the original state before the first unaccepted change, checks current bytes and blocks newer edits/unsaved buffers. Concurrent changes during a turn are treated as grouped workspace changes, without claiming exact per-tool snapshots. Old transcripts cannot restore all code at each message; reverting a file does not roll back provider context. Next steps are message/tool checkpoints and conversation branching.
