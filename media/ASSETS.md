# Assets

## AgentTandem icon

`icon.svg` is the editable source for `icon.png` (256 × 256), used by the extension manifest. The original companion mark combines a six-petal rosette suggesting Codex, a muted terracotta burst suggesting Claude, a history arrow around both agents, and three dashboard bars. Charcoal green and terracotta sit on warm ivory. `tandem.svg` is the matching 24 × 24 monochrome Activity Bar icon; `currentColor` lets VS Code apply the theme color. It is an independent AgentTandem composition, not an official joint provider logo.

To regenerate the PNG, render `icon.svg` at its native 256 × 256 size, preserving transparency at the rounded corners.

`screenshots/review.png` and `screenshots/chat.png` render the actual AgentTandem webview with the demonstration data in `scripts/preview-panel.mjs`. They contain no personal conversations or account data.

`screenshots/history.jpg` uses the same panel fixture with conversation history open. `screenshots/dashboard.jpg` and `screenshots/storage.jpg` use `scripts/preview-settings.mjs --demo` with `?accounts=1` and `?storage=1`. The `--demo` option generates synthetic usage and never loads the user's local token records.

`screenshots/editor-diff.png` is an actual VS Code Development Host capture from `artifacts/inline-layout.png`, produced by `scripts/verify-floating-navigation.mjs`. It shows the local development build's native multi-file inline diff with experimental per-block action cards and navigation. The stable Marketplace build uses CodeLens instead. All source files in the image are navigation test fixtures.

## Provider assets

`provider-icons.ttf` contains two monochrome glyphs generated from `codex.svg` and `claude.svg` for VS Code's native status bar. The `agent-tandem-codex` and `agent-tandem-claude` product icons inherit the status item's theme/quota color. Regenerate with `python scripts/generate-provider-icons.py` (requires `fonttools`); normal extension builds use the committed font without Python. Preferences uses the matching SVG assets.

`codex.svg` is an unchanged copy of `resources/blossom-black.svg` from the installed OpenAI Codex VS Code extension (`openai.chatgpt`, version `26.1002.51308`). That extension uses its matching white SVG for the Codex activity bar. Source: [OpenAI Codex extension](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt). AgentTandem switches the monochrome mark to white in VS Code dark/high contrast themes through CSS.
