# Development reference

This reference describes the local development build, including experimental controls. For the stable Marketplace build and submission steps, see [Publishing](PUBLISHING.md).

# AgentTandem — Claude Code & Codex Chat, Code Review & Usage

AgentTandem opens to **Review**, a companion for native Codex or Claude chat. Keep using your agent's own UI; saved changes appear in collapsible conversation groups. **Review · N files** in the VS Code status bar opens the latest conversation diff directly. Pending badges update without taking focus. File/group Revert previews its scope before confirmation, and the latest file/group/hunk Revert has persistent **Undo**. Unverified edits remain Unassigned; mixed sources stay Shared. Chat remains available through **+** and History.

AgentTandem brings Claude Code and Codex into a VS Code GUI. Send requests from the sidebar, stream replies, review files changed by agents, and continue existing project conversations from both providers. History updates automatically as you continue using the CLI or Codex app.

## Implementation documents

- [Implementation plan](PLAN.md): MVP scope, product behavior, implementation order and completion criteria for each phase.
- [Proposed architecture](ARCHITECTURE.md): provider integration, sessions, checkpoints, worktrees and applying changes.
- [VS Code API research](VSCODE-API-RESEARCH.md): diff APIs and clicking individual steps to inspect changes in the editor.
- [Acceptance plan](ACCEPTANCE.md): required checks before releasing the MVP.

## Status

Chat supports **pasting images**, dragging files into the composer and selecting multiple files with the **paperclip** button. Previews have a remove button; you can send attachments without text. PNG/JPEG/GIF/WebP images are sent as native image content to both providers. Claude receives PDFs as native document blocks; Codex receives PDFs and other files as native file mentions. Codex audio uses the CLI's local-audio input, subject to model support; Claude audio and other files are staged for the agent to read under its normal permissions. Files are stored in the extension's attachment directory outside the project, so they do not enter code review. Limits: 10 files, 5 MB per image, 20 MB per other file, 25 MB total. Queues preserve attachments across reloads; failed sends and edit/resend retain them. Native history restores embedded images and Claude PDFs; older local-path-only attachments retain their text markers. Run `npm run test:attachments:live` to verify real CLI vision and history in isolated test homes; its report is `artifacts/attachments-live.json`.

Local project history synchronization uses Codex rollouts and the Claude Agent SDK's official session APIs. **One AgentTandem panel** contains conversations, messages, tool output, change review and diagnostics. Claude Code has an orange starburst icon; Codex uses the original SVG from the OpenAI extension with theme-aware colors. Provider labels appear in session lists, replies and tools. Refreshes every 5 seconds and remembers the selected session across VS Code restarts. History reads require no API key, inference or Git repository.

In older response-only Codex history, standalone runtime `recommended_plugins`/`environment_context`/`external_codex_apps_open_page` blocks are hidden from You messages and titles. Edit and resend therefore targets the correct native message position. Explicit user markers, questions quoting those tags, code examples, assistant replies and tool output are preserved. Original disk transcripts are never rewritten.

Chat includes a composer at the bottom, Enter to send, Shift+Enter for a newline, **+** to start a session, Codex/Claude Code selection, resuming the original session, streaming, Stop and in-panel approvals. Drafts are isolated by project/session across refresh and webview reopening; send failures restore text for retry. Running agents requires a trusted workspace and an authenticated CLI. Provider tools can edit the current project directly. With ChatGPT-authenticated Codex, if the configured model is absent from the catalog, AgentTandem uses the app-server default and reports it in the **Model** tool without editing CLI configuration.

While an agent runs, **Enter / the + button in the composer queues messages** for that conversation, for both Codex and Claude. Messages run sequentially after the preceding turn finishes capture/checkpoint work, using the same session and active agent settings. The queue supports editing, deletion and Pause/Resume. Stop, errors, root changes or opening another conversation preserve pending messages and pause the queue; Resume opens its original conversation. Queues persist per workspace across reloads and require Resume after reloading. Editing and resending a message to create a branch still requires the agent to stop.

