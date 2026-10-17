# Changelog

## Unreleased

- Review: select the file being reviewed in VS Code's Explorer as you move between changed files, in both the Monaco review and native diffs. Review files open from snapshots, so Explorer's own auto-reveal never followed them. Keyboard focus returns to the editor; deleted files are skipped. Turn off with `agentTandem.revealReviewFileInExplorer`.

- Open Git image changes in AgentTandem's Before / After view. Clicking an image in Source Control, or a Git image diff tab restored after reload, no longer reaches VS Code's built-in binary image diff, which fails with "Cannot read properties of undefined (reading 'selection')" and closes. Staged changes compare HEAD → index, unstaged index → working tree (untracked as added), with file navigation across changed images. Also available as **AgentTandem: Open Image Changes**; turn off with `agentTandem.openGitImageDiffs`.

- Review: add **Reject all** beside **Accept all** in the file toolbar. It restores the displayed file to its saved baseline after a confirmation naming the file, binds to the shown file and revision like Accept all, and can be undone. Accept/Reject buttons in the review editor are now rounded pills, set apart from the square navigation controls.

- Storage: highlight space at the top of every Storage tab. **In use now** totals Codex chats, Claude Code chats and AgentTandem data with a share bar; **Freed so far** keeps a lifetime total of space reclaimed by conversation, restore history and unused-file cleanup, with counts and the last cleanup, saved across restarts.

- Fix Codex conversation cleanup failing with "rollout … is empty" for early (pre-`session_meta`) rollouts. Current Codex CLIs cannot read or index them, so AgentTandem now deletes those files directly when Codex has no index entry for them; indexed threads still use `thread/delete`.

- Fix conversation deletion failing with "Wait for the active agent or conversation sync to finish" while no agent was running. The 5-second history sync now pauses during deletion and an in-flight sync is awaited instead of rejecting the run.

- Storage: filter conversations by the local calendar year of their last message. The Year list shows each year with its chat count and combines with the age, date, provider, status and search filters, so Delete all matching can clear a whole year at once.

- Storage: Delete all matching now deletes everything the filters match in one run instead of only the rows whose dates had loaded. The host reads pending message dates first, then deletes; conversations that are protected or have newer subagent history are kept and reported instead of failing the run. A dialog shows progress and the result, with deleted and kept conversations and their reasons.

- Storage: show the conversation list without waiting to decode compressed Codex history. Message dates for `.jsonl.zst` rollouts are read in the background (rows use the newer file time, marked ~, until then), saved across VS Code restarts, and stopped before any deletion. Decoding parses only candidate message lines.

- Storage: add a sortable Last message column, default to oldest first, and filter by a chosen cutoff date. Delete matching removes every eligible filtered conversation, including unloaded rows; Delete selected removes the selection immediately. Keep file checks and active-session protection, and reject cascading subagent history newer than the cutoff.

- Support Shift-click range selection and deselection in conversation cleanup and restore history. Follow the displayed filtered order, skip protected conversations and retain the selection anchor across list updates.

- Fix native conversation cleanup failing on Codex `.jsonl.zst` history. Read a bounded Zstandard prefix without unpacking files into the history folder, include compressed payload paths and on-disk sizes in previews, recognize early flat session metadata, and leave empty rollout placeholders untouched. Retain stale-preview and subagent protections during native deletion.

- Simplify Storage into Conversations, Restore history and Unused files views. Open native chat cleanup with an automatic scan, quick age/archive presets, a searchable list and a nearby selection summary. Replace the crowded deletion area with a focused review step, preserve list focus/scroll during unrelated updates and keep navigation usable in narrow editor panes.

- Storage: add optional native Codex and Claude Code conversation cleanup across projects, with age/provider/archive/search filters, explicit selection, a file and size preview, and deletion progress/errors. Protect open, queued and recently updated sessions; recheck previewed files and include subagent payloads. Use native provider deletion to keep their indexes consistent.

