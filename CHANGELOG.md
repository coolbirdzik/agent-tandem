# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/).

Historical version dates and boundaries are reconstructed from package version commits. Comparison links use those commits because release tags are unavailable in this checkout.

## [Unreleased]

### Added

- Dashboard: filter usage by **5h cycle** or **Weekly cycle** of one account, between its quota resets. Step through recorded cycles, see hourly or daily activity, quota used in the cycle and the provider's unattributed tokens in the same window.

- Usage: attribute Codex and Claude responses without account evidence to the one account whose quota rose around them. Matches are saved under **Matched from quota changes** and never replace native evidence or a user assignment. Responses that match no account or several stay **Unknown account**.

- Usage: keep token counts after a transcript is deleted, whether by conversation cleanup or a CLI's own retention. The conversation stays in the dashboard marked **Transcript deleted, tokens kept**, and only **Delete kept token history…** removes the counts, after a confirmation.

- Storage: confirm the conversation count and active filters before permanent deletion, including any subagent history deleted with its parent. Pause on deletion errors with **Skip**, **Skip All** for the same provider and error, or **Cancel**. Cancellation stops remaining deletions and reports the work already completed.

### Changed

- Dashboard: replace the long page with date chips, a summary of tokens, API-equivalent cost, quota and unknown-account tokens, and **Overview**, **Quota**, **Conversations** and **Details** tabs. **View usage** on an account card now filters the whole dashboard; the separate **By account** / **All accounts** view selector is gone.

- Agent sidebar tab: remove the 900px maximum width so the chat fills the available width.

### Fixed

- Usage: count compressed Codex history. Rollouts Codex stored as `.jsonl.zst` were skipped, so their tokens and conversations were missing from the dashboard and could not be assigned. Compressed files are decoded as a stream and cached; files that cannot be decoded are reported as unreadable.

- Claude: find the CLI bundled with the Claude Code editor extension when no `claude` is on PATH, instead of failing with "claude was not found". A PATH CLI still takes precedence, and the bundled CLI appears in Manage CLIs.
- Match quota burn-down chart legends to the visible chart lines.

## [0.1.35] - 2026-10-27

### Changed

- Dashboard: show local usage alongside API activity and the latest API reporting date. Improve quota cycle boundaries and estimates when recording starts partway through a cycle.

## [0.1.34] - 2026-10-27

### Added

- Accounts: use the macOS Keychain when reading and switching Claude Code sign-ins.

## [0.1.33] - 2026-10-27

### Added

- Review: display Shift_JIS and EUC-JP Japanese text and support individual change decisions when both sides use a compatible encoding, preserving the original bytes. Keep incompatible encodings under whole-file review.

### Fixed

- Handle localized Git output reliably when capturing review files.

## [0.1.32] - 2026-10-26

### Fixed

- Recover saved account labels when provider metadata contains placeholder labels.

## [0.1.31] - 2026-10-25

### Changed

- Show quota reset times and summaries in account hovers and preserve the selected dashboard account when switching sign-ins.

## [0.1.30] - 2026-10-22

### Added

- Storage: add **Clean accepted**, **Clean history (keep pending)** and **Clear saved review data…** with exact cleanup previews. Show space retained by saved comparisons and revert Undo. Clearing saved review data also removes checkpoints and restore backups and stops tracking; workspace files, chats and recorded demos are kept.

## [0.1.29] - 2026-10-22

### Fixed

- Improve organization name matching and legacy Claude profile recovery so saved accounts remain recognizable.

## [0.1.28] - 2026-10-22

### Changed

- Improve the status-bar account picker with clearer account and quota details, separate dashboard and account-manager shortcuts, and an action to use an available earned Codex reset.

## [0.1.27] - 2026-10-22

### Added

- Dashboard: show estimated full-cycle token capacity and tokens left for 5h and Weekly quota windows, with the observed quota interval and calculation basis.

## [0.1.26] - 2026-10-22

### Added

- Dashboard: switch cycle charts between Tokens / 1%, Recorded tokens and Full quota estimate, inspect cycle details, and compare against the weighted average while keeping API, Local and Device estimates separate.

## [0.1.25] - 2026-10-21

### Added

- Codex: automatically select a valid CLI from PATH, then fall back to the current VS Code host's Codex extension. Improve bundled CLI discovery across platforms in **Manage CLIs**, while retaining explicit project selections.

### Changed

- Polish webview controls, scrollbars and hover hints, and preserve interface state across refreshes.

