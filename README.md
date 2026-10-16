<p align="center"><img src="media/icon.png" width="96" height="96" alt="AgentTandem icon"></p>

<h1 align="center">AgentTandem</h1>
<p align="center">Chat with Claude Code and Codex, review saved changes, manage accounts and track tokens — inside VS Code.</p>

Keep working in your native agent or use the built-in chat. AgentTandem brings saved file changes, conversation history, account switching and usage into one workspace companion.

| Feature | What you can do |
| --- | --- |
| Code and image review | Compare saved snapshots, accept or reject individual blocks, navigate files and undo the latest revert. |
| Chat and history | Run Codex or Claude Code, resume project conversations, attach files and queue follow-ups. |
| Account management | Save and switch Codex, Claude Code, Cursor and Antigravity sign-ins. |
| Token dashboard | Explore account, model and conversation totals, cache usage and estimated API costs. |
| Live quota | See remaining allowance, reset times, observed burn rate and quota estimates. |
| Checkpoints and storage | Preview code restores and choose which saved restore history to keep. |

## Get started

1. Install **AgentTandem** in VS Code and open your project. For chat, install and sign in to the Codex or Claude Code CLI you want to use.
2. Select **AgentTandem** in the Activity Bar. Check **Tracking on** in the status bar before asking an agent to edit. If tracking is off, click it, choose **Resume tracking** and wait until it is ready.
3. Work in your usual agent tool, or select **+** to start a built-in chat. **Manage CLIs** lets you choose an installed CLI.
4. Save your changes, open **Review** and select a file. **Accept** keeps the code and marks it reviewed; **Reject / Revert** restores the saved baseline. Accept does not create a Git commit.

Tracking captures saved, non-ignored files, including manual edits. It cannot reconstruct changes made before tracking starts. Running agents requires a trusted workspace and an authenticated CLI.

## Review code and images

Review opens with changed files grouped by conversation. Shared and unassigned changes stay visible when their source cannot be established. Select a file to compare immutable before/after snapshots in the bundled Monaco editor, with syntax highlighting, search and inline actions.

- **Accept / Reject** acts on an individual change block; **Accept all** keeps all changes in the current file.
- **Previous / Next change** and **Previous / Next file** move through the review. Use the file picker to jump directly to another file.
- File and conversation **Revert** actions preview their scope. **Undo** recovers the latest file, group or block revert.
- **…** contains Refresh, Native diff and conversation details. Images show saved **Before / After** versions with whole-file actions.

![Review panel grouping saved changes by Codex and Claude conversations, with shared and unassigned files](media/screenshots/review.png)

![Monaco code review with syntax highlighting, inline Accept and Reject actions and file navigation](media/screenshots/editor-diff.png)

![Saved Before and After image comparison with whole-file review actions](media/screenshots/image-diff.png)

## Manage accounts

Run **AgentTandem: Manage Accounts**, or open **Settings → Accounts**. Filter by app and search saved profiles for **Codex, Claude Code, Cursor and Antigravity**.

1. Select **Add account** and choose an app. For Codex or Claude Code, sign in through the native CLI, **Save current sign-in**, or **Import JSON**. For Cursor or Antigravity, open the installed app, sign in there and save its current sign-in.
2. Select **Switch account** to update the default CLI or IDE sign-in. Finish active agent turns first; close Cursor/Antigravity windows before switching and reopen the app afterward.
3. Follow the progress dialog and timestamped log. **Hide** keeps the operation running; **View switch log** reopens the latest result. The switch saves the outgoing sign-in, verifies the selected identity and attempts rollback if verification fails.

![Account manager with app filters, search and fictional Codex, Claude Code, Cursor and Antigravity profiles](media/screenshots/accounts.png)

Click a provider's quota in the VS Code status bar for **quick account switching**, remaining quota and reset details. **Open dashboard** and **Manage accounts** are separate shortcuts. In the dashboard, **View usage** selects an account's statistics without switching its sign-in.

Saved credentials stay in local native-auth profile storage and are not sent to the webview or included in switch logs. Removing a saved profile keeps the default native sign-in and conversation history. Cursor/Antigravity quota stays in the native app; Antigravity 2 OS-vault switching currently supports Windows.