- Dashboard: View usage now opens a dedicated account page with an "All accounts" button to return to the account overview. Tokens per 1% quota gives each provider a full-width row with its 5h and Weekly windows side by side, so a single account no longer fills only half the width.

- Storage: sort restore history by the space each conversation actually frees (snapshot data shared with other history or Review no longer inflates its size), show the referenced total beside it, and add Quick select presets for the biggest space savers and history not saved in 7+ or 30+ days.

- Storage: let users free change tracking baselines, which can hold most of the stored data for large projects. They appear per project in Restore history and as an opt-in "Change tracking baselines" choice in Clean up…; deleting one stops tracking for that project (pending review stays) and also sweeps the old unused baselines left by earlier scans.

- Keep Storage inspection and snapshot cleanup working when Codex profile temporary folders contain linked tool launchers; skip those links without following or deleting them, while retaining link guards for credentials and snapshot data.

- Replace generic status-bar symbols with dedicated Codex blossom and Claude starburst icons in every display mode; match the Preferences preview and retain quota colors and accessible labels.

- Default local and Marketplace review to a bundled Monaco Webview with full-file syntax highlighting, inline red/green diffs, search and colored Accept, Reject, Next change and Next file buttons above each edit. Keep native diff available as an option. Preserve snapshot decisions, Undo, group scope and protection for stale previews, newer edits and unsaved buffers.
- Add direct Previous/Next file navigation and Alt+PageUp/PageDown shortcuts in both review modes, plus a changed-file picker. Native review also provides editor-title controls and a clickable File x/y status-bar counter.
- Document Tracking on as the first setup step and explain review editor selection in the README and walkthrough.

## 0.1.0

- Queue snapshot operations per storage folder within each window before acquiring the shared lock. Allow up to two minutes for another window's capture/cleanup, and require detached callbacks to reacquire released locks.

- Persist a token-only native history cache across reloads, reparse only changed files and reapply account evidence on every aggregation. Skip unrelated settings updates during chat/review activity, preserve dashboard history tables on quota updates and reuse numeric formatters.

- Open AgentTandem as a Review companion for native Codex/Claude chat. Add collapsible conversation groups, passive pending badges and a status-bar shortcut to the latest conversation diff. Preview file/group Revert before confirmation; persist Undo for the latest file/group/hunk Revert with scope guards, interrupted-decision recovery and cleanup protection.

- Show the actual pending file list on Changes, grouped by native conversation. Persist AgentTandem turn identity and bind draft sessions; verify timestamped successful Claude Edit/Write/MultiEdit and Codex apply_patch history against captured content before linking external edits. Keep unknown and shared edits explicit. Scope chat review, group decisions and native diff navigation to their conversation, and protect intermediate evidence blobs during cleanup. Avoid creating workspace settings files merely by opening a review diff.

- Add Settings → Storage with the runtime data path, category sizes, folder reveal and exact cleanup previews. Remove only unused snapshots/blobs older than 24 hours, revalidate references before deletion, and coordinate snapshot writers/cleanup across windows. Preserve tracking baselines, pending file/hunk Revert, message checkpoints, Undo and demo history; keep native conversation history and usage/account records intact. Report changed targets, failures and blocked cleanup.

- Automatically track trusted local workspaces, remember an explicit pause per workspace, and expose colored Tracking on/off with pending counts beside quota in the bottom status bar. Keep AgentTandem chat available while tracking. Show a native four-step getting started walkthrough once, with manual access from commands and menus.

- Add persistent external change tracking for Codex/Claude used outside AgentTandem. Capture disk edits from a workspace baseline, auto-refresh pending review, flush on stop, and rebase file/hunk decisions to prevent recapturing own reverts. Label external changes without guessing their writer.