### Fixed

- Package the versioned VSIX correctly on Windows.

## [0.1.24] - 2026-10-19

### Fixed

- Review: stop tracking untracked files newly covered by Git ignore rules, removing stale generated files from pending review while retaining tracked files.

## [0.1.23] - 2026-10-18

### Added

- Accounts: automatically update Claude Code and Codex profiles when terminal sign-in finishes. New credentials retry immediately after an earlier sign-in error; unchanged credentials retain quota backoff. Verify account identity before updating the saved profile, discard stale signed-out reads during login, and keep renewed credentials until explicitly switching to them, including across restarts. Show progress while refreshing accounts.

- Review: select the file being reviewed in VS Code's Explorer as you move between changed files, in both the Monaco review and native diffs. Review files open from snapshots, so Explorer's own auto-reveal never followed them. Keyboard focus returns to the editor; deleted files are skipped. Turn off with `agentTandem.revealReviewFileInExplorer`.

## [0.1.22] - 2026-10-17

### Added

- Offer a window reload after a Codex or Claude Code account switch so native extensions can pick up the new sign-in.

## [0.1.21] - 2026-10-17

### Added

- Storage: highlight space at the top of every Storage tab. **In use now** totals Codex chats, Claude Code chats and AgentTandem data with a share bar; **Freed so far** keeps a lifetime total of space reclaimed by conversation, restore history and unused-file cleanup, with counts and the last cleanup, saved across restarts.
- Storage: filter conversations by the local calendar year of their last message. The Year list shows each year with its chat count and combines with the age, date, provider, status and search filters, so Delete all matching can clear a whole year at once.
- Storage: add a sortable Last message column, default to oldest first, and filter by a chosen cutoff date. Delete matching removes every eligible filtered conversation, including unloaded rows; Delete selected removes the selection immediately. Keep file checks and active-session protection, and reject cascading subagent history newer than the cutoff.
- Support Shift-click range selection and deselection in conversation cleanup and restore history. Follow the displayed filtered order, skip protected conversations and retain the selection anchor across list updates.
- Storage: add optional native Codex and Claude Code conversation cleanup across projects, with age/provider/archive/search filters, explicit selection, a file and size preview, and deletion progress/errors. Protect open, queued and recently updated sessions; recheck previewed files and include subagent payloads. Use native provider deletion to keep their indexes consistent.

### Changed

- Open Git image changes in AgentTandem's Before / After view. Clicking an image in Source Control, or a Git image diff tab restored after reload, no longer reaches VS Code's built-in binary image diff, which fails with "Cannot read properties of undefined (reading 'selection')" and closes. Staged changes compare HEAD → index, unstaged index → working tree (untracked as added), with file navigation across changed images. Also available as **AgentTandem: Open Image Changes**; turn off with `agentTandem.openGitImageDiffs`.
- Review: add **Reject all** beside **Accept all** in the file toolbar. It restores the displayed file to its saved baseline after a confirmation naming the file, binds to the shown file and revision like Accept all, and can be undone. Accept/Reject buttons in the review editor are now rounded pills, set apart from the square navigation controls.
- Storage: Delete all matching now deletes everything the filters match in one run instead of only the rows whose dates had loaded. The host reads pending message dates first, then deletes; conversations that are protected or have newer subagent history are kept and reported instead of failing the run. A dialog shows progress and the result, with deleted and kept conversations and their reasons.
- Storage: show the conversation list without waiting to decode compressed Codex history. Message dates for `.jsonl.zst` rollouts are read in the background (rows use the newer file time, marked ~, until then), saved across VS Code restarts, and stopped before any deletion. Decoding parses only candidate message lines.
- Simplify Storage into Conversations, Restore history and Unused files views. Open native chat cleanup with an automatic scan, quick age/archive presets, a searchable list and a nearby selection summary. Replace the crowded deletion area with a focused review step, preserve list focus/scroll during unrelated updates and keep navigation usable in narrow editor panes.

### Fixed

- Fix Codex conversation cleanup failing with "rollout … is empty" for early (pre-`session_meta`) rollouts. Current Codex CLIs cannot read or index them, so AgentTandem now deletes those files directly when Codex has no index entry for them; indexed threads still use `thread/delete`.
- Fix conversation deletion failing with "Wait for the active agent or conversation sync to finish" while no agent was running. The 5-second history sync now pauses during deletion and an in-flight sync is awaited instead of rejecting the run.
- Fix native conversation cleanup failing on Codex `.jsonl.zst` history. Read a bounded Zstandard prefix without unpacking files into the history folder, include compressed payload paths and on-disk sizes in previews, recognize early flat session metadata, and leave empty rollout placeholders untouched. Retain stale-preview and subagent protections during native deletion.