<details>
<summary>Account switch progress</summary>

![Account switch dialog with timestamped steps for a fictional Codex Work profile](media/screenshots/account-switch.png)

</details>

## Token and usage dashboard

Run **AgentTandem: Open Settings and Usage Dashboard**, or use **Dashboard** below chat. The dashboard opens on **By account** and **Today**. Choose **View usage** on an account card, or select **All accounts** for combined local Codex and Claude totals across projects.

![Dashboard account overview with local token totals, saved profiles and live quota](media/screenshots/dashboard.png)

**View usage** opens that account's own dashboard: its API activity, Local totals, cost, chart, quota, burn-down and estimates. Select **← All accounts** to return to the account overview.

![Account detail for a fictional Codex Personal profile with the All accounts back button, API activity, local totals and quota](media/screenshots/account-detail.png)

Filter by **provider, account, model and date range**, including custom dates. Group activity by **day, week or month**. Inspect input, output, cache reads/writes, requests, provider/model breakdowns and daily activity.

| Source | What it shows |
| --- | --- |
| **API** | Native account quota and, when supported, Codex account token activity: lifetime tokens, peak day, turn duration, streaks and returned daily totals. |
| **Local** | Deduplicated token counts recorded in local Codex and Claude history across projects, including archived and subagent sessions. |
| **Estimate** | API-equivalent USD cost, tokens per 1% quota and projected reset-cycle capacity. These are estimates, not subscription charges or invoices. |

### Token dashboard

**All accounts** shows API token activity (lifetime tokens, peak day, longest turn and streaks), Local input/output/cache totals, the API-equivalent cost split, token activity stacked by model and current account quota.

![Token dashboard with separate API activity, local input/output/cache totals, model activity and account quota](media/screenshots/token-dashboard.png)

**API activity and Local totals are displayed separately and never added together.** Codex API activity depends on CLI/account support; Claude token details come from local history. Model filters apply to Local usage. Missing API metrics remain unavailable, and unknown model prices remain **Unpriced**.

Account attribution preserves native per-turn evidence. Older Codex history may be labeled **Inferred from session creator**; unmatched history stays **Unknown account**. **Assign history to an account** lets you confirm a conversation/date range or keep it unknown without rewriting native transcripts.

### Quota burn-down

Each quota window (Codex/Claude Code × 5h/7d) gets a card plotting **remaining quota** in the current reset cycle against an **even pace** to reset, plus a **projection** from the recent burn rate. The card says whether the window is **On track** (and how much will be left at reset) or **Runs out ≈ time · before reset**, with even-pace, per-cycle and last-hour rates.

![Quota burn-down cards for Codex and Claude Code 5h and 7d windows with remaining, even-pace and projection lines](media/screenshots/quota-burn-down.png)

### Tokens per 1% quota

Each provider takes a full-width row with its 5h and Weekly windows side by side. Estimates show how many tokens one percent of each quota window buys, the tokens left in the current cycle and the change against earlier cycles. **Tokens per reset cycle** lists recorded tokens, the full-cycle estimate at 100% and the change from the previous cycle. API, Local and Device estimates are kept separate. Other devices, model mix and incomplete history can affect these estimates. Local totals cover recorded history on this machine; they cannot include deleted or unlogged usage elsewhere.

![Tokens per 1% quota estimates per account and window with per-reset-cycle tables](media/screenshots/tokens-per-quota.png)

### Conversations and breakdowns

Search **Conversations** by title or project and select a row for its tokens, input/cache, output, API cost, quota-window equivalents, per-model split and daily totals. **Assign this conversation** opens history assignment for it.

![Conversation table with an opened conversation showing token totals, model split and daily usage](media/screenshots/conversations.png)

**Daily breakdown by model** groups usage by the selected period with a model-mix bar; expand a period to see each model. **Usage by account** totals Local tokens per account and shows how each row was attributed.

![Daily breakdown by model with model-mix bars and usage by account with attribution](media/screenshots/usage-breakdown.png)

