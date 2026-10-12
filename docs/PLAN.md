# AgentTandem implementation plan

Created: 2026-10-07. Update: synchronizing existing project conversations is a core feature, implemented before new chat and checkpoints.

AgentTandem brings Claude Code and Codex workflows into VS Code: users assign work in chat, follow agents, review code and return to earlier turns when needed. The MVP targets a complete workflow for both providers; checkpoints and diffs are designed alongside chat from the start.

## Product goals

A session must support this sequence:

1. Open a repository and see its existing Codex/Claude conversations; select an old session or create one with file/selection context.
2. View streaming replies, file operations, running commands and approvals.
3. Inspect completed steps while the agent runs, then review the whole turn's changes.
4. Apply all/selected files to the workspace or discard them.
5. Return to before a message, edit the request and rerun while retaining old branch history.
6. Close/reopen VS Code and continue sessions and unfinished reviews.

## MVP scope

| Area | Required behavior |
| --- | --- |
| Chat | Sidebar, streaming Markdown/code, copy, send, stop, retry and edit/resend |
| Providers | Codex and Claude with separate installation, connection, authentication and error states |
| Context | Attach files, selections and diagnostics; preview outgoing content |
| Activity | Turn-associated tools, commands, output, errors and approvals; click steps for changes |
| Sessions | Synchronize existing project CLI/app conversations; update external messages automatically; reopen/select old sessions and continue with the correct provider session ID; create/rename sessions |
| Checkpoints | Save before/after turns and confirmed file-writing steps; restore conversation, code, or both by turn |
| Review | Separate per-step and cumulative diffs; list added/modified/deleted files and apply/discard selected files or all files after a turn |
| Recovery | Recover sessions, diffs and file transactions after sudden extension termination |
| Distribution | A VSIX installable/testable on Windows VS Code Desktop |

Conversation reads/sync require only a local workspace, without Git/commits or API keys. The proposed checkpoint/worktree execution flow requires Git and at least one commit, one root per session and one active agent turn per repository. Agents work separately; the main workspace receives code on user apply. Phase 0 must verify this design. Existing CLI sessions retain their cwd/provider IDs and must not silently resume in another worktree.

macOS/Linux are prepared through abstractions but excluded from initial acceptance commitments. Remote SSH, WSL, containers, non-Git/uncommitted repositories and virtual workspaces are later phases.

## After the MVP

- Hunk/line Accept/Reject; MVP review is file-based.
- Concurrent agents with independent worktrees/reviews.
- Inline completion/editing, Tab completion and full-repository indexing.
- Provider switching with explicitly transferred context.
- Skills/MCP galleries and cloud sync. Local CLI history remains core.
- Agent self-review, commits, PRs or pushes; MVP review is user diff inspection.
- Direct editing of the main workspace by agents.

## Interface and workflows

### Chat and sessions

The default workflow stays in one AgentTandem sidebar panel: conversations, history, changes and diagnostics. Sessions, tool output and steps/files do not automatically create editor tabs. Open in tab/Open diff in editor are separate actions. Provider icons and names identify sessions, headers, replies/tools, beyond color alone.

The initial screen uses current-project Codex/Claude conversations. Filter cwd within the root/subdirectories, excluding similarly prefixed siblings. Use the current root without a picker; multi-root workspaces follow the active file. History has its own button; the latest session opens unless a saved selection exists. Keys are `(provider, providerSessionId)`; reading history does not create AgentTandem sessions. One provider's list/read failure leaves the other available. Revision-based sync rejects stale reads after switching projects/sessions. History is readable without model execution permissions; transcripts without snapshots must not pretend to offer code diffs/reverts.

The sidebar contains sessions, provider/model, messages and composer. Enter sends, Shift+Enter adds a newline, Stop interrupts, and context chips can be removed before sending. Long content/tool output collapses. Auto-scroll occurs only when the reader is at the bottom.

Each turn shows preparing, running, awaiting approval, completed, stopped or failed. Completed turns with edits show Review Changes with file count and review action. Failed/stopped turns still expose partial changes.

The execution timeline is tool/command-based. Immutable completed steps offer View Changes for that step's before/after diff. Cumulative mode compares turn start to the selected step; steps without changes show output. Unseparable overlaps are clearly grouped, never falsely assigned to one step. See [VS Code research](VSCODE-API-RESEARCH.md).

Retry retains the original request/context. Edit & Resend forks before the edited turn, retaining failed runs for inspection. Retrying an edited turn must first resolve its previous checkpoint/diff.

### Change review

Agents run in separate working copies. Until apply, main workspace code retains the user's state. Selecting a review file opens a VS Code diff.

Step diffs become available after completion and immutable capture. Old steps retain their versions even after further edits. Step viewing is read-only; Apply/Discard/Revert waits for turn completion and writer shutdown. MVP revert remains message/turn-based, without restoring conversation context mid-tool.

