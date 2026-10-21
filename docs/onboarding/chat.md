# Chat here or use your native tools

Use **Manage CLIs** to select installed Codex and Claude executables. Sign in through their native CLI flow. AgentTandem uses that selected CLI and its native authentication.

Codex defaults to **Automatic (PATH, then current Codex extension)**. It validates the terminal Codex first, then tries the OpenAI extension reported by the current VS Code host. If that extension is unavailable, it scans the same host's installation directory and uses semver ordering to find the newest working bundle. Without an editor-reported installation, it falls back to the standard extension directories. The selected source, version and path appear in Manage CLIs.

Automatic resolutions are cached in memory, independently of the managed CLI list. Account polling reuses the cache after checking the executable's file metadata. CLI/settings changes, extension changes, workspace changes and explicit Scan/Check versions actions invalidate the cache; a missing or changed executable is resolved again. Automatic selection does not add or enable managed entries. Leave **This project** on **Use default CLI** to follow these changes. **Pinned** choices retain their selected executable; **Terminal CLI (PATH)** requires a managed terminal installation. Disabled entries remain blocked.

Pick the provider, model, reasoning and access mode in the composer. Send text or supported attachments; messages sent while an agent runs can be queued.

History defaults to the current workspace. Conversations started in the native tools can be resumed here when their local history is available. Existing conversations are never rewritten merely by opening history.

Tracking stays on during AgentTandem chat. It waits for the turn to finish and resumes without capturing the same edit twice.