## [0.1.20] - 2026-10-16

### Fixed

- Retry temporary Windows file deletion failures when releasing storage locks.

## [0.1.19] - 2026-10-16

### Changed

- Dashboard: View usage now opens a dedicated account page with an "All accounts" button to return to the account overview. Tokens per 1% quota gives each provider a full-width row with its 5h and Weekly windows side by side, so a single account no longer fills only half the width.

## [0.1.18] - 2026-10-16

### Added

- Storage: let users free change tracking baselines, which can hold most of the stored data for large projects. They appear per project in Restore history and as an opt-in "Change tracking baselines" choice in Clean up…; deleting one stops tracking for that project (pending review stays) and also sweeps the old unused baselines left by earlier scans.

### Changed

- Storage: sort restore history by the space each conversation actually frees (snapshot data shared with other history or Review no longer inflates its size), show the referenced total beside it, and add Quick select presets for the biggest space savers and history not saved in 7+ or 30+ days.

## [0.1.17] - 2026-10-15

### Added

- Configure status-bar progress, ring, minimal, text and icon styles, countdowns and provider colors. Select message checkpoints, restore backups and unused snapshots for cleanup with preview and progress.

## [0.1.16] - 2026-10-15

### Changed

- Replace generic status-bar symbols with dedicated Codex blossom and Claude starburst icons in every display mode; match the Preferences preview and retain quota colors and accessible labels.

### Fixed

- Keep Storage inspection and snapshot cleanup working when Codex profile temporary folders contain linked tool launchers; skip those links without following or deleting them, while retaining link guards for credentials and snapshot data.

## [0.1.15] - 2026-10-15

### Changed

- Update the README and account-management and dashboard screenshots.

## [0.1.14] - 2026-10-15

### Added

- Project remaining quota to the reset time, show consumption pace and estimated exhaustion, and break down dashboard usage by period and model.

## [0.1.13] - 2026-10-15

### Added

- Cache account quota across sessions and improve native Codex and Claude applied-edit capture for conversation grouping.

### Changed

- Recognize Git-committed changes during review so committed content is treated as accepted.

## [0.1.12] - 2026-10-14

### Fixed

- Correct the quota status tooltip for the usage dashboard shortcut.

## [0.1.11] - 2026-10-14

### Added

- Search and switch saved accounts from a quick picker showing quota and reset status. Configure quota status-bar providers, fields, windows, placement and style, and assign historical usage to accounts.

## [0.1.10] - 2026-10-14

### Added

- Show banked resets with countdowns and reset details.

## [0.1.9] - 2026-10-14

### Fixed

- Resolve webview resources correctly in remote and WSL workspaces; document WSL setup.

## [0.1.8] - 2026-10-13

### Added

- Manage and switch native account profiles, inspect Cursor and Antigravity desktop accounts, and estimate quota consumption pace.

## [0.1.7] - 2026-10-13

### Changed

- Clarify usage instructions in the README.

## [0.1.6] - 2026-10-13

### Changed

- Maintenance release with updated external change-tracking regression coverage.

## [0.1.5] - 2026-10-13

### Added

- Automatically publish tagged releases to VS Code Marketplace after validation.

## [0.1.4] - 2026-10-13

### Added

- Review saved Before / After image snapshots for added, modified and deleted images, with whole-file decisions and navigation.

### Changed

- Persist account-matched API quota baselines and keep API token estimates separate from Local estimates.

## [0.1.3] - 2026-10-13

### Added

- Add direct Previous/Next file navigation and Alt+PageUp/PageDown shortcuts in both review modes, plus a changed-file picker. Native review also provides editor-title controls and a clickable File x/y status-bar counter.

### Changed

- Default local and Marketplace review to a bundled Monaco Webview with full-file syntax highlighting, inline red/green diffs, search and colored Accept, Reject, Next change and Next file buttons above each edit. Keep native diff available as an option. Preserve snapshot decisions, Undo, group scope and protection for stale previews, newer edits and unsaved buffers.
- Document Tracking on as the first setup step and explain review editor selection in the README and walkthrough.

