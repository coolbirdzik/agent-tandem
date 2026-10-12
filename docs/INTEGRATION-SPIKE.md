# Initial integration spike results

## Runtime context incorrectly displayed as You, October 8, 2026

The Codex history path without user_message events previously treated every response_item with role=user as a user message. It now recognizes messages containing only a recommended_plugins block with the standard runtime header and/or an environment_context block with cwd/shell, and hides them in that fallback path. It does not filter user_message events (explicit user markers take priority), strip snippets, mixed prompts or fenced code, or change assistant/tool output or the original transcript. The title uses the first actual request. Native edit/resend excludes context-only user items only when necessary to match the filtered history; if native prompts already match verbatim, it preserves literal context pasted by the user.

Typecheck and 66 conversation/chat tests passed, covering separate/combined blocks matching the reported H:\\Code\\aot-new case, quoted tags, code, other XML, incomplete blocks, explicit user markers, title/refresh and fork boundaries. `test:context:history` passed in two Extension Hosts using VS Code archive 1.141.0: opening the panel with a response-only fixture, refreshing and restarting displayed only the two actual user requests, preserved sample replies/tools and selected the correct title. Reports: `artifacts/context-history-test.json`, `artifacts/context-history-reopen-test.json`. The real H:\\Code\\aot-new transcript, rollout 01a11ac7-66ad-7d80-9592-6a7857355104, was read again: it has no user events and two user response items containing context and an actual request; the new parser displays only the actual request. `artifacts/context-history-real-test.json` contains counts/IDs only, without chat content.

## Native access modes, October 8, 2026

The composer provides a permission selector for each provider: Codex Agent, Read only, Full access; Claude Ask, Auto edits, Plan, Auto, Don't ask, Full access. The selection is stored separately per project/provider in extension storage, survives resume/reload, is locked during a turn and is validated by the host. New, resumed and forked turns all receive the selected mode; selecting Default again does not inherit Full access from history. Agent/Ask are the defaults. Global CLI settings remain unchanged, and selecting Full access does not require an additional confirmation.

Codex Full access uses approvalPolicy=never and sandbox=danger-full-access; Read only uses never/read-only; Agent uses on-request/workspace-write. Claude maps to native permissionMode; only Full access enables allowDangerouslySkipPermissions and bypassPermissions. Provider settingSources/canUseTool, deny/ask rules, hooks and managed policies remain in effect; requests that the provider forwards to the UI are not answered automatically. Don't ask uses dontAsk (deny instead of asking), while Auto depends on the provider/account. This follows [OpenAI Docs](https://learn.chatgpt.com/docs/sandboxing) and [Claude SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions), checked against the installed Codex schema and SDK declarations.

Typecheck and 84 access/chat/DOM tests passed, covering native start/resume/fork payloads, resetting to Default, remembering/changing modes, project/provider isolation, concurrent storage writes, corrupt stored values without privilege escalation, invalid mode rejection and a locked dropdown during active turns. `test:access:live` passed in two Extension Hosts using VS Code archive 1.141.0: real Codex/Claude ran a script that wrote files inside/outside the project and fetched local HTTP, without approval answers or prompts. Resume retained the session/mode; restart restored Full access and subsequent tools ran successfully. Project Review/Revert behaved correctly; the sibling file outside the project remained unchanged because review covers only the selected root. Reports: `artifacts/access-initial-test.json`, `artifacts/access-reopen-test.json`. UI verification used DOM tests; the dropdown was not operated through visual observation in VS Code.

## Edit and resend messages, October 8, 2026

User messages provide Edit and resend, loading their content into the composer in edit mode. Cancel/Escape restores the previous draft. Edit drafts are stored per project/session and survive refresh; Edit/Send are locked while the agent or capture is running. The host validates the target user message, provider/session and revision, then constructs the prefix itself; it does not accept a fork boundary from the webview. Providers compare all user prompts against the native history before branching and report stale history rather than guessing positions. Failures before session creation restore the original conversation and edit draft.