- Read Codex server token activity through account/usage/read and display account-bound lifetime metrics and daily/weekly/monthly buckets separately from Local counts. Label API, Local and Estimate sources; preserve missing metrics, expose unavailable API reasons, and never add API and Local totals together. Use native workspace identity when reported.
- Separate usage and API equivalent cost by account with an account filter and breakdown. Persist native account evidence per response/turn across resume, forks and reload; keep unattributed historical/external usage under Unknown account. Match tokens per quota percentage point only to the exact current provider/account/organization.
- Add dashboard shimmer skeletons for initial loading, retain existing values while refreshing, and respect reduced motion and high contrast. Color quota status by the lowest remaining window and tint the agent activity strip for working, waiting, saving and stopping.

- Support clipboard image paste, file drag/drop and a multi-file picker in chat, with previews, removal and attachment-only messages. Preserve attachments through queues, retries, native history refresh and edit/resend. Send native Codex image/audio/file inputs and Claude image/PDF content blocks; stage other files outside the project for the agent to read.

- Add filtered API-equivalent USD totals and provider/model/day/week/month costs using verified standard model rates. Price deduplicated responses before aggregation, separate cache reads/writes and output, retain Claude one-hour cache writes and mark unknown models Unpriced.

- Estimate local tokens per percentage point of each provider's current 5-hour and weekly quota. Match recent timestamped usage to native reset windows, project total/remaining capacity and explain unavailable or stale data; keep estimates independent of history filters.

- Give each pending block a themed action card above it: a Block i/n chip, its added/removed line counts and Accept, Reject and Next change buttons with keyboard hints. Fall back to an Accept | Reject | Next change code lens row wherever the proposed inset API is unavailable, so released VS Code builds and installed VSIX packages keep per-block review; never render both styles at once. Enable `diffEditor.codeLens` when opening a review, add `Alt+Y`/`Alt+N`/`Alt+Down`/`Alt+Up` keybindings, keep every action bound to its own immutable hunk and revision, and drop stale actions without writing files. Add `agentTandem.blockActionsStyle` (`auto`, `lens`, `off`).

- Open native reviews in inline mode, with old/new lines in one pane, and present a compact Accept | Reject action row for each pending block, styled like conflict-resolution links. Use the workspace's native diff layout setting for single and multi-file views.

- Place a separate Accept/Revert pair immediately above each pending diff block using editor insets. Bind each pair to its immutable hunk and revision so clicks act on that block independently of the cursor; mount controls near the viewport and clear them before navigation. Preserve EOL/UTF-16 encoding, accepted content across later turns and other pending blocks. Reject stale previews and later saved/unsaved edits; retain file-level review for binary/large files.

- Trial an in-editor File i/n button using the proposed editorInsets API while retaining native diffs and floating arrows. The button scrolls with the code and opens a changed-file picker. Add a setting to hide it; document the proposed API lifecycle warning when VS Code disposes an editor.

- Keep the complete change set when opening a single review/step file. Continue Previous/Next into the adjacent file at a hunk boundary, including added/deleted files, wrap the set, serialize rapid clicks and persist navigation across reload. Show the current/total file count in diff titles and the editor status bar; update it during native multi-file navigation.

- Hide automatic open-page metadata in Codex response-only history so Edit and resend matches native user-message indexes instead of reporting a false provider-history change. Preserve human examples and stale-history checks; verify first/middle edits and refresh/reopen.

- Resolve Windows npm Codex binaries in both the current vendor/bin and legacy vendor/codex layouts, including nested platform packages and changing NVM junctions. Preserve terminal PATH selection and report genuinely missing binaries.

- Add floating Previous/Next change buttons inside native single-file and multi-file diff editors, with native hunk navigation and wrapping. Scope menus to AgentTandem comparisons and enable the proposed content menus for the local VSIX install; preserve and back up existing runtime arguments. Verify rendered menus and actual mouse clicks in an isolated VS Code renderer.

- Open changed-file links directly in the native VS Code diff editor and View changes/Cumulative in the multi-file changes editor. Preserve immutable snapshots through Accept/reload, added/deleted empty sides and complete large-file content; keep review decisions in AgentTandem.

