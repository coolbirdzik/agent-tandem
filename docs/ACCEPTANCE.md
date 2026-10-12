# AgentTandem acceptance plan

These cases define verification requirements for the [MVP](PLAN.md), not completed test results. Fixtures must use real files/Git repositories. Fake providers support controlled failures, followed by core workflows with real Codex and Claude.

## Test organization

| Layer | Scope | Evidence |
| --- | --- | --- |
| Unit | Event mapping, state transitions, manifests and path scope | Results and fixture input/output |
| Integration | Worktrees, snapshots, diffs, merge, apply, revert and recovery | File hashes/bytes and before/after Git status/index |
| Extension | Chat, commands, bridges, native diffs and reload | Development Host results and turn/run-associated logs |
| Real providers | Authentication, streaming, approvals, Stop, resume, fork/fallback | Real sessions with pinned CLI/SDK versions |
| Installation | VSIX on a clean Windows VS Code profile | Smoke sessions and interaction checklists |

Prioritize data-loss and incorrect-context risks. Do not test only function names or UI text. Each case needs setup, actions, expectations and comparable artifacts.

## Standard fixtures

A small committed repository with two text files, CRLF/BOM content, Unicode/spaced paths, small binary, staged, unstaged, untracked and ignored files. Record initial hashes, branch/HEAD and index bytes.

Add unsaved buffers, external same-file edits, renames/deletions, junctions/links, submodules, low quotas and background writers. Unsupported MVP types must be explicitly blocked rather than treated as ordinary files.

## Workspace preservation

| ID | Scenario | Required result |
| --- | --- | --- |
| W01 | Session from a clean repository | Agent edits only worktree; main files/index/HEAD unchanged before Apply |
| W02 | Staged + unstaged + untracked baseline | Baseline reflects selected disk state; main contents/staging unchanged |
| W03 | Local deletion before baseline | Worktree reflects deletion; HEAD content is not accidentally restored |
| W04 | Unsaved buffer differs from disk | Request save or cancel; never silently use stale content |
| W05 | Workspace changes during baseline | Detect mismatch and rebuild/cancel; no inconsistent baseline |
| W06 | Non-Git, uncommitted, virtual or missing root | Block Run with actionable reason |
| W07 | Link/junction outside root | Block target and preserve external file |
| W08 | Agent attempts main-workspace/Git metadata writes | Permissions/tool policy prevents writes and reports failure; otherwise configuration fails release gate |
| W09 | Missing dependencies/local secrets | Disclose requirements before Run; no shared writable main-workspace paths |

## Chat and providers

Accept conversation sync before new chat: open both providers' existing CLI/app sessions; exclude siblings; support nested cwd/Windows casing; follow appended/partial writes; avoid response/event duplicates; isolate provider errors; prevent stale selection/project reads; retain sessions on reload. History needs no inference/key/Git. Without snapshots, UI cannot claim code revert support.

| ID | Scenario | Required result |
| --- | --- | --- |
| P01 | Prompt with file/selection | Preview and send exact context snapshot; stream targets correct session/turn |
| P02 | Long text/tool streaming | Responsive UI, no duplicates, no forced scroll for readers above bottom |
| P03 | Approve one tool request, reject another | Correct request/turn decisions; rejection never becomes approval or infinite waiting |
| P04 | Stop during execution | Interrupted turn, no remaining writer, reviewable partial diff |
| P05 | Expired auth, missing CLI, crash/timeout | Distinct errors, no false completion; Retry only on request |
| P06 | Duplicate/delayed/old-run events | Current turn intact; stale content not appended |
| P07 | Reload mid-turn | Reconcile processes/provider; no prompt replay or duplicate turns |
| P08 | Reopen session | Correct native session/cwd and intact pending review |
| P09 | Two windows run the same repository | Repository lock prevents concurrent writers under MVP policy |

P01/P03/P04/P05/P08 must run on both real providers. Race/crash cases use fake adapters plus at least one smoke test per provider's lifecycle mapping.

## Review and apply

Message checkpoints: `npm run test:checkpoints` uses isolated workspaces/profiles/history without inference or writes to real CLI homes. Both providers must correctly associate duplicate prompts with pre-turn checkpoints; Accept preserves them; previews never write; stale tokens/unsaved buffers are blocked; restore/undo preserves bytes and chat; checkpoint/Undo survives restart. `tests/checkpoints.test.ts` additionally covers post-preview edits/additions/deletions, binary/BOM/CRLF/large files, ignores, chat branches, corrupt snapshots, links, copy races and partial restore reviews. Check user/restore UI in light/dark themes, narrow sidebars and forced colors.