Codex uses thread/read to identify the turn preceding the target, then thread/fork with lastTurnId; the first message uses thread/start. Cutting between steer messages within the same turn is unsupported: the user is asked to select that turn's first message. Claude reads SDK records and uses forkSession/resumeSessionAt at the chain entry immediately preceding the target, including tool-result carriers; the first message does not resume. The original conversation remains intact, and current files and pending review are not reverted automatically. Native behavior follows [OpenAI Docs](https://learn.chatgpt.com/docs/app-server#threads) and [Claude SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions); Claude cutoffs were checked against sdk.d.ts in the installed package.

Typecheck and 69 chat/DOM tests passed, including fork boundaries, first-message reset, stale sources/targets, client-injected fork rejection, Cancel/Escape, draft isolation, refresh, active-turn locking, rejection and failure recovery. `test:edit:live` passed with real Codex/Claude in a separate VS Code archive 1.141.0 (the installed VS Code updater held its mutex). Each provider ran three original turns, edited the middle turn and then the first turn; random tokens proved that prefix context was retained and later context did not enter the branch. Original native history remained intact, branch transcripts were correct and sentinel file bytes were unchanged. Report: `artifacts/edit-live-test.json`; visual interaction with the pencil button in VS Code has not been confirmed.

## Stop and CLI processes, October 8, 2026

All three Stop buttons now connect to the active chat (the header previously stopped only the demo), with Stopping/Saving changes states and suppression of late output. Codex cancels pending RPCs, sends turn/interrupt directly and bounds the interrupt wait; Claude closes the SDK stream and bounds a stuck iterator. Both clean up their owned CLI process and descendants by PID before review capture; they do not kill by executable name. CLIs run in the background with windowsHide and do not open a terminal. Transport is created per turn; subsequent chat resumes the existing session ID.

Typecheck and 59 chat/DOM/process tests passed, covering stalled initialization/model/turn-start/interrupt, abort during spawn, pending approval, stalled Claude streams and late output. Real Windows process tests proved that descendants stopped writing heartbeats while an independent sibling process continued running.

`npm run test:stop:live` passed on VS Code 1.140.0 with real inference: Codex Stop took 449 ms and Claude 1414 ms while a foreground tool was writing a file. Heartbeats stopped after Stop, partial edits remained pending review, the next turn resumed the correct conversation and Revert restored the workspace. Report: `artifacts/stop-live-test.json`; verification used commands in a real Extension Host and DOM tests, without visually operating the buttons.

## Remembered permissions, October 8, 2026

Prompts provide Always allow for Codex-proposed command prefixes/network hosts and Claude rules stored in local project configuration. Session approval explicitly says Always allow for this run because transport closes after each turn. Codex handles `item/permissions/requestApproval`, grants only requested permissions, supports availableDecisions and ignores prompts from old turns. Claude preserves Allow once/Decline, sends only selected local/session updates and respects suppressAlwaysAllowRule. The host validates that the answer scope belongs to the current choices.

