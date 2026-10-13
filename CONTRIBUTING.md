# Contributing to AgentTandem

AgentTandem brings native agent conversations, code review and usage information into VS Code. Contributions can improve provider compatibility, review reliability, accessibility, interface behavior, documentation and tests.

## Set up the project

Use Node.js 24, npm, Git and VS Code 1.100 or newer. Windows is the primary development environment; the extension host tests run on Windows in CI.

```powershell
npm ci
npm run build
```

Open the repository in VS Code and press **F5** using **Run AgentTandem**. The launch configuration builds the project and opens an Extension Development Host. Open a separate test project there, then run **AgentTandem: Open Conversations**.

Install and authenticate a native Codex or Claude CLI only when working on live provider behavior. Review fixtures and local history tests can run without inference. Live provider tests require the appropriate CLI/account and can consume provider allowance.

For changes you want to test in your existing VS Code installation, `npm run dev` builds, packages and force-installs the local extension. It uses the default profile and enables AgentTandem's proposed APIs in runtime arguments, with a backup. Use **Developer: Reload Window** after updates; fully restart VS Code when enabling proposals for the first time. `npm run dev:watch` repeats the process on source changes.

## Find the relevant code

| Path | Responsibility |
| --- | --- |
| `src/extension.ts` | Extension activation, commands, workspace state and provider coordination |
| `src/core/` | Snapshots, review decisions, checkpoints, queues, storage and usage records |
| `src/providers/` | Native CLI processes, conversation discovery, models, permissions and account evidence |
| `src/host/` | Native diff integration, navigation, review controls and webview HTML |
| `src/webview.ts`, `src/ui/`, `media/panel.css` | Chat, history and review interface |
| `src/settings.ts`, `media/settings.css` | Usage dashboard, preferences and storage interface |
| `tests/`, `tests/extension/` | Unit/regression tests and real VS Code host scenarios |
| `scripts/`, `docs/` | Build/test tools, UI previews and implementation references |

## Check your change

```powershell
npm run typecheck
npm test -- --maxWorkers=2 --testTimeout=15000
```

For a focused unit test, run `npx vitest run tests/NAME.test.ts`. The lower worker count helps filesystem-heavy tests on Windows.

When changing VS Code integration, run the matching host scenario:

| Command | Scenario |
| --- | --- |
| `npm run test:extension` | Core extension behavior, native diffs, persistence and restart |
| `npm run test:changes:navigation` | Native diff navigation and review controls |
| `npm run test:review:webview` | Shared full-file Webview review, actual button clicks and both edition manifests |
| `npm run test:checkpoints` | Checkpoint creation, restore previews and Undo |
| `npm run test:external-review:host` | Saved changes from external agents/editors |

The host scenarios launch isolated VS Code profiles. Reports are written to `artifacts/`; generated workspaces live under `.test-runtime/`. Both folders are ignored by Git. Refer to [Development](docs/DEVELOPMENT.md) for provider-specific live tests and detailed behavior.

CI targets `main`. Its test diagnostics remain available after a failure. Maintainers can create a GitHub Release by pushing a matching `vX.Y.Z` tag on main's history; see the [publishing guide](docs/PUBLISHING.md) for versioning and git-history release notes.

## Preserve the review contract

- Accept keeps already-applied code and marks it reviewed. Revert and Restore preview their scope and preserve newer edits or unsaved buffers when a conflict is detected.
- Snapshot bytes and historical diffs stay immutable. Provider history discovery does not rewrite native transcripts or databases.
- Unknown or mixed change provenance stays visible rather than being assigned to an unverified conversation.
- Async state updates must remain bound to the current workspace, conversation and review revision.
- Every edition defaults to the bundled Monaco Webview review. Preserve complete source models, syntax highlighting, revision-bound inline buttons, scoped navigation and read-only snapshots. Keep the optional native diff and CodeLens actions working.

## Preview and document UI changes

```powershell
node scripts/preview-panel.mjs
node scripts/preview-settings.mjs --demo
```

Open the local URL printed by each server. Use `?groups=1` for conversation-group review, `?accounts=1` for synthetic dashboard account evidence and `?storage=1` for storage fixtures. `--demo` avoids reading personal usage records. Stop the server with Ctrl+C.

These previews render actual webviews with demonstration data. For native editor changes, also inspect the real VS Code Development Host: a browser preview cannot validate native diff layout, CodeLens or editor focus. Capture genuine screenshots of the affected screen and label experimental controls when they differ from the stable build.

Keep personal conversations, credentials, account details and real usage logs out of screenshots and commits.

## Open a pull request

Describe the concrete problem and the behavior after the change. Include the checks you ran and any relevant screenshots or host-test evidence. Add a focused regression test for behavior changes; documentation and asset updates usually need link/layout checks instead.

Keep the change focused, update the README or development reference when behavior changes, and explain any remaining runtime limitations. For large features or provider compatibility changes, open an issue to discuss scope before investing in the implementation.
