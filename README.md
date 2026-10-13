<p align="center"><img src="media/icon.png" width="96" height="96" alt="AgentTandem icon"></p>

<h1 align="center">AgentTandem</h1>
<p align="center"><strong>Claude Code &amp; Codex Chat, Code Review &amp; Usage</strong></p>
<p align="center">A VS Code companion for Claude Code and Codex.<br>Track saved code changes and review them line by line, with chat, checkpoints and usage nearby.</p>

---

## Keep your workflow. Add a review layer.

**Change tracking is the core workflow.** Turn it on before your agent starts editing, then read its changes line by line in VS Code. Use Claude Code or Codex in their own tools, or chat directly in AgentTandem. Saved workspace changes appear in one review panel, grouped by conversation when the source can be verified. Open a file's inline diff, keep what works, and restore what needs another pass.

AgentTandem opens to **Review**. Chat, history and usage are always close by.

![AgentTandem review panel with conversation groups](media/screenshots/review.png)

*Product preview with demonstration data, rendered from AgentTandem's actual interface.*

## Get started: turn tracking on first

1. Install AgentTandem in VS Code **1.100 or newer**, open a local project folder, and trust the workspace.
2. Check the **bottom-right VS Code status bar** for **Tracking on**. Tracking starts automatically in trusted local workspaces unless you have paused it or disabled automatic startup.
3. If it says **Tracking off**, click it and choose **Resume tracking**. You can also run **AgentTandem: Change Tracking Controls** from the Command Palette (`Ctrl+Shift+P` on Windows/Linux, `Cmd+Shift+P` on macOS) and choose **Resume tracking**.
4. **Wait for tracking to be ready before asking your agent to edit.** AgentTandem takes the current saved files as its starting baseline; edits made before tracking starts are not reconstructed.
5. Work in your usual Codex or Claude Code tool, another editor, or AgentTandem chat. Save changes, then open AgentTandem in the Activity Bar to review them.

To install a downloaded package, use **Extensions → … → Install from VSIX…**, then select the `.vsix` file. **AgentTandem: Getting Started** opens the in-editor walkthrough.