49 chat/DOM tests passed, covering native decision payloads, correct prefixes/hosts, turn/session access, no persistence for Allow once/Decline/Stop, restrictions/suppression and UI content/buttons. Typecheck and two Extension Host/restart checks passed. Payloads were checked directly against JSON schemas exported by the installed native Codex into `artifacts/permission-codex-schema`; real inference has not verified rule persistence or suppression of later prompts. Native documentation: [OpenAI Docs](https://learn.chatgpt.com/docs/app-server#approvals), [Claude SDK](https://code.claude.com/docs/en/agent-sdk/user-input#handle-tool-approval-requests).

## Remove the per-file snapshot limit, October 8, 2026

The 100 MiB limit that blocked chat for large files such as `src/core` was removed. Large files are captured, hashed, checked against blobs and reverted through streaming with bounded memory; unchanged large files reuse their blobs. Previews summarize file size while snapshots retain all bytes. Content is checked again before publishing Revert to preserve edits made during copying. Demo recorder limits remain unchanged.

96 unit/DOM/filesystem tests passed, including a real 105 MiB `src/core` file: modified/deleted/added, preview, save/reopen, Accept and Revert; restored checksums matched the original bytes. Tests also covered UTF-16, invalid UTF-8, corrupt blobs and edits during Revert. `npm run test:review:large-file` passed on VS Code 1.140.0: real Codex/Claude chat ran in a project containing this file, review correctly showed three modified/added/deleted files, and Revert and restart/Accept behaved correctly. Report: `artifacts/review-large-file-test.json`.

## Working animation, October 8, 2026

A fixed status strip above review/composer displays a spinner and three dots for both Codex/Claude, distinguishing Preparing, Working, active tools, waiting for responses and Finishing. The animation remains stable through streaming/refresh, stops on completion/error/Stop and respects reduced motion. 34 chat/DOM tests passed, covering draft/focus, tab/project switching and status phases.

`npm run test:extension` and `npm run test:review:live` passed on VS Code 1.140.0. Real inference for both providers included working and tool activity; phase/activity cleared after completion. Review/Accept/Revert and restart continued to pass. Report: `artifacts/review-live-test.json`; the animation has not been confirmed through visual observation in VS Code.

## Large-project chat fix, October 8, 2026

The 20,000-file and total workspace size limits that stopped Enter/send before invoking the provider were removed. At this point, the per-file limit remained, at most eight files were processed concurrently, and blobs were reused for identical or unchanged content. Stop could interrupt capture before the agent turn. 88 unit/DOM/filesystem tests passed, including a real 20,001-file fixture for capture/review/revert with and without Git; a separate test proved total bytes could exceed the per-file limit.

`npm run test:review:large` passed on VS Code 1.140.0: both Codex and Claude sent chat and modified/added/deleted real files in a project with more than 20,000 source files; review displayed the correct changes and Revert restored the code. A second Extension Host retained pending review across restart, per-file Accept preserved content and Revert restored the remaining files. Report: `artifacts/review-large-test.json`.

## Review already applied changes, October 8, 2026

Chat now captures the workspace before/after a turn, displays a fixed pending changes box above the input, provides per-file diffs and supports per-file/all Accept/Revert. Accept preserves code already written; pending changes remain listed through subsequent chat and reload. Revert restores original bytes, removes new files, recreates deleted files and blocks conflicting edits, unsaved buffers and linked paths. This is grouped workspace review for the whole turn, rather than exact per-tool checkpoints or provider context rollback.

`npm run test:review:live` passed on VS Code 1.140.0: real Codex and Claude each modified/added/deleted three files in the test workspace; the host showed the correct three pending changes and Revert restored everything. A second host reopened pending review, displayed diffs, accepted one file while preserving its code and reverted the remaining files. Report: `artifacts/review-live-test.json`. 85 unit/DOM/filesystem tests passed, covering repeated edits to the same file across turns, dirty baselines, project isolation, stale decisions, restart/partial capture, binary/BOM/CRLF, `.gitignore`, quotas, links and conflicts with new edits.

## Chat update, October 8, 2026

Sidebar chat supports send/resume using the original session ID, streaming, Stop and permission requests. `artifacts/chat-smoke.json` records four successful real inference cases: creation and resume for both Codex/Claude, with follow-up questions verifying earlier context. Native Codex runtime 0.147.0 on PATH takes priority over the older npm CLI 0.99.0, whose selected model was no longer supported by the ChatGPT account. If a model is outside the ChatGPT catalog, the adapter retrieves the default through `model/list` and overrides the outgoing turn without changing CLI configuration. Catalog-based model selection follows [OpenAI Docs: app-server](https://learn.chatgpt.com/docs/app-server#list-models-modellist).

Typecheck and 66 unit/integration/DOM tests passed. VS Code 1.140.0 ran 14 check groups, including preserving new chat through sync, host receipt of chat content, provider error reporting and provider switching in the dock. A second host verified reopening history/snapshots. Reports: `artifacts/extension-test.json`, `artifacts/extension-restart-test.json`. The October 7 results below are the pre-chat investigation milestone; agent-turn checkpoint/apply/revert had not yet been implemented at that point.

Verification date: October 7, 2026. Scope: local conversation synchronization, the step diff prototype and process/provider checks; the MVP integration spike was not complete.

## Verified environment

| Component | Version | Result |
| --- | --- | --- |
| VS Code Desktop Windows x64 | 1.140.0 | Native diff and changes editor worked in the Development Host |
| Development Node | 24.9.0 | Build, typecheck, unit/integration tests and packaging |
| Codex CLI | 0.99.0 | App-server stdio initialize/initialized and model/list succeeded |
| Claude Code CLI | 2.1.220 | Executable ran and returned its version |

The Codex probe retrieved four catalog entries without creating a thread or running a turn/inference. It did not read/write token files or change provider configuration. CLI availability does not prove model entitlement or tool recorder support.

The verified environment had no `ANTHROPIC_API_KEY`. Claude Agent SDK/inference and hooks with an API account were not verified; CLI login is not treated as evidence of SDK authentication.

## Prototype API results

Development Host tests passed 13 check groups, including conversation synchronization and the single-panel flow:

1. Native diff and changes commands were available.
2. Opening AgentDock, conversations and diffs during an active demo did not create an editor tab.
3. Two steps editing the same file retained separate before/after snapshots.
4. Snapshot buffers returned historical content after an external WorkspaceEdit.
5. Multi-file steps and cumulative changes displayed inline; only Open diff in editor opened the native changes editor.
6. Added/deleted files had the correct empty side.
7. Reopening storage preserved old step URIs and content.
8. Stop prevented subsequent steps from running.

Tests ran in the real editor, rather than only mocking executeCommand. Observing `onDidChangeTabs` proved that default actions did not open tabs, even temporarily; Open in tab and Open diff in editor were checked separately. Pending snapshot reads did not overwrite newer navigation. The machine-readable report is `artifacts/extension-test.json`.

41 unit/integration/DOM tests passed (24 recorder/filesystem, seven conversation, four inline preview and six webview interaction tests). A second Extension Host reopened the selected conversation and correct historical step diff in the dock, and marked unfinished session metadata as interrupted; report: `artifacts/extension-restart-test.json`.

UI verification used the same built HTML/CSS at widths of 390px/280px: light/dark themes, chat-first layout, working history/back/search/filter, loaded Codicons and Claude Code/Codex icons, readable Markdown/code blocks, colored additions/deletions and no body overflow. This was a browser preview with fixtures, not a VS Code screenshot; Windows Computer Use could not connect to its native pipe during this verification.

Conversation synchronization checks covered: (1) reading Codex rollouts and Claude through bundled SDK ESM without inference; (2) external transcript appends updating the open session; (3) automatic root selection and active-editor root following, history isolation between two roots and concurrent reads retaining the latest selection. Evidence from this repository's real Codex history and limitations are documented in [Conversation sync](CONVERSATION-SYNC.md). At this point, the project had no saved real Claude session; the Claude reader was verified using CLI JSONL fixtures in real VS Code.

## Unverified items

| Item | Status | Required work |
| --- | --- | --- |
| Minimum VS Code 1.100 | Compiled against types only; runtime untested | Test the minimum version or raise engines based on results |
| Codex tool snapshots | Not integrated | Verify hook coverage/configuration/trust by CLI version; notifications are not barriers |
| Claude tool snapshots | Not integrated | Add an SDK adapter and run with a supported API key |
| Concurrent agent writes/background commands | Local recorder rejects concurrency; providers unverified | Serialize or display grouped provenance |
| Provider resume/fork | Not run | Verify context after rollback using real sessions |
| Worktree/apply/revert | Not implemented | Continue the workspace and journal phases in PLAN |
| Restart/crash recovery | Two consecutive Extension Hosts verified history and interrupted metadata | Add forced crashes and journal recovery when apply/revert exists |

The prototype demonstrates that the diff viewing APIs are feasible. Evidence is not yet sufficient to mark phase 0 or the MVP complete.
