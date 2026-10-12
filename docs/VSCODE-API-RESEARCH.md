# VS Code API research for per-step change viewing

Checked: 2026-10-07.

UI requirement update: the default interface is **one AgentTandem sidebar WebviewView**, containing conversations, tool output and inline diffs. `vscode.diff`/`vscode.changes` are used only after Open diff in editor; WebviewPanel is created only by Open in tab. This document investigates editor APIs, without requiring editor tabs on step selection. [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)

**Clicking individual steps to inspect code changes can be implemented with public VS Code APIs.** VS Code provides diff editors and virtual documents; AgentTandem must supply the file versions for each step. This requires intermediate run snapshots rather than only before/after message snapshots as originally planned.

These conclusions come from official documentation and Microsoft source, not a running prototype. The `main` branch establishes public/proposed status; minimum supported versions and runtime behavior require testing on supported Desktop builds.

## What is a step?

Distinguish three levels:

| Level | Example | Separate changes? |
| --- | --- | --- |
| Turn | A request to fix the login screen | Cumulative whole-turn diff |
| Execution step | One Edit/Write/apply_patch or command | A diff if files change |
| Plan step | “Fix validation”, “Add tests” | May contain several execution steps; plan text does not establish file boundaries |

The MVP uses execution steps as change boundaries. Read/search/test steps without edits still show activity/output and no-change status. Not every streaming message becomes a checkpoint.

## Suitable APIs

| Need | API or command | AgentTandem use |
| --- | --- | --- |
| One file at a step | `commands.executeCommand('vscode.diff', left, right, title, options)` | Two immutable before/after URIs |
| All step files | `commands.executeCommand('vscode.changes', title, resourceList)` | Changes editor for the selected file set |
| Read-only historical text | `workspace.registerTextDocumentContentProvider` | Snapshot scheme backed by stored blobs |
| Update virtual documents | `TextDocumentContentProvider.onDidChange` | Separate live previews; history stays immutable |
| Byte-based snapshot files | Read-only `workspace.registerFileSystemProvider` | Optional binary/snapshot-tree support |
| Native turn/step/file lists | `window.createTreeView`, `TreeDataProvider`, `TreeItem.command` | Optional supplementary review view |
| Click a chat step | Webview message passing, `onDidReceiveMessage` | Host accepts step IDs and opens diffs |
| Gutter/inline diffs | `scm.createSourceControl`, `SourceControl.quickDiffProvider` | Optional open-editor baseline comparison |
| Disk/buffer changes | `workspace.createFileSystemWatcher`, `workspace.onDidChangeTextDocument` | Change detection, not step history |
| Editor edits | `WorkspaceEdit`, `workspace.applyEdit` | Edit operations, not journal/checkpoint replacements |