## [0.1.2] - 2026-10-12

### Changed

- Rename the extension and repository branding from AgentDock to AgentTandem.

## [0.1.1] - 2026-10-12

### Added

- Add version bump commands and atomic release pushes, with GitHub Releases generated from git history.

### Changed

- Refresh the extension icon, feature screenshots and contributor guide; use native editor diffs in the documentation.

### Fixed

- Correct Windows CI paths.

## [0.1.0] - 2026-10-12

### Added

- Open AgentTandem as a Review companion for native Codex/Claude chat. Add collapsible conversation groups, passive pending badges and a status-bar shortcut to the latest conversation diff. Preview file/group Revert before confirmation; persist Undo for the latest file/group/hunk Revert with scope guards, interrupted-decision recovery and cleanup protection.
- Add Settings → Storage with the runtime data path, category sizes, folder reveal and exact cleanup previews. Remove only unused snapshots/blobs older than 24 hours, revalidate references before deletion, and coordinate snapshot writers/cleanup across windows. Preserve tracking baselines, pending file/hunk Revert, message checkpoints, Undo and demo history; keep native conversation history and usage/account records intact. Report changed targets, failures and blocked cleanup.
- Add persistent external change tracking for Codex/Claude used outside AgentTandem. Capture disk edits from a workspace baseline, auto-refresh pending review, flush on stop, and rebase file/hunk decisions to prevent recapturing own reverts. Label external changes without guessing their writer.
- Read Codex server token activity through account/usage/read and display account-bound lifetime metrics and daily/weekly/monthly buckets separately from Local counts. Label API, Local and Estimate sources; preserve missing metrics, expose unavailable API reasons, and never add API and Local totals together. Use native workspace identity when reported.
- Separate usage and API equivalent cost by account with an account filter and breakdown. Persist native account evidence per response/turn across resume, forks and reload; keep unattributed historical/external usage under Unknown account. Match tokens per quota percentage point only to the exact current provider/account/organization.
- Add dashboard shimmer skeletons for initial loading, retain existing values while refreshing, and respect reduced motion and high contrast. Color quota status by the lowest remaining window and tint the agent activity strip for working, waiting, saving and stopping.
- Support clipboard image paste, file drag/drop and a multi-file picker in chat, with previews, removal and attachment-only messages. Preserve attachments through queues, retries, native history refresh and edit/resend. Send native Codex image/audio/file inputs and Claude image/PDF content blocks; stage other files outside the project for the agent to read.
- Add filtered API-equivalent USD totals and provider/model/day/week/month costs using verified standard model rates. Price deduplicated responses before aggregation, separate cache reads/writes and output, retain Claude one-hour cache writes and mark unknown models Unpriced.
- Estimate local tokens per percentage point of each provider's current 5-hour and weekly quota. Match recent timestamped usage to native reset windows, project total/remaining capacity and explain unavailable or stale data; keep estimates independent of history filters.
- Give each pending block a themed action card above it: a Block i/n chip, its added/removed line counts and Accept, Reject and Next change buttons with keyboard hints. Fall back to an Accept | Reject | Next change code lens row wherever the proposed inset API is unavailable, so released VS Code builds and installed VSIX packages keep per-block review; never render both styles at once. Enable `diffEditor.codeLens` when opening a review, add `Alt+Y`/`Alt+N`/`Alt+Down`/`Alt+Up` keybindings, keep every action bound to its own immutable hunk and revision, and drop stale actions without writing files. Add `agentTandem.blockActionsStyle` (`auto`, `lens`, `off`).
- Trial an in-editor File i/n button using the proposed editorInsets API while retaining native diffs and floating arrows. The button scrolls with the code and opens a changed-file picker. Add a setting to hide it; document the proposed API lifecycle warning when VS Code disposes an editor.
- Add floating Previous/Next change buttons inside native single-file and multi-file diff editors, with native hunk navigation and wrapping. Scope menus to AgentTandem comparisons and enable the proposed content menus for the local VSIX install; preserve and back up existing runtime arguments. Verify rendered menus and actual mouse clicks in an isolated VS Code renderer.
- Open changed-file links directly in the native VS Code diff editor and View changes/Cumulative in the multi-file changes editor. Preserve immutable snapshots through Accept/reload, added/deleted empty sides and complete large-file content; keep review decisions in AgentTandem.
- Discover versioned Windows Codex desktop binaries and app-server daemon releases, including custom CODEX_HOME and current junctions. Rescan refreshes versions and repaired errors while preserving names, enabled flags and selections.
- Keep Restore visible beside Edit on every user message. Disable unavailable checkpoints with an explicit explanation, show checkpoint preparation state, and enable the action as soon as the saved snapshot arrives.
- Give user messages a quiet theme-derived surface and compact, visible edit/restore actions. Add persistent before-send checkpoints for Codex and Claude, native-history message matching, branch inheritance, affected-file previews, stale/dirty/link/blob guards, interrupted-restore journalling and Undo restore. Restoring code preserves chat history and reconciles pending review.
- Share one themed dropdown component across model, reasoning, access, CLI management, agent questions and diff selection; preserve native value/form validation with custom listbox navigation, descriptions, selected checks and viewport-aware placement.
- Show latest context tokens/capacity/cache reads for both CLIs. Estimate Claude cache expiry only from reported TTLs, retain the original measurement across sync/reopen and invalidate on model changes. Codex cache TTL remains explicitly unavailable.
- Add reasoning effort from Codex/Claude model capability metadata, persist it per project/provider/model, validate stale levels and forward the setting on start/resume/fork. Auto inherits native CLI configuration; unsupported models remain Auto.
- Manage Codex and Claude CLI installations: persisted names/paths/versions, add/edit, enable/disable, remove registry entries, explicit scan and version checks, machine defaults and project selection.
- Native access mode picker in the composer: Codex Agent/Read only/Full access and Claude Ask/Auto edits/Plan/Auto/Don't ask/Full access. Full access reaches the actual CLI sandbox/permission settings without an extra approval dialog.
- Native Codex turn-boundary forks and Claude message-boundary forks, fresh context for first-message edits, host validation/stale-history guards, persisted edit drafts, and live provider context-isolation coverage.
- Added real Windows descendant-process isolation coverage and live Codex/Claude Stop, partial review, resume and Revert checks in VS Code.
- Visible working strip for Codex/Claude with animated provider ring/dots, real tool activity, preparing/finishing/waiting states and Stop.
- Applied changes pending review above the composer: file list, line counts, immutable diff, Accept/Revert per file or all.
- Persistent project review across chat turns, history refresh and VS Code restart; cumulative original baseline until accepted.
- Real workspace snapshots for both providers, partial-turn/reload recovery and guarded revert preserving later/unsaved edits.
- Real Codex/Claude edit/add/delete review tests in a disposable VS Code Extension Host.
- Editable chat composer: Enter to send, Shift+Enter for newline, per-session drafts and failed-message retry.
- New/resumed Codex app-server and Claude SDK conversations, streamed replies, tool output, Stop and permission prompts.
- Conversation-first layout, compact history/search and VS Code Codicons.
- Automatic current workspace root; multi-root follows the active editor without a project picker.
- Safe Markdown replies, code blocks and collapsed tool activity.
- Single sidebar panel for conversations, tool activity, inline changes and diagnostics.
- Distinct Claude Code/Codex icons, provider labels and session filter.
- Project conversation browser for existing local Codex and Claude Code sessions.
- Automatic transcript sync, provider isolation, project boundaries and selection persistence.
- Bundled official Claude Agent SDK session history reader; no inference required to read history.
- Native step tree and preview panel.
- Immutable content-addressed snapshots for serialized local operations.
- Per-step and cumulative diffs, multi-file changes editor and single-file fallback.
- Session persistence and interrupted-run recovery.
- Codex app-server handshake/model catalog check and Claude CLI availability check.
- Integration tests in the real VS Code Extension Development Host.