| Action | Result |
| --- | --- |
| Apply File | Merge that file's changes into the main workspace after conflict checks |
| Apply All | Prepare one transaction for all pending files |
| Discard File | Discard worktree changes without editing the main workspace |
| Discard All | Restore unresolved worktree changes to turn-start state |
| Open Diff | Show baseline/agent result and current workspace when conflicted |

Apply neither commits nor stages files. Review uses turn-start baselines, including shell changes; provider diffs supplement activity only.

The MVP requires resolving all current-turn files before the next turn. Apply/discard reconciles worktrees and communicates actual code state to the provider. Main-workspace changes require conflict-checked synchronization.

### Message-level revert

The default boundary is **before the selected user message**, explicitly labeled. Tool/assistant messages use their containing turn's boundary.

| Mode | Conversation | Code |
| --- | --- | --- |
| Conversation Only | Active branch excludes selected/later turns from future context | Retain code and disclose that it was not restored |
| Code Only | Retain chat history | Restore AgentTandem-managed changes and disclose restoration to the next turn |
| Conversation and Code | Branch before the selected turn | Restore code to the same boundary |

Revert never physically deletes old branch history. Edit & Resend uses Conversation and Code, then loads the old request for editing.

Unapplied code restores in the worktree. Applied code reverses recorded transactions in the main workspace with preview/conflict checks, rather than overwriting the entire repository with snapshots. Later user edits are preserved or routed to conflict resolution.

Revert locks while agents/processes can write. Providers without verified boundary forks use explicitly disclosed new sessions with reconstructed context. Merely hiding UI messages is not conversation revert.

## Initial implementation choices

See [architecture](ARCHITECTURE.md). These are proposals, not existing functionality.

| Component | Proposal | Reason |
| --- | --- | --- |
| Extension Host | TypeScript, VS Code API | Editor, process, storage and workspace management in one runtime |
| Chat UI | React + TypeScript in WebviewView | Streaming chat and timelines |
| Diff | `vscode.diff`, read-only content provider; trial `vscode.changes` | Immutable step versions; file-list/single-diff fallback |
| Codex | App-server stdio adapter | Interactive lifecycle and events |
| Claude | TypeScript Claude Agent SDK adapter | Claude Code agent loop/tools |
| Code changes | Separate worktree + snapshots + apply/revert journal | Separate agent and user working copies |
| Storage | JSON metadata, JSONL events, content-addressed blobs in extension storage | Recovery without repository pollution |
| Build/test | esbuild host, Vite webview, Vitest and Extension Development Host | Logic tests separate from actual editor behavior |

Codex app-server provides stdio and thread/turn APIs; `thread/rollback` is deprecated. Prefer forks or context reconstruction rather than rollback. Experimental surfaces require version pins and contract verification. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