History uses native Codex metadata for current titles and roots, with fallbacks for older CLIs; renames update during sync. Claude discovery combines scoped and global lists to retain sessions without `cwd` and sessions in nested projects. Junction/symlink roots are compared with canonical paths; large Codex transcripts do not hide the entire list. History and metadata are read-only; native transcripts and databases are unchanged.

Your messages have an **Edit and resend** pencil button. Click it to load the text into the composer, edit and send: a new branch contains the context before that message and the replacement, while the original remains in History. Editing the first message starts fresh context. **Cancel** or Escape returns to the previous draft; edit drafts survive refresh only within the current webview lifetime. Reopening the webview or selecting History starts with an empty composer. Conversations open at the bottom; streaming respects readers who scroll up. Editing/sending is blocked during agent execution or review capture, and resending rejects changed history. Current code is retained; this action does not revert it. New changes still enter Accept/Revert review.

User messages have a subtle background for distinction. Each turn sent through AgentTandem stores a **checkpoint before the agent runs**, with **Restore** beside the pencil. Restore is disabled with an explanation when no snapshot exists; preparation shows a Preparing checkpoint tooltip. Click Restore to preview files to reset/restore/delete, then **Restore code** to return to that point. This includes later manual edits to files in the snapshot; ignored files are excluded. Chat history stays available; use Edit and resend to branch. **Undo restore** previews and restores code from before the latest restore. Checkpoints survive Accept, reload and inherited messages in new branches. Older messages and messages sent only through external CLIs have no checkpoint. Unsaved buffers, changes after preview, linked targets and corrupt snapshots are blocked. Interrupted restores retain a review and a pre-restore backup.

A fixed activity strip shows the Codex/Claude icon, spinner and animated dots, including while viewing history/changes. It reports Preparing, Working, the active tool, Waiting for you, Stopping or Saving changes from actual state. Animation pauses while awaiting input and disappears on completion/error/Stop. The strip has Stop and respects reduced motion.

Each turn runs its CLI in the background without a terminal window: Codex uses `app-server` over stdio; Claude Agent SDK runs Claude Code CLI. Later turns resume the original session ID. Stop in the header, activity strip or composer interrupts active chat, including stuck startup and pending approvals. AgentTandem requests interruption, waits at most one second, then cleans up the turn's owned CLI process tree before review capture. Changes already made remain reviewable. Saving changes means the agent has stopped and the host is capturing its changes.

