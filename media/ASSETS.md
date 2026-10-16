# Assets

## AgentTandem icon

`icon.svg` is the editable source for `icon.png` (256 × 256), used by the extension manifest. The original companion mark combines a six-petal rosette suggesting Codex, a muted terracotta burst suggesting Claude, a history arrow around both agents, and three dashboard bars. Charcoal green and terracotta sit on warm ivory. `tandem.svg` is the matching 24 × 24 monochrome Activity Bar icon; `currentColor` lets VS Code apply the theme color. It is an independent AgentTandem composition, not an official joint provider logo.

To regenerate the PNG, render `icon.svg` at its native 256 × 256 size, preserving transparency at the rounded corners.

`screenshots/review.png` and `screenshots/chat.png` render the actual AgentTandem webview with the demonstration data in `scripts/preview-panel.mjs`. They contain no personal conversations or account data.

`screenshots/history.png` uses the same panel fixture with conversation history open. The Settings captures (`dashboard`, `token-dashboard`, `accounts`, `account-switch`, `preferences`, `storage`) use `scripts/preview-settings.mjs --demo`. `account-detail` (after **View usage** on the first account card), `quota-burn-down`, `tokens-per-quota`, `conversations` (with one conversation opened) and `usage-breakdown` are section crops of the **All accounts · This month** dashboard. The `--demo` option generates synthetic usage and never loads the user's local token records. Run `node scripts/capture-readme.mjs` to regenerate them all.

`screenshots/editor-diff.png`, `image-diff.png` and `agent-changes.png` are actual VS Code Development Host captures of the Marketplace build, produced by `node scripts/test-review-webview.mjs --marketplace-only --readme` and copied by `scripts/capture-readme.mjs`. All source files in the images are review test fixtures.

## Provider assets

`provider-icons.ttf` contains two monochrome glyphs generated from `codex.svg` and `claude.svg` for VS Code's native status bar. The `agent-tandem-codex` and `agent-tandem-claude` product icons inherit the status item's theme/quota color. It also contains the quota meters for the **Quota rings** and **Minimal columns** status bar styles: `agent-tandem-quota-ring-0`…`8` (U+E010–E018) and `agent-tandem-quota-level-0`…`8` (U+E020–E028), one glyph per eighth of remaining quota. They are drawn for 16px: one-pixel outline and gap. The Preferences preview renders the same glyphs through `@font-face`. Regenerate with `python scripts/generate-provider-icons.py` (requires `fonttools`); normal extension builds use the committed font without Python. Preferences uses the matching SVG assets.

`codex.svg` is an unchanged copy of `resources/blossom-black.svg` from the installed OpenAI Codex VS Code extension (`openai.chatgpt`, version `26.1002.51308`). That extension uses its matching white SVG for the Codex activity bar. Source: [OpenAI Codex extension](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt). AgentTandem switches the monochrome mark to white in VS Code dark/high contrast themes through CSS.
