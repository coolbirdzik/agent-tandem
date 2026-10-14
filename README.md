<p align="center"><img src="media/icon.png" width="96" height="96" alt="AgentTandem icon"></p>

<h1 align="center">AgentTandem</h1>
<p align="center">Review code changes, chat with Claude Code and Codex, and track usage inside VS Code.</p>

## How to use

1. Open your project and select **AgentTandem** in the Activity Bar.
2. Check **Tracking on** in the status bar before asking your agent to edit. If it is off, click it, choose **Resume tracking**, and wait until tracking is ready.
3. Work in your usual agent tool or AgentTandem chat, then save your changes.
4. Open **Review**, select a changed file, and inspect its diff. **Accept** keeps the code and marks it reviewed; **Reject / Revert** restores the saved baseline. Accept does not create a Git commit.

Tracking captures saved, non-ignored files, including manual edits. It cannot reconstruct changes made before tracking starts. Checkpoints are recorded for turns started in AgentTandem.

### WSL and remote workspaces

Install AgentTandem in the WSL/SSH workspace so it can access that environment's files and signed-in Codex/Claude CLIs. After switching from a local development VSIX to the Marketplace extension, uninstall `agent-tandem-local.agent-tandem` in that environment and run **Developer: Reload Window**. Keep one AgentTandem extension enabled: both builds share commands and views. Uninstalling the extension keeps its saved data.

## Review changes

Select a conversation group to browse its changed files. Use the arrows for changes/files and **Accept all** for the current file. **…** holds Refresh, Native diff and conversation details. Images show saved **Before / After** versions with whole-file actions.

![AgentTandem review panel with conversation groups](media/screenshots/review.png)

![AgentTandem Monaco diff with syntax highlighting, colored inline buttons and file navigation](media/screenshots/editor-diff.png)

![AgentTandem image diff showing saved Before and After artwork with whole-file Accept and Reject actions](media/screenshots/image-diff.png)

![AgentTandem review with the agent change list and a shortcut to its conversation](media/screenshots/agent-changes.png)

## Chat and history

Select **+**, choose **Codex** or **Claude Code** and a model, then send a message. Attach files or queue follow-ups while the agent works. Use **Manage CLIs** to select your local, signed-in CLI.

Open **History** to find and resume project conversations. **Edit and resend** branches an earlier message; **Restore** previews a saved AgentTandem checkpoint.

![AgentTandem chat with model controls and pending changes](media/screenshots/chat.png)

![Project history with Codex and Claude conversations](media/screenshots/history.png)

## Manage accounts

Open **AgentTandem: Manage Accounts** for **Codex, Claude Code, Cursor or Antigravity**.

For a quick switch, click quota in the status bar. The popup lists accounts with remaining quota; select an account to switch and follow its progress there. **Open dashboard** and **Manage accounts** are separate menu items.

1. Select **Add account**, choose an app, then sign in or **Save current sign-in**. You can also **Import JSON**.
2. Filter by app or search your saved accounts. Select **Switch account** to change the default CLI/IDE sign-in; finish active turns and close IDE windows first.
3. Follow the switch modal's loading status and timestamped log. **Hide** keeps the switch running; **View switch log** reopens its result. Reopen the IDE after switching.

![Account management with app filters, search and saved Codex, Claude Code, Cursor and Antigravity profiles using fictional accounts](media/screenshots/accounts.png)

![Account switch progress modal with timestamped steps using a fictional Codex Work profile](media/screenshots/account-switch.png)

Cursor/Antigravity quota stays in their app.

## Usage and storage

Open **Settings → Preferences → Status bar** to choose both agents, the selected chat agent, Codex or Claude Code. Choose which quota, reset countdown, banked resets, account and plan details to show, all quota windows or the first two, and the left or right side. The preview uses your current account data; hover always keeps full quota and reset details.

**Appearance** offers compact icons with quota (default), icons only, or full text. Codex uses a terminal icon and Claude Code a sparkle; `↻ 3` means three banked resets. Icons-only mode keeps agent names and full details in hover and screen-reader labels.

Run **AgentTandem: Open Settings and Usage Dashboard** to view usage **By account**. Select **View usage** for account details or **All accounts** for combined totals. Filter by date, provider or model. Estimates are separate from subscription billing.

Select a **Conversation** to inspect its tokens, cache, models and cost. **Quota burn** shows observed % per hour and projected exhaustion.

Open **Storage** to inspect snapshots, select restore history and preview cleanup before deleting it.

![AgentTandem dashboard showing provider account activity](media/screenshots/dashboard.png)

![AgentTandem Storage with snapshot categories and restore history](media/screenshots/storage.png)

*Screenshots show the actual interface with demonstration data. Account names, emails and switch logs are fictional.*

See [Contributing](CONTRIBUTING.md), [Development](docs/DEVELOPMENT.md) and [Release notes](CHANGELOG.md).

AgentTandem is an independent companion, not affiliated with OpenAI or Anthropic.