Every edition opens the Monaco review editor by default, with syntax highlighting, full-file context and colored inline buttons. See [Choose your review editor](#choose-your-review-editor) for settings and the native diff option.

### Use Tracking on to review each change

Tracking watches saved additions, edits and deletions in the open project, including **manual edits**. You can use it without sending a message through AgentTandem.

1. After a saved change is captured, the status-bar label becomes **Review · N files**. Click it to open the latest conversation changes in the editor, or open the **Review** panel to browse all pending changes.
2. Open a changed file in the Monaco inline diff. Read the surrounding code with syntax highlighting and **Accept / Reject / Next change** actions directly above each change. Use **Previous/Next** (`Alt+↑` / `Alt+↓`) to move between changes and files.
   Use **Next file** beside the inline actions to skip straight to the next file. **Previous file / Next file** also appear in the editor-title toolbar; hover over the left/right chevrons to see their labels. Click **File x/y** in the status bar to choose any file in the current review.
3. **Accept** keeps the already-applied code and marks a block or file as reviewed. **Reject** restores the block's saved baseline; **Revert** is the corresponding file/group action. Use `Alt+Y` / `Alt+N` for the selected change; file/group Revert previews its scope before confirmation. Accept does not create a Git commit.
4. For tracking controls, use the **eye button in the Review header**, **… → Change tracking…**, or **AgentTandem: Change Tracking Controls**. When the status bar shows a pending file count, clicking it opens the diff instead of the tracking menu.

**Pause tracking** captures outstanding saved changes and keeps pending review available. Pause/resume is remembered for this workspace across reloads. Choose **Capture changes now** in the tracking controls, or run **AgentTandem: Capture External Changes Now**, to scan immediately while tracking is on.

If you see **Tracking unavailable**, open and trust a local workspace. If new changes are missing, check that tracking is on, save the file, and check whether it is ignored. Unsaved buffers and ignored files are not captured. Conversation groups require verified native edit history; other changes remain visible under **Shared** or **Unassigned**.

The setting `agentTandem.autoTrackExternalChanges` defaults to `true`. Setting it to `false` disables automatic startup for workspaces without a saved tracking choice; use **Resume tracking** to enable it explicitly. Pause tracking before restoring an AgentTandem message checkpoint.

### Set up AgentTandem chat

To chat inside the extension, install and sign in to [Claude Code](https://code.claude.com/docs/en/overview) or [Codex CLI](https://developers.openai.com/codex/cli), then run **AgentTandem: Manage CLIs** and select your installation. Open AgentTandem and select **+** to start a chat, or open **History** to find project conversations. **AgentTandem: Open Settings and Usage Dashboard** opens usage, account information and preferences.

## What you get

| Feature | What it adds to your day |
| --- | --- |
| **Review across agents** | See saved changes from AgentTandem, native CLIs and other editors in one place. Verified conversation groups keep context nearby; mixed and unknown sources stay visible as Shared and Unassigned. |
| **Readable diffs, precise decisions** | Read each file with syntax highlighting, surrounding source and colored inline buttons. Accept keeps applied code; Reject restores a change's saved baseline. Next change follows edits; Next file skips directly to another file. |
| **Checkpoints and Undo** | AgentTandem captures a checkpoint before its own chat turns. Preview a restore, return the code to that point, or undo the latest restore. |
| **One conversation workspace** | Find project conversations from Codex and Claude, resume a native session, or open chat in a sidebar or editor tab. |
| **Chat that fits real work** | Stream replies and tool activity, attach images or files, choose a model and reasoning effort, and answer approvals in the panel. |
| **A queue for your next steps** | Queue follow-up messages while an agent works. Edit, remove, pause or resume them. Pending messages survive a reload and wait for you to resume. |
| **Branch a conversation** | Edit and resend an earlier message into a new branch while keeping the original conversation in history. |
| **Usage with context** | See account/quota information, token history, cache usage and API-cost estimates. API, Local and Estimate labels explain where values come from. |
| **Local CLI management** | Discover and select native CLI installations, set project preferences and inspect provider diagnostics. |
| **Storage you can inspect** | Check snapshot usage and preview cleanup or restore-history deletion before applying it. |

## Chat with the tools you already use

![AgentTandem chat with model controls and pending changes](media/screenshots/chat.png)

*Product preview with demonstration data.*

Choose **Codex** or **Claude Code**, pick an available model, and send a message. AgentTandem uses your local, authenticated CLI and its permissions. Images can be pasted, dropped or attached; provider support determines how other files are sent.

The composer keeps model, reasoning and access controls together. Tool output stays in the conversation, pending changes stay reviewable, and scrolling up while a reply streams keeps your reading position.

### Models, permissions and attachments

- Switch between Codex and Claude Code and select models exposed by your local CLI. Adjust reasoning effort and use Codex Fast mode on supported models/accounts.
- Choose an access mode and answer tool approvals in the panel. Provider-supported remembered permissions disclose their scope before you apply them.
- Paste or drag images into the composer, or use the attachment picker. Preview and remove attachments before sending. PDFs and other file types follow each provider's capabilities.
- Stop an active turn, keep drafts separate for each conversation, or queue your next instructions. Queued messages can be edited, removed, paused and resumed; they remain paused after a reload until you resume them.

## Pick up any project conversation

![Project history with Codex and Claude conversations](media/screenshots/history.png)

Find conversations by workspace, provider or search text. AgentTandem reads native Codex and Claude history, refreshes as sessions change, and remembers your selection. Open a conversation in the sidebar or reuse an editor tab when you want more room.

**Edit and resend** branches an earlier message while preserving the original conversation. **Restore** previews a checkpoint recorded before an AgentTandem turn. Code restore and conversation branching are separate actions, so you can decide which context and which files to keep.

## Understand usage, accounts and quota

![AgentTandem dashboard showing provider account activity](media/screenshots/dashboard.png)

The dashboard separates three kinds of evidence:

| Label | What it means |
| --- | --- |
| **API** | Activity or current quota returned by the provider when supported. |
| **Local** | Token records observed on this machine, broken down by account, provider, model and date. |
| **Estimate** | API equivalent cost or observed token-to-quota trends; these are not subscription billing statements. |

Filter by date range, account, provider and model; group daily, weekly or monthly activity. Inspect input/output tokens, cache reads/writes, reasoning tokens when reported, account limits and reset times. The composer shows context usage and cache TTL, and the optional status-bar quota indicator opens the dashboard directly.

**Tokens per 1% quota** uses paired account API observations when cumulative token counters are available: token increase divided by quota percentage-point increase. The first observation saves a baseline across reloads; the ratio appears after both counters increase. API and account-matched Local measurements stay separate. Native history without account evidence is not assigned to the current login, and past quota cycles cannot be reconstructed without saved observations.

## Keep restore history under control

![AgentTandem Storage with snapshot categories and restore history](media/screenshots/storage.png)

Inspect local storage by category and conversation. Filter restore history by project and type, select the history you no longer need, then review its deletion preview. Snapshot cleanup targets unreferenced data older than 24 hours and protects pending review, active captures, checkpoints and Undo.

**Manage CLIs** keeps installations separate from the project: choose enabled native executables, set provider defaults or project overrides, scan for installations, and inspect diagnostics. The Getting Started walkthrough links tracking, review, CLI setup and usage in one place.

*Screenshots use demonstration files, conversations, accounts and usage values rendered by the actual AgentTandem interface and VS Code Development Host.*

## A review loop that stays close to your code

![AgentTandem Monaco diff with syntax highlighting, colored inline buttons and file navigation](media/screenshots/editor-diff.png)

*Actual VS Code Development Host capture using demonstration files and a Marketplace-compatible manifest. The Monaco diff shows syntax highlighting, compact green Accept and red Reject actions above each edit, plus separate change and file navigation.*

![AgentTandem image diff showing saved Before and After artwork with whole-file Accept and Reject actions](media/screenshots/image-diff.png)

Images show the saved **Before / After** versions side by side. Added or deleted images have an explicit empty side. **Accept file / Reject file** review the whole image, and file navigation moves between images and code. Image comparisons also work for recorded steps and cumulative changes.

![AgentTandem review with the agent change list and a shortcut to its conversation](media/screenshots/agent-changes.png)

Use **Agent changes** in the review header to open every pending file from the selected conversation. Select a file to keep reviewing within that group, or choose **Open conversation** to return to its chat in AgentTandem. Shared and unassigned edits stay separate from individual conversations.

1. **Work.** Continue in your native agent, or send a turn through AgentTandem.
2. **Inspect.** Open a changed file in the Monaco inline diff. Read its highlighted source and review one change, one file or the entire group.
3. **Decide.** Accept keeps the current code and marks it reviewed. Revert previews file/group scope and checks for newer edits before restoring snapshots.
4. **Continue.** Keep the context, branch an earlier message, or restore an AgentTandem checkpoint for another attempt.

| Shortcut | Action |
| --- | --- |
| `Alt+↓` / `Alt+↑` | Next / previous change in an AgentTandem diff |
| `Alt+PageDown` / `Alt+PageUp` | Next / previous file, skipping remaining changes in the current file |
| `Alt+Y` | Accept the block under the cursor (selected change in Webview mode) |
| `Alt+N` | Reject the block under the cursor (selected change in Webview mode) |
| `Enter` / `Shift+Enter` | Send a chat message / add a newline |

## Choose your review editor

**Local and Marketplace editions default to the Monaco review editor.** Open a pending file from Review, chat or the status bar to read its saved before/after snapshots. The full file has syntax highlighting, line numbers, red/green diff backgrounds, text selection and **Ctrl+F** search. Compact green **Accept** and red **Reject** actions sit directly above each pending edit, separated from the neutral **Next change** and **Next file** controls.

**Next change** (`Alt+Down`, previous: `Alt+Up`) visits individual edits and continues across files. **Next file** (`Alt+PageDown`, previous: `Alt+PageUp`) skips the remaining edits in the current file. Use the filename dropdown to jump directly to a file. Navigation retains the current conversation/group scope and wraps at the ends.

If you previously selected native review, choose **Webview** in AgentTandem settings, or merge this into your settings:

```json
{
  "agentTandem.reviewEditor": "webview"
}
```

Monaco is bundled inside the extension and works offline. It highlights supported languages such as TypeScript, JavaScript, Python, Dart, Rust, HTML, CSS and JSON. It follows VS Code's light/dark/high-contrast mode and editor font; syntax colors come from Monaco's built-in themes. It does not inherit installed VS Code language extensions or their semantic highlighting. Unknown languages remain readable as plain text. Source snapshots are read-only; edit the workspace file in your normal editor.

The **Native diff** button opens the same snapshots in VS Code's editor. Set `agentTandem.reviewEditor` to `native` to use that editor by default. Native Accept/Reject actions remain CodeLens, styled by VS Code; `agentTandem.blockActionsStyle` controls those actions. Both review modes use the same snapshot decisions, scope checks and Undo. AgentTandem does not override the shared CodeLens font size.

Image snapshots up to 16 MiB per side are previewed when the browser supports their format, including PNG, JPEG, GIF, WebP and SVG. A missing, oversized or unreadable side shows an explanation while the other version remains visible. Other binary files, combined text snapshots over 4 MiB and timed-out snapshot diffs offer file-level decisions and a Native diff action. Monaco virtualizes visible lines while retaining the complete source model for scrolling and searching.

## Know what is captured

- Review tracks **saved files in the open project**. Ignored files are excluded. Unsaved buffers and newer edits are checked before a restore or revert.
- A checkpoint belongs to a turn started in **AgentTandem**. Older native transcripts do not acquire historical snapshots just by appearing in History.
- **Accept** marks already-applied code as reviewed; it does not create a Git commit. **Edit and resend** branches conversation context and keeps the current code.
- Native history discovery reads local provider records. Snapshot, queue and preference data are stored locally. Prompts and attachments sent through chat are handled by the selected provider through its CLI.
- Account, quota, Fast mode, models and attachment support depend on the selected provider, CLI version and account. API-cost estimates are separate from subscription quota.
- Agent execution requires a **trusted local workspace**. Virtual workspaces have limited support. Opening native review selects inline diff layout, which also affects the workspace's other diff editors.

AgentTandem is an independent companion. It is not affiliated with OpenAI or Anthropic. Provider names and marks identify the tools it connects to.

## Contributing

Help improve AgentTandem's review workflow, provider integrations and VS Code experience. See the [contributor guide](CONTRIBUTING.md) for project structure, local development, testing and pull request expectations.

Start a local development session with **Node.js 24**:

```powershell
npm ci
npm run build
```

Open this folder in VS Code and press **F5** with **Run AgentTandem**. In the Development Host, open a separate test project and use **AgentTandem: Open Conversations**.

Before opening a pull request, run:

```powershell
npm run typecheck
npm test -- --maxWorkers=2 --testTimeout=15000
```

- Include a focused regression test for behavior changes and screenshots for visible UI changes.
- Explain the problem, the resulting behavior and the checks you ran in the pull request.
- Keep provider transcripts, credentials, personal usage records and generated test workspaces out of commits and screenshots.

- [Contributor guide](CONTRIBUTING.md)
- [Development, advanced behavior and verification](docs/DEVELOPMENT.md)
- [Release notes](CHANGELOG.md)