### Changed

- Queue snapshot operations per storage folder within each window before acquiring the shared lock. Allow up to two minutes for another window's capture/cleanup, and require detached callbacks to reacquire released locks.
- Persist a token-only native history cache across reloads, reparse only changed files and reapply account evidence on every aggregation. Skip unrelated settings updates during chat/review activity, preserve dashboard history tables on quota updates and reuse numeric formatters.
- Show the actual pending file list on Changes, grouped by native conversation. Persist AgentTandem turn identity and bind draft sessions; verify timestamped successful Claude Edit/Write/MultiEdit and Codex apply_patch history against captured content before linking external edits. Keep unknown and shared edits explicit. Scope chat review, group decisions and native diff navigation to their conversation, and protect intermediate evidence blobs during cleanup. Avoid creating workspace settings files merely by opening a review diff.
- Automatically track trusted local workspaces, remember an explicit pause per workspace, and expose colored Tracking on/off with pending counts beside quota in the bottom status bar. Keep AgentTandem chat available while tracking. Show a native four-step getting started walkthrough once, with manual access from commands and menus.
- Open native reviews in inline mode, with old/new lines in one pane, and present a compact Accept | Reject action row for each pending block, styled like conflict-resolution links. Use the workspace's native diff layout setting for single and multi-file views.
- Place a separate Accept/Revert pair immediately above each pending diff block using editor insets. Bind each pair to its immutable hunk and revision so clicks act on that block independently of the cursor; mount controls near the viewport and clear them before navigation. Preserve EOL/UTF-16 encoding, accepted content across later turns and other pending blocks. Reject stale previews and later saved/unsaved edits; retain file-level review for binary/large files.
- Keep the complete change set when opening a single review/step file. Continue Previous/Next into the adjacent file at a hunk boundary, including added/deleted files, wrap the set, serialize rapid clicks and persist navigation across reload. Show the current/total file count in diff titles and the editor status bar; update it during native multi-file navigation.
- Resolve Windows npm Codex binaries in both the current vendor/bin and legacy vendor/codex layouts, including nested platform packages and changing NVM junctions. Preserve terminal PATH selection and report genuinely missing binaries.
- Isolate all native live-test provider histories with per-run CODEX_HOME/CLAUDE_CONFIG_DIR, seed login/config only and refuse shared-history legacy reopens. Exclude known old AgentTandem test run directories from parent-project conversation lists for both providers, preserving normal nested chats and literal pasted test prompts.
- Compact the composer to a small model trigger, access selector and Send button. Open model/reasoning/provider controls in an anchored popover; support Escape, outside click, tab-out, resize, active-run locks and context changes.
- Align the composer as labeled Model, Reasoning and Access controls with adaptive columns, full-width model selection in narrow sidebars, and consistent locking/focus during active turns.
- Soften the flat interface with quiet theme-derived surfaces, fewer separators, rounded controls, a visible chat input and clearer spacing across conversations, review and CLI management. Preserve keyboard focus and reduced-motion/high-contrast support.
- Simplify CLI helper text, add provider logos, shorten long path displays with full-path tooltips, and adapt model/access controls and CLI selections to narrow/wide panels.
- Enforce the enabled CLI registry for model discovery, provider probes and chat; preserve project selection by entry ID across path edits/restart, and block unavailable selections. Remove keeps executables on disk; subsequent scans add new installations disabled.
- Verify management, disabled model/chat blocking, recovery, selection persistence and removal with real native CLIs in VS Code; add registry/webview regression coverage and a flat responsive manager.
- Flatten the chat/composer/tool surfaces, remove bubble borders and menu shadows, and keep compact model/access controls, theme colors and keyboard focus.
- Bind model catalogs and inference to the same CLI executable/version; validate stale catalog sources. Verify terminal discovery, the current Codex catalog/model switching, Claude model switching, resume and persistence in a real Extension Host.
- Remember access per project/provider across resume and restart, validate modes at the host, lock changes during active runs, and preserve provider rules and project-scoped change review.
- Edit and resend earlier user messages from history: edit in the composer, Cancel/Escape restores the prior draft, and Send branches from the preceding context while preserving the original conversation and current files.
- Permission prompts now offer Always allow using Codex's proposed command rules or Claude's project-local permission updates, plus scoped per-run approval where supported.
- Remember choices show their scope, honor provider restrictions, validate host replies, and keep Allow once/Decline separate from persisted approvals.
- Replaced the placeholder Codex terminal icon with the original SVG from OpenAI's Codex extension, with light/dark/high-contrast theme support across history, messages and working feedback.
- Removed the 100 MiB review file limit: large snapshots, integrity checks and Revert stream bytes with bounded memory; unchanged large files reuse their snapshots.
- Regression coverage for a real 105 MiB src/core file, persistence, Accept/Revert and edits made during restore.
- Working feedback stays visible across history/changes; effects pause for user input, clear after completion/Stop/error and respect reduced motion.
- Large workspace regression covers over 20,000 real files, Git/non-Git capture, review and revert; baseline capture can be stopped.
- Editor tabs and native diffs open only through explicit actions.
- Named AgentTandem — Claude Code & Codex Chat, Code Review & Usage.
- Added/deleted file previews, binary metadata, partial failure capture and Stop.

