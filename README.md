<p align="center"><img src="media/icon.png" width="96" height="96" alt="AgentTandem icon"></p>

<h1 align="center">AgentTandem</h1>
<p align="center">Review code changes, chat with Claude Code and Codex, and track usage inside VS Code.</p>

## How to use

1. Open your project and select **AgentTandem** in the Activity Bar.
2. Check **Tracking on** in the status bar before asking your agent to edit. If it is off, click it, choose **Resume tracking**, and wait until tracking is ready.
3. Work in your usual agent tool or AgentTandem chat, then save your changes.
4. Open **Review**, select a changed file, and inspect its diff. **Accept** keeps the code and marks it reviewed; **Reject / Revert** restores the saved baseline. Accept does not create a Git commit.

Tracking captures saved, non-ignored files, including manual edits. It cannot reconstruct changes made before tracking starts. Checkpoints are recorded for turns started in AgentTandem.

## Review changes

Select a conversation group to browse its changed files. Use **Next change** to review each edit or **Next file** to move on. Images show saved **Before / After** versions with whole-file actions.

![AgentTandem review panel with conversation groups](media/screenshots/review.png)

![AgentTandem Monaco diff with syntax highlighting, colored inline buttons and file navigation](media/screenshots/editor-diff.png)

![AgentTandem image diff showing saved Before and After artwork with whole-file Accept and Reject actions](media/screenshots/image-diff.png)

![AgentTandem review with the agent change list and a shortcut to its conversation](media/screenshots/agent-changes.png)

## Chat and history

Select **+**, choose **Codex** or **Claude Code** and a model, then send a message. Attach files or queue follow-ups while the agent works. Use **Manage CLIs** to select your local, signed-in CLI.

Open **History** to find and resume project conversations. **Edit and resend** branches an earlier message; **Restore** previews a saved AgentTandem checkpoint.

![AgentTandem chat with model controls and pending changes](media/screenshots/chat.png)

![Project history with Codex and Claude conversations](media/screenshots/history.png)

## Usage and storage

Run **AgentTandem: Open Settings and Usage Dashboard** to view quota, token history and API-cost estimates. Filter by date, account, provider or model. Estimates are separate from subscription billing.

Open **Storage** to inspect snapshots, select restore history and preview cleanup before deleting it.

![AgentTandem dashboard showing provider account activity](media/screenshots/dashboard.png)

![AgentTandem Storage with snapshot categories and restore history](media/screenshots/storage.png)

*Screenshots show the actual interface with demonstration data.*

See [Contributing](CONTRIBUTING.md), [Development](docs/DEVELOPMENT.md) and [Release notes](CHANGELOG.md).

AgentTandem is an independent companion, not affiliated with OpenAI or Anthropic.