Claude Agent SDK provides agent loops, tools, sessions and permissions. Current third-party guidance uses API keys and restricts offering claude.ai login without approval. Use supported provider authentication; do not assume reusable Claude Code subscriptions. [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

Claude file checkpoints restore neither conversation context nor Bash edits. AgentTandem checkpoints must independently track file state. [Claude file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)

## Implementation phases

Phases follow dependencies. Estimates assume one full-time developer, excluding account/provider-permission waiting time, and will be adjusted after phase 0.

### Phase 0 Integration spike

Estimate: 2–4 working days.

- Run Codex app-server and Claude SDK on a small Windows fixture repository.
- Verify authentication, streaming, tool output, approval, interrupt, resume and boundary forks.
- Pin CLI/SDK versions, Extension Host-compatible Node runtime and Windows process spawning.
- Prove worktree execution captures all tool/shell changes.
- Exercise dirty repositories, untracked files, dependencies and Unicode/spaced paths.
- Prototype content providers, single/multi-file diffs: two steps editing one file, additions/deletions, read-only behavior and reload on minimum VS Code.
- Verify each provider's before/after hooks/barriers, exact/grouped capture and concurrent tools.
- Define write permissions: worktrees separate files but are not security sandboxes; prevent agent edits to Git metadata/main workspace.
- Record findings and unsupported points in `docs/INTEGRATION-SPIKE.md`.

Complete when both providers execute a file-editing turn with evidence for each capability. Unsupported capabilities need tested fallbacks or explicit exclusion, without simulated UI success.

### Phase 1 Extension shell and shared contracts

Estimate: 2–3 days.

- Manifest, activation, sidebar, commands, settings and Output Channel.
- Real Codex/Claude list/read, project filtering, external-write sync and selection persistence. This is the first slice; the recorder demo only supplements diff verification.
- Session/Turn/Event models, adapter contracts and fake adapters for UI development.
- Validated host/webview bridge with correlation IDs and state updates.
- Versioned storage and session reload.
- VS Code themes, keyboard navigation and icon labels.

Complete when Development Host opens both providers' existing conversations, follows external writes, isolates project history and preserves selection after reload. Fake adapters do not replace real history acceptance.

### Phase 2 Workspaces and checkpoints

Estimate: 4–6 days.

- Worktrees from HEAD with saved dirty/untracked overlays in scope.
- Preserve main-workspace index, branch and files during baseline creation.
- Before/after snapshots, additions/deletions, binary, metadata and size limits.
- Step Recorder, intermediate snapshots and individual/cumulative changes; old boundaries remain stable after later edits.
- Journals, repository write locks, link/path checks and incomplete-transaction recovery.
- Fixture-tested diff/apply/reverse/conflict engines.

Complete when the UI-independent engine passes [acceptance](ACCEPTANCE.md) data-preservation cases, including staged/unstaged files, concurrent edits and transaction crashes.

### Phase 3 Codex chat

Estimate: 3–5 days.

- First adapter, process lifecycle, handshake and event mapping.
- Context, output, approvals, Stop and connection/authentication errors.
- Run coordinator with before/after checkpoints and post-turn review.
- Codex hook/item recorder and step changes at verified evidence levels.
- Correct resume without automatic replay when prior execution is uncertain.

Complete when real Codex edits multiple worktree files, diffs are correct and the main workspace changes only on apply.

### Phase 4 Claude chat

Estimate: 3–5 days.

- Second adapter sharing the contract, with provider session IDs/message boundaries.
- Authentication, streaming, permissions, Stop, resume and fork/fallback.
- Claude tool hooks, including Bash and partial edits from failed tools.
- Shared UI/review/revert semantics with explicit capability differences only.

Complete when real Claude passes the Codex scenarios, including shell edits and mid-turn failure.

### Phase 5 Complete review and revert

Estimate: 4–6 days.

- File lists, native diffs and per-file/all-file Apply/Discard.
- Individual/cumulative step diffs and multi-file editors; history viewing never changes workspaces.
- Restore previews, three revert modes and Edit & Resend.
- Safe merging with changing workspaces; actionable file errors/conflicts.
- Actual code-state updates to providers after discard/apply/revert.
- Retained old branches and unresolved-review reload handling.

Complete when users run two turns, partially apply, edit manually and revert before an earlier turn, retaining independent edits or exposing clear conflicts.

### Phase 6 Polish and MVP release

Estimate: 3–5 days.

- All acceptance cases on both real providers and Windows VS Code Desktop.
- Setup, missing CLI/key handling, redacted logs and usage instructions.
- Long chats, fast streaming, large output, disk quotas and post-Stop processes.
- Package/install a VSIX on a clean profile and exercise the complete workflow.
- Add usage README, changelog and release checklist as implementation matures.

Complete with a working VSIX and runtime evidence for chat → review → apply → revert → reload on both providers. Simulated tests do not replace this.

Initial total: 21–34 working days, about 5–7 weeks. Per-step viewing adds recorder/barrier investigation; revise after phase 0 rather than committing to a release date before verification.

## Decisions required during the spike

| Question | Proposed default | Verification |
| --- | --- | --- |
| Claude authentication | Supported API key | Real test-account adapter and distribution flow |
| Codex authentication | Official CLI/app-server flow | Clean setup, expiry and resume |
| Agent write location | Separate worktree | Dirty-repository review/apply demo |
| Non-Git repositories | No agent execution in MVP | Explicit UI prerequisites |
| Unsaved buffers | Save in-scope buffers before baseline; cancel if declined | Different buffer/disk test |
| Ignored files, dependencies, secrets | No default copying; explicit preparation scope | Build a dependency fixture in worktree |
| In-session provider switching | New session; context transfer after MVP | Prevent cross-provider session ID resume |
| Exact-boundary resume | Verified native fork, otherwise new reconstructed session | Next-turn context excludes reverted information |
| Hunk review | After MVP | Complete file review first |
| Execution-step changes | MVP: exact with barriers, grouped with overlapping writers | Reopen two edits of one file; shell/parallel tools |

## Release criteria

Both providers must have real chat, Stop, review, apply, revert and resume workflows, passing required [ACCEPTANCE.md](ACCEPTANCE.md) cases. Data loss, incorrectly attributed diffs and reverted conversation context leaking into new turns block release.

## First implementation step

Prioritize existing project conversations from both providers. Current local list/read, auto-sync and persisted selection are documented in [Conversation sync](CONVERSATION-SYNC.md). Next integrate original-session send/resume, then provider recorders, checkpoints and apply/revert. Lifecycle/worktree investigation continues alongside this work; demos never substitute for real conversations.