### Fixed

- Hide automatic open-page metadata in Codex response-only history so Edit and resend matches native user-message indexes instead of reporting a false provider-history change. Preserve human examples and stale-history checks; verify first/middle edits and refresh/reopen.
- Handle Windows taskkill/exit-event races when an owned descendant exits during cleanup; still reject cleanup if the root remains alive.
- Match terminal CLI PATH order including npm launchers instead of silently selecting another installed Codex binary. Add project-scoped CLI selection in Diagnostics and show CLI path/version provenance.
- Hide pure injected plugin/environment context from legacy Codex response-only history instead of attributing it to You or using it as the title. Preserve explicit human messages, quoted examples, assistant replies and tool output without rewriting transcripts.
- Align edit/resend fork boundaries with the filtered legacy history while preserving literal context blocks when native history matches explicit human prompts.
- Fixed all chat Stop controls, including stalled initialization/turn-start, pending approvals and hung Claude streams. Show Stopping/Saving changes, terminate the owned CLI process tree before review capture, preserve partial changes and resume the same conversation.
- Fixed Enter/send failing in projects over 20,000 files: removed workspace file-count/total-size limits, bounded capture concurrency and reuse of unchanged/identical blobs.
- Resolve unavailable ChatGPT Codex models from the app-server catalog without changing CLI configuration.