| ID | Scenario | Required result |
| --- | --- | --- |
| D01 | Modify two files, add one, delete one | Correct whole-turn diff including untracked additions; opening diff never writes |
| D02 | Shell file edits | Included despite missing provider fileChange events |
| D03 | Apply one file, discard the rest | Only selected delta reaches main workspace; worktree reconciles |
| D04 | Apply All to unchanged workspace | Correct bytes, unchanged index/HEAD, committed journal |
| D05 | User edits another region before Apply | Merge preserves both; preview matches planned write |
| D06 | User edits overlapping region/binary | Explicit conflict, no overwrite; Apply All blocked until resolved |
| D07 | Agent/user concurrently create same name | Conflict and preserved user file |
| D08 | Agent deletes newly user-edited file | Conflict without silent deletion |
| D09 | Unsaved target buffer | Apply blocked until save/cancel; no buffer/disk divergence from external writes |
| D10 | Retain old diff, request next turn | Pending review locks next turn; resolved baseline/diff stays turn-correct |
| D11 | Failed/interrupted turn with edits | Partial diff readable; no automatic apply/discard |
| D12 | CRLF/BOM/binary/Unicode names | Exact non-merge bytes; text merges follow encoding policy |
| D13 | Locked/permission-denied mid-transaction file | Partial journal, hash-checked recovery/rollback, path/reason reported |
| D14 | Change after preview before write | Recheck preconditions; block/recover with conflicts rather than overwrite from stale preview |

## Per-step viewing

These cases verify APIs/recorders in [VS Code research](VSCODE-API-RESEARCH.md). Read-only history viewing is not mid-tool apply/revert.

| ID | Scenario | Required result |
| --- | --- | --- |
| T01 | A edits one file, B edits it again | A compares 0 → 1, B compares 1 → 2; reopening A never uses latest content |
| T02 | Step completes during active turn | Immutable View Changes available; agent continues without changing selected step |
| T03 | Multi-file step | Correct changes-editor file set and usable minimum-version fallback |
| T04 | Add/delete, CRLF/BOM, Unicode paths | Correct snapshots/absent-side semantics; no workspace writes just to open diffs |
| T05 | Switch individual/cumulative modes | Correct boundaries/labels; whole-turn diff not presented as individual step |
| T06 | Read/search/test/build tools | No-change verified by manifests; writing test/build tools still show changes |
| T07 | Bash edits or partial tool failure | Exact/grouped evidence with visible partial diffs |
| T08 | Concurrent tools/background commands | Exact if serialized; otherwise explicitly grouped, never mixed into one step |
| T09 | Late/duplicate events, hook timeout, untrusted/disconnected recorder | No false Exact; capability and turn-review provenance stay correct |
| T10 | Rapid step clicks, two tabs, reload | Correct historical URIs and storage resolution |
| T11 | View Changes during execution | No workspace/worktree/context restore/apply; writes remain locked |
| T12 | Cleanup with open step diff | Referenced blobs retained; missing data reported without live-file substitution |

Run prototype T01–T04/T10/T11 in Development Host. Run T01/T02/T07–T09 on both real providers to distinguish diff APIs from capture accuracy.

## Message-level revert

Step viewing does not change MVP message-level revert semantics.

| ID | Scenario | Required result |
| --- | --- | --- |
| R01 | Revert before first turn | Fresh branch excludes old turns; code follows selected baseline/mode |
| R02 | Conversation Only after two turns | UI/provider context excludes selected/later turns; code retained and disclosed |
| R03 | Code Only after two turns | History retained; restored code disclosed to next turn |
| R04 | Conversation and Code before apply | Worktree/context return together; main workspace unchanged |
| R05 | Revert applied code without later edits | Reverse only later transactions, preserving pre-baseline independent edits |
| R06 | Revert applied code with independent later edits | Provably mergeable edits preserved, otherwise conflict |
| R07 | Overlap, binary or name collision | Conflict preview without overwrite |
| R08 | Edit & Resend old prompt | Branch before old turn, load prompt, exclude removed later context |
| R09 | Provider lacks boundary fork | Disclosed reconstructed session, never resume removed-turn context |
| R10 | Active/background writer | Revert locked until verified shutdown |
| R11 | Fork succeeds, file restore fails | No completed-branch switch; recovery retains pre-operation state |
| R12 | Browse discarded branch | Transcript/diff readable without workspace/active-context changes |

Verify R02/R08/R09 through next-turn prompts and adapter payloads/IDs: information exclusive to removed turns must not enter new context. UI disappearance or a random model answer alone is insufficient.

## Storage and recovery