- Discover versioned Windows Codex desktop binaries and app-server daemon releases, including custom CODEX_HOME and current junctions. Rescan refreshes versions and repaired errors while preserving names, enabled flags and selections.

- Keep Restore visible beside Edit on every user message. Disable unavailable checkpoints with an explicit explanation, show checkpoint preparation state, and enable the action as soon as the saved snapshot arrives.

- Give user messages a quiet theme-derived surface and compact, visible edit/restore actions. Add persistent before-send checkpoints for Codex and Claude, native-history message matching, branch inheritance, affected-file previews, stale/dirty/link/blob guards, interrupted-restore journalling and Undo restore. Restoring code preserves chat history and reconciles pending review.

- Isolate all native live-test provider histories with per-run CODEX_HOME/CLAUDE_CONFIG_DIR, seed login/config only and refuse shared-history legacy reopens. Exclude known old AgentTandem test run directories from parent-project conversation lists for both providers, preserving normal nested chats and literal pasted test prompts.

- Share one themed dropdown component across model, reasoning, access, CLI management, agent questions and diff selection; preserve native value/form validation with custom listbox navigation, descriptions, selected checks and viewport-aware placement.
- Show latest context tokens/capacity/cache reads for both CLIs. Estimate Claude cache expiry only from reported TTLs, retain the original measurement across sync/reopen and invalidate on model changes. Codex cache TTL remains explicitly unavailable.
- Handle Windows taskkill/exit-event races when an owned descendant exits during cleanup; still reject cleanup if the root remains alive.

- Compact the composer to a small model trigger, access selector and Send button. Open model/reasoning/provider controls in an anchored popover; support Escape, outside click, tab-out, resize, active-run locks and context changes.

- Add reasoning effort from Codex/Claude model capability metadata, persist it per project/provider/model, validate stale levels and forward the setting on start/resume/fork. Auto inherits native CLI configuration; unsupported models remain Auto.
- Align the composer as labeled Model, Reasoning and Access controls with adaptive columns, full-width model selection in narrow sidebars, and consistent locking/focus during active turns.

- Soften the flat interface with quiet theme-derived surfaces, fewer separators, rounded controls, a visible chat input and clearer spacing across conversations, review and CLI management. Preserve keyboard focus and reduced-motion/high-contrast support.
- Simplify CLI helper text, add provider logos, shorten long path displays with full-path tooltips, and adapt model/access controls and CLI selections to narrow/wide panels.

- Manage Codex and Claude CLI installations: persisted names/paths/versions, add/edit, enable/disable, remove registry entries, explicit scan and version checks, machine defaults and project selection.
- Enforce the enabled CLI registry for model discovery, provider probes and chat; preserve project selection by entry ID across path edits/restart, and block unavailable selections. Remove keeps executables on disk; subsequent scans add new installations disabled.
- Verify management, disabled model/chat blocking, recovery, selection persistence and removal with real native CLIs in VS Code; add registry/webview regression coverage and a flat responsive manager.