The **Agent access mode** picker persists per project/provider across resume and reload. Codex offers **Agent**, **Read only**, **Full access**. Claude offers **Ask**, **Auto edits**, **Plan**, **Auto**, **Don't ask**, **Full access** (Auto requires CLI/account support). **Full access** uses native permissions to run tools and access files/network outside the project without ordinary approvals or an additional confirmation dialog. Codex uses `approvalPolicy: never` and `sandbox: danger-full-access`; Claude uses `permissionMode: bypassPermissions` and `allowDangerouslySkipPermissions: true`. **Don't ask** rejects actions requiring approval instead of granting Full access. The picker locks during execution; after Stop you can change it. Defaults remain Agent/Ask. Global CLI configuration is unchanged. [OpenAI Docs](https://learn.chatgpt.com/docs/app-server#approvals), [Claude SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions).

The **Model** picker obtains models directly from the installed CLI/SDK. Selections persist per project/provider and apply to new chats, resume and edit/resend. **Provider default** uses provider configuration; the adjacent refresh reloads the catalog. Saved models absent from the catalog show unavailable and require reselection or Provider default. The picker locks during execution. Discovery submits no inference prompt and creates no conversation. [Codex models](https://learn.chatgpt.com/docs/app-server#models), [Claude SDK model and supportedModels](https://code.claude.com/docs/en/agent-sdk/typescript).

Quota appears **beside context**, showing only the selected provider and its remaining percentage. Click it for account, email, plan, all quota windows, resets and refresh. Data comes from the project's selected CLI, updates every minute and after each turn, and creates no prompt or session. API key authentication or unsupported CLIs show quota unavailable; quotas are never guessed. Claude uses the SDK's experimental usage API, so support depends on CLI/SDK version.

The **VS Code status bar** also shows the selected provider's remaining quota, automatically from startup. Click it to open **AgentTandem Settings**, starting on **Dashboard**. Also use **… → Settings & dashboard**, the **Dashboard** button below chat, or **AgentTandem: Open Settings and Usage Dashboard**. Preferences can toggle status bar quota, select default grouping, open Manage CLIs and link to VS Code extension settings.

**API token activity** reads Codex `account/usage/read` from the project's selected CLI and current ChatGPT account, without a prompt, thread or inference request. It shows lifetime tokens, peak daily tokens, turn duration, streaks and returned daily buckets, grouped by day/week/month. Date and account/provider filters apply to API daily activity; lifetime metrics remain lifetime metrics, and model filters apply only to Local usage. Dates stay exactly as returned because the API does not specify its bucket timezone. Missing metrics display a dash; missing dates are not assumed to be zero. API errors or older CLIs leave the API section unavailable while Local usage remains visible. API activity and Local totals are displayed separately and are never added together. Claude personal-account token activity is not connected; its detailed counts stay Local. [Codex account token activity](https://learn.chatgpt.com/docs/app-server#7-token-usage-chatgpt).

Dashboard labels every data source: **API** for server activity and live quota; **Local** for transcript totals, model/account/date breakdowns and charts; **Estimate** for API equivalent cost (Local tokens times API prices) and tokens per percentage point (Local account tokens divided by API quota). Codex workspace IDs from native `account/read.workspaceRouting` scope API and new Local attribution when available; credentials and routing origins are not retained.

Dashboard aggregates **local CLI history across all projects**, including archived Codex sessions and subagent files for both providers. It opens on **Today**, with daily grouping by default; Reset returns to Today. It shows total/input/output/cache tokens, provider/model breakdowns and daily, weekly (Monday start) and monthly tables/charts in the machine's timezone. Provider, account, model, All time/Today/This week/This month/This year and custom date filters use the same data. Table values are compact, with exact counts on hover. Input includes cache reads/writes; reported reasoning is part of output and is not counted again. Codex prefers per-response usage and falls back to counter deltas for older CLIs; Claude deduplicates message IDs, including streamed blocks and fork copies. Refresh reads only metadata/token usage, performs no inference and leaves history unchanged. Unchanged files reuse a token-only cache in memory and under the extension data folder's `usage/history-cache`, including after VS Code reload. Changed files are reparsed; invalid cache entries fall back to native history. The cache retains counters, timestamps, model and native response/turn IDs, without message text or account credentials. Account evidence is reapplied on every refresh. An open dashboard refreshes every minute; quota updates preserve its history tables.

Dashboard explicitly reports its **recorded locally** scope: other machines, deleted history and unlogged usage cannot contribute. Account breakdowns separate token counts, requests and API equivalent costs. AgentTandem records native account identity (email plus organization when reported) for each new response/turn in its own append-only usage ledger. Resume, forks and login changes preserve earlier attribution. Historical/external CLI usage without evidence and unidentified API keys stay in **Unknown account**, never assigned to the current login. A conversation creator account is not evidence for later turns. Missing model names remain Unknown model; coverage reports unreadable files, oversized/corrupt lines and usage without timestamps. Token totals are not quota percentages or billing statements. Current account/quota data still comes from the native CLI, as below the composer.

**API equivalent · USD** estimates what the selected recorded tokens would cost at published standard global API rates, checked October 10, 2026. It separates uncached input, cache reads, cache writes and output; provider, model and day/week/month breakdowns also include USD. Rates live in `src/core/api-pricing.ts`, sourced from [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) and [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing). Costs are calculated per deduplicated response before aggregation, including supported prompt-length premiums; cache tokens and reasoning are never billed twice. Claude's reported one-hour cache writes use their own rate; unspecified writes assume five minutes. Unknown model IDs remain **Unpriced**, with excluded tokens shown explicitly. These are current-rate equivalents, not historical invoices or subscription charges; Fast modes, tool fees, taxes and regional premiums are excluded. Older session-wide long-context billing cannot be reconstructed from token counters alone.

**Tokens per 1% quota** aggregates all observed quota cycles across projects and models, independent of dashboard filters. Its weighted average is `sum(observed tokens) / sum(used quota percentage points)`, with each 5-hour or weekly cycle counted once. Refreshing replaces the sample for that cycle rather than adding the same cumulative tokens again. The latest cycle is compared with the weighted average of earlier cycles, with a dated cycle history: more tokens per 1% suggests more effective capacity, fewer suggests less. The current cycle still shows estimated 100% capacity and remaining tokens. Observations persist across reloads and workspaces in `usage/quota-history.json`; collection runs on account refreshes while AgentTandem is active. History begins with observed matched usage/quota snapshots; past token logs cannot reconstruct past quota percentages. Comparisons stay separate by provider, exact account, subscription plan and window, including cache tokens and excluding unknown accounts. A change does not establish a provider limit change: model mix, modes, other devices, deleted logs and incomplete attribution also affect the ratio. Missing reset times, zero usage, expired/stale quota or unmatched usage snapshots prevent new observations; existing history is retained. Model-specific quota windows are excluded from the general weekly calculation.

Model discovery follows the terminal's PATH CLI, including npm installations, without silently switching to a Codex app binary or another extension. With multiple installations, use **… → Diagnostics → Choose Codex CLI / Choose Claude CLI** for the project. Diagnostics shows path/version; Model and refresh tooltips identify the source. Catalogs and chat use the same binary. If its path/version changes after discovery, refresh before sending a selected model.

The compact composer row contains **model name · access mode · Send**. Clicking the model opens a provider/model/reasoning popover; Escape or an outside click closes it. Settings lock during execution. Supported reasoning levels come from the selected model/CLI and are forwarded for new chat, resume and edit/resend. Preferences persist per project/provider/model. **Auto** uses CLI configuration; an explicit model is required to set effort. If the CLI reports no support, reasoning remains Auto. Saved unsupported levels show unavailable. [Codex effort and model metadata](https://learn.chatgpt.com/docs/app-server#models), [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort).

The Codex popover has a **Fast mode** On/Off switch, persisted per project across reloads. When enabled, the model label shows **· Fast**, applying to new chat, resume and edit/resend. Off requests Standard on the next turn even if the conversation or CLI previously used Fast. The switch locks during agent/review/CLI operations and is hidden for Claude. Fast consumes more allowance and depends on model/account support. [OpenAI Fast mode docs](https://learn.chatgpt.com/docs/agent-configuration/speed). AgentTandem stores its own preference without editing global `config.toml`.

Modes retain provider-managed deny/ask rules, hooks and policy; requests for user information can still appear. Review/Revert covers only files in the open project; Full access edits outside it do not automatically receive review snapshots.

Modes requiring approvals offer **Decline**, **Allow once** and provider-supported remembered choices. **Always allow** persists Codex's proposed command prefix/network host or a Claude permission rule in `.claude/settings.local.json`; prompts disclose the scope and rule. **Always allow for this run** lasts only for the active turn because transport closes afterward. Remembered choices are omitted when the provider permits only one-time approval or Claude suppresses rule storage. [OpenAI Docs](https://learn.chatgpt.com/docs/app-server#approvals), [Claude SDK](https://code.claude.com/docs/en/agent-sdk/user-input#handle-tool-approval-requests).

After each AgentTandem turn, **files changed** appears above the composer with added/modified/deleted files and line counts. Click a file for its before/after diff in VS Code; **View changes** opens a native comparison of all files. Code is already applied to the project. **Accept** marks it reviewed and removes it from the list; **Revert** restores pending changes. Decisions can target one file or all files. Later turns combine unaccepted changes, preserving the original baseline before the first change. Reviews persist per project across refresh, conversation switches and reloads.

Revert compares current content with agent output; newer edits or unsaved buffers cause conflicts and are preserved. After accepting a file, its current content becomes the next turn's baseline. Failed/stopped turns still capture changes. Save edited buffers before sending chat. Review includes tracked/untracked files not ignored by Git; non-Git projects use `.gitignore` and exclude `.git`, `node_modules` and test runtime folders. There are no file-count, total-workspace-size or per-file-size limits. Large files use streaming capture/verification/restore and reuse unchanged snapshots. Large-file review shows size and retains all bytes for Accept/Revert. Capture errors appear in the panel with **Retry change capture**.

Review captures before/after an entire AgentTandem turn; concurrent editor/external CLI changes during it can also appear. Old CLI transcripts have no automatic before/after snapshots for Revert. Individual step diffs currently use the recorder demo. See [Conversation sync](CONVERSATION-SYNC.md).

## Build and install into local VS Code

```powershell
npm ci
npm run dev
```

`dev` builds host/webview, packages a VSIX, force-installs/updates it through the local VS Code CLI (`--force`) and verifies the installed version. It uses the default VS Code profile. Floating **Previous change / Next change** uses `editor/content` and `multiDiffEditor/content` through the proposed `contribEditorContentMenu` API. The script enables it only for `agent-tandem-local.agent-tandem` in runtime `argv.json`, retaining existing settings and backing up the original beside it. **Fully close and reopen VS Code the first time** to load runtime arguments ([VS Code proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)). Later updates require **Developer: Reload Window**, then **AgentTandem: Open Conversations**. This VSIX is for local use and must not be published to Marketplace while using proposed APIs.

To rebuild and reinstall on source saves:

```powershell
npm run dev:watch
```

Watch mode batches nearby changes and serializes builds/installations. Reload Window to load updates into an active extension. `Ctrl+C` stops watching. For another VS Code location, set `$env:VSCODE_EXECUTABLE_PATH = 'D:\Apps\VS Code\Code.exe'` before running.

## Run a separate Development Host

```powershell
npm ci
npm run build
```

Open this folder in VS Code and press **F5** with **Run AgentTandem**. In the Development Host, open the target project and run **AgentTandem: Open Conversations** or select AgentTandem in the Activity Bar. The sidebar opens the selected/latest session. **Conversation history** opens search and provider filters; **+** creates a new chat. The root label comes from the current workspace without a picker. In multi-root workspaces, history follows the active file's root.

Local and Marketplace editions default to the Monaco Webview review editor (`agentTandem.reviewEditor: webview`). `src/review-monaco.ts` mounts read-only before/after models, bundled language tokenizers and colored revision-bound action view zones. The editor worker runs locally through a blob URL under the Webview CSP. Preserve full-file context, group scope, navigation and disposal of models/listeners. Native diff remains available through the Native diff button or the `native` setting; its inline actions use CodeLens. Run `npm run test:review:webview` to verify both edition manifests in actual VS Code.

`ReviewStore.webviewFile` returns immutable text and hunk identities for snapshots totaling at most 4 MiB. Binary files, larger snapshots and timed-out diffs retain file-level decisions and a Native diff action. Monaco retains the complete source model and virtualizes visible lines for scrolling and search. Passive updates keep the current file, selected change and reading position. Actual click and dark/light/narrow-layout coverage for local and Marketplace-compatible manifests runs with `npm run test:review:webview` without proposed API flags; reports and screenshots are in `artifacts/review-webview-*`.

Webview mode's **Native diff** action opens the same snapshots in VS Code's own editor. Recorded demo steps and cumulative demo history also use native diff editors. Opening native review sets `diffEditor.renderSideBySide: false` and enables code lenses, using the existing workspace setting scope when present and user scope otherwise. This affects other native diffs at that scope. Before/after snapshots remain immutable. Chat file/group Accept/Revert and the sidebar's scope preview are unchanged. The following experimental floating controls apply only to native review when explicitly enabled.

Floating **↑ Previous change / ↓ Next change** buttons appear at the focused code area's lower right. Opening one file retains the entire list: navigation crosses file boundaries and wraps. Multi-file editors traverse all files too. **File 2/5** appears on single-file diff tabs and the editor status bar; navigation persists across reloads. Controls appear only in AgentTandem diffs.

Stable editor-title **Previous file / Choose changed file / Next file** actions are available in every edition. `Alt+PageUp` / `Alt+PageDown` jumps to the previous/next file's first change regardless of how many edits remain in the current file. The CodeLens row also includes Next file when the scope contains multiple files. The status-bar File x/y counter opens the same picker. File and change commands share one queue, preserve scope and wraparound, and ignore stale inline file/revision anchors. Jumping from an overview opens the selected single-file diff while preserving its complete file scope. `node scripts/test-change-navigation.mjs --files-only --files-visual` verifies actual toolbar/picker clicks; add `--marketplace` after packaging to exercise the stable staged manifest.

The experimental **File 2/5** button sits in a small inset before the first code line; click it to choose any changed file. Code remains a native diff. It uses proposed `editorInsets`, scrolls with content and retains one inset for the active editor. Disable `agentTandem.showFileCounterInEditor` to hide it. VS Code may emit `Unknown inset` when disposing an editor during tab changes; navigation and the status bar counter remain usable.

Pending-review previews give **each block its own action card above it**: `Block 2/3`, `+3 −1`, and `✓ Accept`, `✗ Reject`, `↓ Next change` with shortcut hints. Cards use theme button/widget colors, rounded corners and two editor lines through `editorInsets`.

When insets are unavailable (released VS Code, ordinary VSIX installs), the stable API supplies a **CodeLens row**: `✓ Accept | ✗ Reject | ↓ Next change | Block 2/3`. Opening review enables `diffEditor.codeLens` at workspace/user scope. `agentTandem.blockActionsStyle` supports `auto` (cards, then lenses), `lens` (always compact lenses), and `off` (sidebar file decisions only). Cards and lenses never stack.

Block actions bind to their own hunk/revision even with the cursor elsewhere. Shortcuts: `Alt+Y` accepts, `Alt+N` rejects the cursor's block, and `Alt+Down`/`Alt+Up` navigates changes. Accept preserves workspace bytes and advances only that block's reviewed baseline; Reject restores only that block, retaining other pending/accepted blocks. Preview/counters refresh. Stale previews, active operations and unsaved/external edits cannot overwrite code; stale revision actions disappear. Added/deleted files are one complete block. Binary files, combined text snapshots over 4 MiB or timed-out diffs require sidebar file decisions.

Continuing Codex/Claude externally updates lists and open transcripts every 5 seconds. **Refresh conversations** updates immediately. History uses `CODEX_HOME`/`CLAUDE_CONFIG_DIR` from VS Code's environment, defaulting to `~/.codex`/`~/.claude`.

**More actions → Diagnostics** contains the snapshot demo and provider checks; **Changes → Recorded demo steps** lists recorded steps:

- **View changes**: before/after step diffs in VS Code; click a file for its diff.
- **Cumulative**: compare the start of the run with the selected step.
- **Stop**: interrupt the demo; recorded changes retain snapshots.
- **Check providers**: CLI and Codex handshake checks without inference.
- **View output**: display output for steps without file changes.

The demo edits one file twice, adds a file, deletes a file and performs read/check steps without editing. Reopening an old step retains its old version. Binary bytes are stored, but prototype diffs show metadata only.

## Verification and packaging

**More actions → Manage CLIs** manages Codex/Claude installations independently: scan, add via Browse or `.exe` path, edit name/path, check version, Enable/Disable and Remove. Remove deletes only the AgentTandem entry, preserving the executable. Disabled/removed installations cannot load models or run agents; unavailable selected CLIs produce errors.

Windows Codex scans include PATH, VS Code extensions, old Codex desktop paths, `AppData/Local/OpenAI/Codex/bin/<version>/codex.exe` and `CODEX_HOME/packages/app-server-daemon/releases/<version>/bin/codex.exe` (default `~/.codex`). Rescans update executable versions while retaining names and Enable/Disable choices.

Choose **Default on this machine**, **This project** for the current root, or PATH. ID-based selections follow registry entries through path edits. Lists/defaults/project choices persist across reloads. Initial discovery imports existing CLIs; later scan discoveries must be enabled before use. Management locks during agent execution/review.

```powershell
npm run typecheck
npm test
npm run test:extension
npm run test:changes:navigation -- --visual
npm run test:review:live
npm run test:review:large
npm run test:stop:live
npm run test:edit:live
npm run test:access:live
npm run test:cli:live
npm run test:models:live
npm run test:accounts:live
npm run test:usage:accounts:live
npm run test:cache:live
npm run test:usage:local
npm run test:settings:host
npm run test:queue:host
npm run test:context:history
npm run probe:providers
npm run sync:conversations
npm run package
```

`test:extension` runs real VS Code with isolated profiles/workspaces under `.test-runtime`; reports go to `artifacts/extension-test.json`. Override `VSCODE_EXECUTABLE_PATH` for another installation. Packaging creates `artifacts/agent-tandem-0.1.0.vsix`.

`test:usage:local` reads real local Codex/Claude history without inference, exporting daily/provider/model totals to `artifacts/usage-local.json`. `test:settings:host` verifies Dashboard in real VS Code with isolated fixture history/profile: tab creation/reuse, both providers' totals, deduplication and preferences; report: `artifacts/settings-host.json`.

`test:cli:live` verifies real CLI management in an isolated Extension Host: add, rename/repath, default/project selection, disabled model/chat rejection, re-enable, restart, and executable-preserving removal. Reports: `artifacts/cli-manager-live-test.json`, `artifacts/cli-manager-reopen-test.json`.

`test:review:live` uses current provider authentication for real inference in an isolated project: both providers modify/add/delete files, review, Revert, Accept and restart to verify persistence. Report: `artifacts/review-live-test.json`.

`test:review:large` exercises real chat with 20,001 additional source files, ensuring Enter/send has no capture-count limit and review/revert remain correct. Report: `artifacts/review-large-test.json`.

`test:stop:live` uses real foreground heartbeat tools for both providers in an isolated workspace. Stop terminates tools, heartbeats cease, partial changes remain reviewable, resume retains the session and Revert restores code. Report: `artifacts/stop-live-test.json`.

`test:edit:live` verifies real middle/first-message edits for both providers: prior context remains, replaced/later context is excluded, original conversations survive and current files remain unchanged. Report: `artifacts/edit-live-test.json`.

`test:access:live` runs real Full access tools: start/resume, writes inside the project and a test sibling, local HTTP and no approval answers. Verifies project review/Revert and persisted modes after restart. Reports: `artifacts/access-initial-test.json`, `artifacts/access-reopen-test.json`.

`test:context:history` verifies response-only Codex history in real VS Code: runtime context hidden, prompts/replies/tools retained, correct title, refresh and restart. Reports: `artifacts/context-history-test.json`, `artifacts/context-history-reopen-test.json`.

Verified capabilities and remaining work are documented in [the prototype](PROTOTYPE.md) and [integration report](INTEGRATION-SPIKE.md).

Codicons: [Microsoft/vscode-codicons](https://github.com/microsoft/vscode-codicons), copyright Microsoft Corporation. The font is unchanged under CC BY 4.0; CSS uses MIT. Licenses ship in the VSIX.

A common dropdown component supports model/reasoning, access, CLI, questions and diff files: arrow keys, Home/End, typeahead, Enter, Escape and Tab. Menus use VS Code themes, descriptions/checkmarks and adapt their opening direction to available space.

Below the composer, context shows the latest request's tokens/window/percentage, without summing the whole conversation. Claude displays an **estimated** countdown when the CLI reports cache TTL; history refresh/reopening does not reset it. Codex exposes no app-server TTL, so displays `Cache TTL —`; its tooltip still reports cached tokens. Expiry is never guessed from model/account names. Missing history/CLI usage displays `Context —`, or token count without unknown window capacity.

Native CLIs/servers manage prompt caching. Codex uses `thread/resume` then `turn/start` with only the new message; Claude uses `resume`, the `claude_code` system prompt preset and CLI setting sources. AgentTandem does not concatenate UI transcripts, alter cache markers or force TTL. Each turn currently starts a new process, so continuous-CLI transport optimizations are absent; server cache can still hit matching prefixes. Existing Claude sessions retain recorded system prompts natively until compaction or a new session. Model/tool changes and compaction can affect cache hits. `test:cache:live` runs two real turns per provider with isolated workspace/homes, checks same-session resume and records actual cached tokens in `artifacts/cache-live.json`; exhausted quotas skip inference. Valid cache misses are reported; every turn is not guaranteed to hit.

Live tests use isolated CODEX_HOME/CLAUDE_CONFIG_DIR under `.test-runtime/<run>/provider-homes`, seeding only required authentication/configuration without copying history. Old AgentTandem test conversations are hidden from parent project lists; directly opening a test workspace still shows them. `test:models:live -- --reopen` accepts only history-isolated runtimes.

### Review changes from external agents

Tracking starts automatically in trusted local workspaces. Find **Tracking on/off** beside quota in the bottom VS Code status bar; it shows the pending file count. Click it to review changes, pause/resume tracking, capture changes immediately, or open the getting started guide. The chat's More actions menu and **AgentTandem: Change Tracking Controls** also open these controls. AgentTandem snapshots the current workspace without starting a provider or sending a chat request. Existing edits are the baseline. New edits, additions and deletions appear in pending review with the same file/hunk Accept and Revert actions.

Tracking is scoped to the selected workspace and persists across reloads. An explicit pause is remembered for that workspace and is not overridden by automatic startup. Pausing flushes final writes and retains pending review. Git ignores and the existing snapshot path/symlink checks apply. **AgentTandem: Capture External Changes Now** also scans immediately. AgentTandem chat works while tracking is enabled: capture waits for the native turn and resumes from its final snapshot. Pause tracking before restoring a message checkpoint. Set `agentTandem.autoTrackExternalChanges` to false to disable automatic startup in workspaces with no saved tracking choice.

The **Changes** screen displays the actual pending file list, grouped by conversation, independently of the collapsed chat review box. AgentTandem chat turns carry their session identity. External Claude Edit/Write/MultiEdit and Codex apply_patch edits are linked only when successful timestamped local tool records reproduce the complete captured content transition. Shell changes, unsupported operations and old captures without evidence stay under **Unassigned workspace changes**. Files with multiple conversations or mixed unassigned edits appear under **Shared workspace changes**. Opening a file uses the same full-file review editor and inline controls as chat; group decisions and navigation stay within the group. The chat review box shows the current conversation, with **Browse workspace changes** for everything else.

Tracking does not reconstruct edits made before its baseline. Unsaved editor buffers are not captured, and stale or unsaved target edits block Revert. Changes made while VS Code is closed are compared on resume. Stop the external writer before making final decisions to avoid continual new revisions.

The **Welcome to AgentTandem** walkthrough opens once on first activation. Its four steps explain tracking, file/block review, native CLI/chat setup and usage sources. Reopen it anytime with **AgentTandem: Getting Started**, the tracking status menu or **… → Getting started**.

### Storage and cleanup

Open **Settings & dashboard → Storage** to see the actual extension data path, total size and breakdown by review snapshots, demo history, checkpoints/Undo, attachments, usage evidence and preferences. **Reveal data folder** opens its location. VS Code supplies the profile-specific `globalStorageUri`; the default Windows stable profile normally uses `%APPDATA%\Code\User\globalStorage\agent-tandem-local.agent-tandem`. Remote hosts and other profiles may use a different location, so the path shown in Storage is authoritative.

Review data is stored in `reviews/history/snapshots` (file manifests), `reviews/history/blobs` (original/applied file bytes) and per-project records under `reviews`. Message checkpoints and Undo references live under `checkpoints`. Native Codex/Claude conversations stay in their own CLI storage, outside this cleanup.

**Preview cleanup** lists unreferenced snapshot manifests and blobs older than 24 hours. **Clean unused snapshots** confirms that specific preview, then rechecks current references and file identity under the same storage lock used by capture/checkpoint writers across windows. Newly referenced or changed targets are kept; failures and skipped files are reported. Tracking baselines, pending review before/after bytes, active captures, message checkpoints, Undo and recorded demo history remain protected. Workspace files, native conversations, attachments, preferences and usage/account records are retained. Corrupt or missing reference metadata blocks cleanup. Cleanup does not weaken file/hunk Revert or checkpoint Restore for retained data.