| ID | Scenario | Required result |
| --- | --- | --- |
| S01 | Reload pending/partially resolved review | Decisions, snapshots and diffs intact |
| S02 | Crash after first Apply All write | Recover journal, reconcile files, preserve later edits |
| S03 | Crash during Conversation and Code | Recovery state, no false code/context success |
| S04 | Full quota/missing blob | No false complete checkpoint; block incomplete restore and retain available data |
| S05 | Clean old sessions | Delete resolved owned data only; retain referenced blobs/pending worktrees |
| S06 | Branch/HEAD change, moved root, missing worktree | Require reconciliation; no same-name wrong-repository resume |
| S07 | Storage schema upgrade | Preserve history; back up unreadable data and report clear errors |

## UI and permissions

- Keyboard-operable chat/review, light/dark themes, labeled icons and focus states.
- Malicious Markdown cannot execute scripts; invalid bridge schemas/out-of-scope paths are rejected.
- Untrusted workspaces spawn no providers and write no files.
- Keys/tokens never enter webviews/transcripts/logs; sensitive code/logs are not automatically sent to telemetry.
- Setup/conflict/quota errors have concrete actions and durable details, not disappearing toasts alone.

## Release smoke test

Run the packaged VSIX on a clean Windows VS Code Desktop profile, once per provider:

1. Configure supported authentication, open a fixture with independent edits and start a session.
2. Request two-file edits across steps; view steps while running, reopen old steps, then apply one file/discard the other after completion.
3. Send another turn, Stop mid-run and review partial code.
4. Manually edit another region, revert before turn one and verify merges/conflicts.
5. Edit & Resend, verify readable old branches and correct new context.
6. Reload, reopen, verify history/review and no unintended surviving writers.

Record VS Code/Git/Node/CLI/SDK versions, reports and hashes/Git status as preservation evidence. Redact secrets before sharing logs.

## Release blockers

- Lost/overwritten user edits or unintended index/HEAD changes.
- Incomplete snapshots reported as full restores; incorrect turn/step diffs, live-file substitution or missing scoped shell edits.
- UI revert with provider still using removed context.
- Reported Stop while writers continue; automatic retry/reload prompt replay.
- Partial apply/revert without journals/recovery or hidden conflicts.
- Fake-only provider support or no real packaged VSIX verification.

During implementation, assign each ID a test/checklist with status `not run`, `passed`, `failed`, or `blocked`. Test names or passing mocks alone never justify acceptance.


## Model source and flat chat verification — 2026-10-08

- `npm run typecheck` and all 175 Vitest tests passed. Regression checks cover PATH order, npm launcher resolution including hoisted packages, explicit executable overrides, stale model-source detection and webview CLI selection/provenance.
- `artifacts/models-live-test.json`: VS Code 1.141.0 confirmed the default catalog came from the terminal Codex 0.99.0. A project-scoped selection of Codex 0.162.0-alpha.2 returned its GPT-6 catalog; native rollout records confirmed GPT-6 Luna and GPT-6.1 Sol on the same resumed conversation. Claude 2.1.220 returned its own aliases; native history confirmed Sonnet then Haiku on resume. Discovery created no conversation. `artifacts/models-reopen-test.json` confirms model preferences survived Extension Host restart.
- Browser preview used the actual panel HTML, stylesheet and webview bundle with a disposable fixture. Visually checked light/dark themes at 280 px, checked 500 px, and measured no horizontal document overflow. User/tool messages have transparent surfaces and zero border/radius; actual VS Code native picker interactions were not visually observed.

## Managed CLI verification — 2026-10-08

- Typecheck and all 185 Vitest tests passed. New coverage checks persisted provider lists/defaults, disabled/removed selection rejection, stale writes, corrupt data, scan preserving disabled choices, validated requests and webview controls/drafts/locks.
- `artifacts/cli-manager-live-test.json` and `artifacts/cli-manager-reopen-test.json`: real VS Code 1.141.0 with Codex 0.99.0 and Claude 2.1.220. Hard-linked native executables in an isolated temporary folder were added, renamed, selected globally/per project, moved within their registry entries, disabled and enabled. Catalogs used the selected paths, selection IDs survived path edits and restart, disabled CLIs were blocked before native chat creation, and removal preserved the executable while leaving selected/default CLIs blocked until explicitly changed. No inference was needed for this management check.
- Actual HTML/CSS/webview browser fixture checked at 280/500 px in light/dark themes: no horizontal document overflow, disabled selection options stay disabled, inline editing retains text/focus/caret across history refresh. Native VS Code GUI clicks were not observed; Extension Host command execution and persistence were verified.

## Softer flat interface — 2026-10-08