- Flatten the chat/composer/tool surfaces, remove bubble borders and menu shadows, and keep compact model/access controls, theme colors and keyboard focus.
- Match terminal CLI PATH order including npm launchers instead of silently selecting another installed Codex binary. Add project-scoped CLI selection in Diagnostics and show CLI path/version provenance.
- Bind model catalogs and inference to the same CLI executable/version; validate stale catalog sources. Verify terminal discovery, the current Codex catalog/model switching, Claude model switching, resume and persistence in a real Extension Host.
- Hide pure injected plugin/environment context from legacy Codex response-only history instead of attributing it to You or using it as the title. Preserve explicit human messages, quoted examples, assistant replies and tool output without rewriting transcripts.
- Align edit/resend fork boundaries with the filtered legacy history while preserving literal context blocks when native history matches explicit human prompts.
- Native access mode picker in the composer: Codex Agent/Read only/Full access and Claude Ask/Auto edits/Plan/Auto/Don't ask/Full access. Full access reaches the actual CLI sandbox/permission settings without an extra approval dialog.
- Remember access per project/provider across resume and restart, validate modes at the host, lock changes during active runs, and preserve provider rules and project-scoped change review.
- Edit and resend earlier user messages from history: edit in the composer, Cancel/Escape restores the prior draft, and Send branches from the preceding context while preserving the original conversation and current files.
- Native Codex turn-boundary forks and Claude message-boundary forks, fresh context for first-message edits, host validation/stale-history guards, persisted edit drafts, and live provider context-isolation coverage.
- Fixed all chat Stop controls, including stalled initialization/turn-start, pending approvals and hung Claude streams. Show Stopping/Saving changes, terminate the owned CLI process tree before review capture, preserve partial changes and resume the same conversation.
- Added real Windows descendant-process isolation coverage and live Codex/Claude Stop, partial review, resume and Revert checks in VS Code.
- Permission prompts now offer Always allow using Codex's proposed command rules or Claude's project-local permission updates, plus scoped per-run approval where supported.
- Remember choices show their scope, honor provider restrictions, validate host replies, and keep Allow once/Decline separate from persisted approvals.
- Replaced the placeholder Codex terminal icon with the original SVG from OpenAI's Codex extension, with light/dark/high-contrast theme support across history, messages and working feedback.
- Removed the 100 MiB review file limit: large snapshots, integrity checks and Revert stream bytes with bounded memory; unchanged large files reuse their snapshots.
- Regression coverage for a real 105 MiB src/core file, persistence, Accept/Revert and edits made during restore.
- Visible working strip for Codex/Claude with animated provider ring/dots, real tool activity, preparing/finishing/waiting states and Stop.
- Working feedback stays visible across history/changes; effects pause for user input, clear after completion/Stop/error and respect reduced motion.
- Fixed Enter/send failing in projects over 20,000 files: removed workspace file-count/total-size limits, bounded capture concurrency and reuse of unchanged/identical blobs.
- Large workspace regression covers over 20,000 real files, Git/non-Git capture, review and revert; baseline capture can be stopped.

- Applied changes pending review above the composer: file list, line counts, immutable diff, Accept/Revert per file or all.
- Persistent project review across chat turns, history refresh and VS Code restart; cumulative original baseline until accepted.
- Real workspace snapshots for both providers, partial-turn/reload recovery and guarded revert preserving later/unsaved edits.
- Real Codex/Claude edit/add/delete review tests in a disposable VS Code Extension Host.

- Editable chat composer: Enter to send, Shift+Enter for newline, per-session drafts and failed-message retry.
- New/resumed Codex app-server and Claude SDK conversations, streamed replies, tool output, Stop and permission prompts.
- Resolve unavailable ChatGPT Codex models from the app-server catalog without changing CLI configuration.

- Conversation-first layout, compact history/search and VS Code Codicons.
- Automatic current workspace root; multi-root follows the active editor without a project picker.
- Safe Markdown replies, code blocks and collapsed tool activity.

- Single sidebar panel for conversations, tool activity, inline changes and diagnostics.
- Editor tabs and native diffs open only through explicit actions.
- Distinct Claude Code/Codex icons, provider labels and session filter.

- Project conversation browser for existing local Codex and Claude Code sessions.
- Automatic transcript sync, provider isolation, project boundaries and selection persistence.
- Bundled official Claude Agent SDK session history reader; no inference required to read history.

- Named AgentTandem — Claude Code & Codex Chat, Code Review & Usage.
- Native step tree and preview panel.
- Immutable content-addressed snapshots for serialized local operations.
- Per-step and cumulative diffs, multi-file changes editor and single-file fallback.
- Added/deleted file previews, binary metadata, partial failure capture and Stop.
- Session persistence and interrupted-run recovery.
- Codex app-server handshake/model catalog check and Claude CLI availability check.
- Integration tests in the real VS Code Extension Development Host.