[Unreleased]: https://github.com/nh-kng/agent-tandem/compare/2bddae8575a72d8a0341d78b4c7176f38235d861...HEAD
[0.1.35]: https://github.com/nh-kng/agent-tandem/compare/4e54c88915fe2ced7f152c2bf3e3500e965858da...2bddae8575a72d8a0341d78b4c7176f38235d861
[0.1.34]: https://github.com/nh-kng/agent-tandem/compare/c0188777a174d5f37934c3f96d50c90dd4272381...4e54c88915fe2ced7f152c2bf3e3500e965858da
[0.1.33]: https://github.com/nh-kng/agent-tandem/compare/b3f83a893a603c69cd31db3b97217523478277c5...c0188777a174d5f37934c3f96d50c90dd4272381
[0.1.32]: https://github.com/nh-kng/agent-tandem/compare/90eeee7c589f84679168500a0f1c854ad739886b...b3f83a893a603c69cd31db3b97217523478277c5
[0.1.31]: https://github.com/nh-kng/agent-tandem/compare/88752e245d10d4923fd0a14fc7cc533ae979483d...90eeee7c589f84679168500a0f1c854ad739886b
[0.1.30]: https://github.com/nh-kng/agent-tandem/compare/286b958419158ad078188317ff3ee84751503efe...88752e245d10d4923fd0a14fc7cc533ae979483d
[0.1.29]: https://github.com/nh-kng/agent-tandem/compare/2584ddd31153c780284663357731c3d95bb6b063...286b958419158ad078188317ff3ee84751503efe
[0.1.28]: https://github.com/nh-kng/agent-tandem/compare/054f40594ed02d5746568ff7c4b3bcb3d0763171...2584ddd31153c780284663357731c3d95bb6b063
[0.1.27]: https://github.com/nh-kng/agent-tandem/compare/1b0e6ab7861db290fe08b8eb2dcb1be1420a8cf3...054f40594ed02d5746568ff7c4b3bcb3d0763171
[0.1.26]: https://github.com/nh-kng/agent-tandem/compare/04e2c7284e473a25135d8c50b498aff59b62a9fe...1b0e6ab7861db290fe08b8eb2dcb1be1420a8cf3
[0.1.25]: https://github.com/nh-kng/agent-tandem/compare/07502d5ece0bead4a8e6c9e63cd0f4fe70874085...04e2c7284e473a25135d8c50b498aff59b62a9fe
[0.1.24]: https://github.com/nh-kng/agent-tandem/compare/91598c44525df70642d5c68d86fcb3e3f4f9662f...07502d5ece0bead4a8e6c9e63cd0f4fe70874085
[0.1.23]: https://github.com/nh-kng/agent-tandem/compare/e7e32039723f4db4a28527f131aebd4b498eaa6d...91598c44525df70642d5c68d86fcb3e3f4f9662f
[0.1.22]: https://github.com/nh-kng/agent-tandem/compare/53e7a021f137377991bd6a991aa69618603d3455...e7e32039723f4db4a28527f131aebd4b498eaa6d
[0.1.21]: https://github.com/nh-kng/agent-tandem/compare/3b5509e5f53f1625ddf20d94fb52cacbd34d92fb...53e7a021f137377991bd6a991aa69618603d3455
[0.1.20]: https://github.com/nh-kng/agent-tandem/compare/24507e279164a0e7bbd4b7600fe36ba62751487b...3b5509e5f53f1625ddf20d94fb52cacbd34d92fb
[0.1.19]: https://github.com/nh-kng/agent-tandem/compare/fcc348ba3c9789eeb5978fc569030b9afea3316e...24507e279164a0e7bbd4b7600fe36ba62751487b
[0.1.18]: https://github.com/nh-kng/agent-tandem/compare/0d7f7b151f0795e16db515a562ac7cd7e7b8e98c...fcc348ba3c9789eeb5978fc569030b9afea3316e
[0.1.17]: https://github.com/nh-kng/agent-tandem/compare/97124edabd54a3a8002986fb95d89c10c671f7b1...0d7f7b151f0795e16db515a562ac7cd7e7b8e98c
[0.1.16]: https://github.com/nh-kng/agent-tandem/compare/33267c194e6db3f4b4603ab5fb76c360bcfa6103...97124edabd54a3a8002986fb95d89c10c671f7b1
[0.1.15]: https://github.com/nh-kng/agent-tandem/compare/f92be9d958ed506451595744a3d753facdd17938...33267c194e6db3f4b4603ab5fb76c360bcfa6103
[0.1.14]: https://github.com/nh-kng/agent-tandem/compare/ba089549a74ad2d52d8c2d78e79095cc32a3c51b...f92be9d958ed506451595744a3d753facdd17938
[0.1.13]: https://github.com/nh-kng/agent-tandem/compare/8730972e7317b8a8a7373a381ce725fdd10db5de...ba089549a74ad2d52d8c2d78e79095cc32a3c51b
[0.1.12]: https://github.com/nh-kng/agent-tandem/compare/6f83872f9d92781bcfbcdb2d81b324571e97ca0e...8730972e7317b8a8a7373a381ce725fdd10db5de
[0.1.11]: https://github.com/nh-kng/agent-tandem/compare/9114441a3865294d6982bf0cf813ab6e41236ecd...6f83872f9d92781bcfbcdb2d81b324571e97ca0e
[0.1.10]: https://github.com/nh-kng/agent-tandem/compare/1d97a890b13b16ca522d54c42b592421146133c4...9114441a3865294d6982bf0cf813ab6e41236ecd
[0.1.9]: https://github.com/nh-kng/agent-tandem/compare/c57bdb6240d627b4234f7722ada8aed0875fa5b7...1d97a890b13b16ca522d54c42b592421146133c4
[0.1.8]: https://github.com/nh-kng/agent-tandem/compare/771f1ad39323db5450f3a7f0b2424b1f515183f6...c57bdb6240d627b4234f7722ada8aed0875fa5b7
[0.1.7]: https://github.com/nh-kng/agent-tandem/compare/2050de8609fb75edba45bdac46c0b04f32260ecf...771f1ad39323db5450f3a7f0b2424b1f515183f6
[0.1.6]: https://github.com/nh-kng/agent-tandem/compare/ba04ebe5260c824708c2dbed71c75c71b133af02...2050de8609fb75edba45bdac46c0b04f32260ecf
[0.1.5]: https://github.com/nh-kng/agent-tandem/compare/94d3f180adadc0e99d482abe59e375ac6d4feac6...ba04ebe5260c824708c2dbed71c75c71b133af02
[0.1.4]: https://github.com/nh-kng/agent-tandem/compare/d78f541eceee07202053000abd8a26592c723fbf...94d3f180adadc0e99d482abe59e375ac6d4feac6
[0.1.3]: https://github.com/nh-kng/agent-tandem/compare/6c882e747eb34bc82170f761233966ba46340a04...d78f541eceee07202053000abd8a26592c723fbf
[0.1.2]: https://github.com/nh-kng/agent-tandem/compare/fd99a3b305289efcf3c9e571d0b4149d2fba83b6...6c882e747eb34bc82170f761233966ba46340a04
[0.1.1]: https://github.com/nh-kng/agent-tandem/compare/49618bd224ad8ef287c7560241f151b04711de3b...fd99a3b305289efcf3c9e571d0b4149d2fba83b6
[0.1.0]: https://github.com/nh-kng/agent-tandem/tree/49618bd224ad8ef287c7560241f151b04711de3b