- Typecheck and all 34 webview tests passed after the visual changes. Backend CLI, chat and review behavior is unchanged.
- Browser fixture using the actual HTML/CSS/bundle was visually checked in dark/light themes at 280, 380 and 500 px. Chat/review, history, inline CLI editing and running/Stop states remained usable with no horizontal document overflow. CLI drafts/focus/caret survived refresh; full executable paths remain available in tooltips. Narrow composer columns were adjusted to give the access picker enough room.
- Rounded, neutral controls replace underlined CLI inputs; chat has a quiet input surface, history selection uses the same theme tone, and separators remain only where useful. Focus, forced-color overrides and reduced-motion rules remain in the stylesheet; native high-contrast GUI rendering was not observed.

## Reasoning effort and composer controls — 2026-10-08

- Typecheck and all 195 Vitest tests passed. New checks cover native capability parsing, unsupported/stale levels, request validation, per-model/project/provider persistence, pending selection/focus during sync, active-turn locking and start/resume/fork forwarding for both adapters.
- `artifacts/models-live-test.json`: VS Code 1.141.0 completed native Codex Low/Medium turns on the same resumed conversation; rollout turn contexts recorded the exact selected efforts. Claude Sonnet completed with Low and its owned native process received `--effort low`; switching to Haiku used Auto because its catalog reported no supported effort levels. `artifacts/models-reopen-test.json` confirms effort preferences survived a real Extension Host restart. No global CLI configuration was edited.
- `artifacts/effort-auto-live.json`: native Codex Low followed by Auto on the same conversation recorded Low then the configured CLI default High. Auto restored the native configuration instead of retaining the earlier explicit override.
- Actual HTML/CSS/webview browser fixture checked dark/light at 280, 380 and 500 px, including the active/Stop state: no horizontal overflow, controls align, the model gets its own row in narrow sidebars and all three fields share a row in wide panels. Native OS dropdown appearance/clicks were not visually observed.


## Compact model popover — 2026-10-08

- Typecheck and all 39 webview tests passed. Model/effort forwarding and storage are unchanged. New checks cover opening, sync/focus persistence, Escape restoring trigger focus, outside click, tab-out and active-run locking.
- Actual HTML/CSS/bundle browser fixture checked at 280/500 px, dark/light: compact composer controls fit, the model/effort popover stays inside the viewport without clipping from the chat form, and reasoning selection/focus survives history sync. Provider/model/effort settings remain in the popover; access and Send stay in the composer.


## Common dropdowns and native context/cache — 2026-10-08

- Typecheck and all 217 Vitest tests passed. Coverage includes custom listbox keyboard/typeahead/disabled choices, required form validation, focus and active menu preservation, switching from the model popover to access, context reset on model changes, cache countdown without sync resets, native usage normalization and atomic per-project/conversation metadata persistence.
- Actual HTML/CSS/bundle browser fixture checked in dark/light at 280/320/500 px: no horizontal overflow; model/reasoning/access menus fit within the viewport. Escape closes the submenu and returns focus while keeping the model popover open. Keyboard highlight/focus survives history refresh.
- `artifacts/models-live-test.json` reports successful native Codex/Claude start/resume/model switches, current context tokens and context window capacity. Claude reported a 1-hour cache write TTL in earlier requests; cache-hit-only requests can omit TTL and remain explicitly unknown. Codex reports cached token usage but does not expose expiry/TTL in the transport. Cumulative conversation/model totals are never used as the current context count.
- `artifacts/models-reopen-test.json` and `artifacts/context-reopen-live.log` confirm both providers restore the same usage and original optional expiry after a separate Extension Host restart. Local metadata is stored atomically outside provider transcripts, limited to 200 conversations per project and rejected when native history revision changes. VS Code test-mode in-memory mementos were replaced with file storage; nullable/omitted telemetry keys are compared in serialized form.
- Native verification exposed a Windows taskkill/exit-event race. Cleanup now waits for the owned root exit when a descendant has already exited, and still rejects if the root stays alive. The real owned-tree/sibling heartbeat test and both error/race regression tests passed.


## Test history isolation — 2026-10-08

- Regression tests cover both provider home overrides on every live launcher, independent credential/config copies, omission of transcripts/project state, fail-closed legacy reopen and filtering old test workspaces from parent-project lists for both providers. Matching uses known runtime directories; human prompts containing MODEL_OK stay visible. Opening a test workspace directly still shows its own history.
- `artifacts/provider-test-isolation.json`: real Codex/Claude model discovery succeeded in dedicated test homes, with zero new JSONL conversations and no prompt/inference submission. This check does not claim the paid live chat suites were rerun.
- Existing native transcripts remain on disk. Old test entries are filtered in AgentTandem; other CLI apps can still show those old entries.