`vscode.diff` and `vscode.changes` are documented built-in commands. [VS Code built-in commands](https://code.visualstudio.com/api/references/commands)

Content providers create read-only text documents at custom URIs; filesystem providers support varied content. They enable snapshots without checkout or main-workspace modifications. [Virtual Documents](https://code.visualstudio.com/api/extension-guides/virtual-documents)

Tree Views support providers/item commands. Custom chats send intents over host bridges, without embedding editor diffs in webviews. [Tree View API](https://code.visualstudio.com/api/extension-guides/tree-view), [Webview API](https://code.visualstudio.com/api/extension-guides/webview)

SCM Quick Diff supplies original URIs for gutter/inline comparisons. It fits one baseline for an open resource; multi-step history should still compare separate snapshots. [Source Control API](https://code.visualstudio.com/api/extension-guides/scm-provider)

Watchers, buffer events and WorkspaceEdit are public. Events do not identify the responsible tool; applyEdit provides neither provider history nor shell undo. [Public VS Code API declarations](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts)

## APIs unsuitable as the MVP foundation

### Explorer Timeline

`TimelineProvider` and `workspace.registerTimelineProvider` currently reside in `vscode.proposed.timeline.d.ts`, not the inspected public `vscode.d.ts`. The MVP therefore renders its own chat/Tree View timeline. [Timeline API proposal](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.timeline.d.ts), [Public declarations](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts)

VS Code documents proposed API usage and Marketplace distribution restrictions; historical diffs need not depend on them. [Using Proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)

### Built-in chat checkpoints and review

Built-in chat supports file review, checkpoint restore and forks in supported sessions. Product functionality does not imply public APIs for third-party arbitrary checkpoint histories. [Review and revert agent changes](https://code.visualstudio.com/docs/agents/run/review-code-edits)

The public Chat Participant API streams responses and command buttons, so a future native-chat integration could add View Changes. However, inspected editing APIs such as `ChatResponseStream.textEdit`, `workspaceEdit`, `externalEdit` are in `chatParticipantAdditions`. The MVP retains custom chat to own sessions/checkpoints. [Chat Participant API](https://code.visualstudio.com/api/extension-guides/ai/chat), [Chat participant additions proposal](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.chatParticipantAdditions.d.ts)

Do not rely on `_`-prefixed internal commands, Copilot internals or built-in Keep/Undo automatically managing AgentTandem transactions. AgentTandem Apply/Discard/Revert invokes its own engine.

## Clicking steps to inspect changes

Example login-editing turn:

```text
Message: Fix login validation
  Step 1  Read Login.tsx                      No changes
  Step 2  Edit Login.tsx                      1 file     View Changes
  Step 3  Add validation.test.ts              1 file     View Changes
  Step 4  Run tests                           Output     No changes
  Whole turn                                 2 files    Review All
```

1. At a writing step's start, capture the before state when a reliable barrier exists.
2. After operation completion and competing-writer shutdown, capture after state, create a step ChangeSet and update chat.
3. Step 2's View Changes compares its own before/after; step 3 opens its distinct file set.
4. A file opens a single diff; View All opens a multi-file changes editor.
5. Offer cumulative comparisons from turn start with labels distinguishing individual step changes.
6. Agents may keep running; opened diffs retain selected snapshots instead of switching to latest results.

View Changes activates once step data is fixed, without waiting for the whole turn. Apply/Discard/Revert still waits for turn/writer completion under MVP policy. Viewing steps never changes active conversation, applies patches or restores worktrees.

History URIs include session, step, side and snapshot IDs; paths retain file extensions for language detection. Blobs remain available while editors use them or references are pinned; reviewing a step is not grounds for deleting its snapshot.

## API example

This illustrates snapshot/editor wiring, not a working implementation. AgentTandem must implement `history` to resolve validated IDs to historical URIs/content rather than current worktree files.

```typescript
import * as vscode from 'vscode';

// During activation, retain the Disposable in context.subscriptions.
const snapshots = vscode.workspace.registerTextDocumentContentProvider(
  'agenttandem-snapshot',
  {
    provideTextDocumentContent(uri, token) {
      return history.readText(uri, token);
    },
  },
);

async function showStepFile(stepId: string, fileId: string) {
  const pair = await history.resolveFilePair(stepId, fileId);
  await vscode.commands.executeCommand(
    'vscode.diff',
    pair.beforeUri,
    pair.afterUri,
    pair.title,
    { preview: true, preserveFocus: false },
  );
}

async function showStepFiles(stepId: string) {
  const step = await history.resolveStep(stepId);
  const entries: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] =
    step.files.map(file => [file.labelUri, file.beforeUri, file.afterUri]);
  await vscode.commands.executeCommand('vscode.changes', step.title, entries);
}
```

Microsoft source confirms each `vscode.changes` entry is a three-part tuple: label, before and after URIs; missing sides represent additions/deletions. Test these on the minimum version. If the changes editor is insufficient, file-list/`vscode.diff` fallback preserves per-step viewing. [Command argument implementation](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHostApiCommands.ts)

Single-file additions/deletions can use empty text snapshots on absent sides. Binary files bypass text providers: test read-only filesystem/editor previews or display metadata when comparison is unsupported.

## Capturing provider step changes

VS Code does not know tool boundaries inside Claude/Codex processes. AgentTandem must connect provider events with recorders; filesystem watchers alone cannot prove individual-step provenance.

### Claude

Agent SDK offers `PreToolUse`, `PostToolUse`, failure events and tool-use IDs. Hooks are awaited by default. Capture checkpoints through awaited callbacks, not background asynchronous output. Test file tools, Bash and failures against the pinned version. [Claude Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)

### Codex

App-server provides item lifecycles and cumulative turn diffs. `turn/diff/updated` is not an individual-step delta, and notifications do not lock filesystems. Use item IDs for UI, without treating notification delivery as a write barrier. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

Codex `PreToolUse`/`PostToolUse` hooks cover local tool paths such as Bash/apply_patch and are awaited by default, but exceptions exist and unified exec may finish on a later poll. Unmanaged hooks need defined review/trust. Investigate Windows app-server configuration and recorder handshakes before promising exact snapshots for every tool. [Codex hooks](https://learn.chatgpt.com/docs/hooks)

Do not change trust state or bypass trust during setup. Skipped/timed-out hooks must make exact step capture unavailable for that run.

## Accuracy and concurrency

Turns can include concurrent tools/background commands. Recorders need two evidence levels:

| Level | Conditions | Presentation |
| --- | --- | --- |
| Exact | Before/after barriers, serialized/controlled writers and immutable content | Individual step changes |
| Grouped | Overlapping writers or reliable boundaries only for a group | Group changes with explicit scope |

Prefer serializing write-capable operations in the MVP. Shell/MCP tools with unknown semantics cannot be assumed read-only. Unknown shell targets require scoped before/after manifests rather than event file names alone.

Without provider barriers, retain provider diffs with their provenance or verified group changes. Never attach late snapshots to one tool as Exact. Cumulative text diffs cannot reconstruct complete historical files without before versions.

Tests/builds can write files; tool names alone do not prove no changes. Background commands keep steps pending/grouped until writers stop. Failed steps with partial edits still need viewable diffs with explicit evidence scope.

This requires prototyping; VS Code diff-opening APIs are not the missing part.

## Plan updates

1. Include execution timelines and per-step View Changes in the MVP.
2. Add Step, step ChangeSet and intermediate snapshot boundaries to the model.
3. Use read-only content providers + `vscode.diff`, trial multi-file `vscode.changes` with fallback.
4. Label individual/cumulative step diffs distinctly.
5. Permit history viewing during execution while writes await turn completion.
6. Avoid proposed Timeline and built-in chat editing/checkpoint internals.
7. Require proof that two edits of one file reopen correct versions, with clear grouped-only disclosure.

## First prototype

Build a provider-independent API prototype with three versions of one file. Step A opens 0 → 1, B opens 1 → 2, and A remains correct after B. Test additions/deletions, multi-file editors, reload and read-only snapshots.

Then test both real providers with two same-file edits and one shell edit. Verify barriers, hook trust/timeouts, delayed events and concurrency. Record versions, working APIs and exact/grouped capability in the integration report. Full chat UI is unnecessary to prove these points.