Refreshing reads quota and usage without sending an inference prompt. An open dashboard refreshes every minute and reuses a token-only history cache.

## Chat, history and checkpoints

Select **+**, choose **Codex** or **Claude Code**, then choose a model and access mode. Models come from the selected installed CLI. Reasoning effort appears where supported; Codex also offers a per-project **Fast mode** toggle.

- Stream replies and tool activity, respond to approvals and stop an active turn from the panel.
- Paste images, drag files into the composer or use the paperclip. Preview and remove attachments before sending; attachment-only messages are supported.
- Queue follow-ups while the agent works. Edit, delete, pause or resume the queue; saved queues require Resume after reloading.
- Open **History** to search and resume project conversations from either provider. **Edit and resend** branches an earlier message while preserving the original conversation and current files.
- **Restore code** previews a checkpoint saved before a turn started in AgentTandem. **Undo restore** recovers the code from before the latest restore. External CLI messages and older history may have no checkpoint.

![Built-in chat with model and access controls, context usage and pending file changes](media/screenshots/chat.png)

<details>
<summary>Project history and review shortcuts</summary>

![Project conversation history with Codex and Claude Code sessions](media/screenshots/history.png)

![Code review with its changed-file list and shortcut to the source conversation](media/screenshots/agent-changes.png)

</details>

## Status bar and preferences

Open **Settings → Preferences** to show both agents, the selected chat agent, Codex only or Claude Code only. Choose compact icons with quota, progress bars, quota rings, minimal columns (one column per window plus the lowest percentage), icons only or full text; select quota windows, reset countdowns, banked resets, account/plan details and left/right placement. Codex and Claude Code each take their own text color: keep the quota status color, pick a theme color (follows your color theme) or a custom color; low quota still shows its warning colors. With remaining quota shown, each reset countdown sits right after its window behind a clock icon (`5h 75% 🕑2h14m · 7d 40% 🕑3d4h`; minimal shows only the tightest window's reset); the full-text style keeps `5h reset 2h 14m`. Hover retains full details in every style. `↻ 3` means three banked resets.

<details>
<summary>Status bar preferences</summary>

![Status bar preferences with provider, appearance, quota-window and visible-detail controls](media/screenshots/preferences.png)

</details>

## Storage and restore history

Open **Settings → Storage** to inspect the extension data folder and storage categories. Filter saved restore history by project/type, select entries and **Review deletion** before removing them.

**Preview cleanup** lists unused snapshots and blobs older than 10 minutes. **Clean up…** lets you choose what to clean — message checkpoints, restore backups and/or unused snapshots — previews exactly those, then deletes them from the same preview. Cleanup rechecks references before deleting; tracking baselines, pending review, active captures, retained checkpoints and Undo remain protected. Workspace files and native Codex/Claude conversation history stay intact. Deleting selected restore history removes the ability to restore those checkpoints.

<details>
<summary>Storage manager</summary>

![Storage categories and saved restore history with selection and deletion preview controls](media/screenshots/storage.png)

</details>

## WSL and remote workspaces

Install AgentTandem in the **WSL/SSH workspace** so it can access that environment's files and signed-in CLIs. After switching from a local development VSIX to the Marketplace extension, uninstall `agent-tandem-local.agent-tandem` in that environment and run **Developer: Reload Window**. Keep one AgentTandem extension enabled: both builds share commands and views. Uninstalling the extension keeps its saved data.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Enter` / `Shift+Enter` | Send a chat message or queue a follow-up / insert a newline |
| `Alt+Y` / `Alt+N` | Accept / reject the current change in an active review editor |
| `Alt+Up` / `Alt+Down` | Previous / next change |
| `Alt+PageUp` / `Alt+PageDown` | Previous / next changed file |

*Screenshots capture the current interface with demonstration data. Account names, emails, token counts, quota values and switch logs are fictional.*

See [Contributing](CONTRIBUTING.md), [Development](docs/DEVELOPMENT.md) and [Release notes](CHANGELOG.md).

AgentTandem is an independent companion, not affiliated with OpenAI or Anthropic.
