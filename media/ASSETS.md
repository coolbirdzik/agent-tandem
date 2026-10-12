# Assets

## AgentDock icon

`icon.svg` is the editable source for `icon.png` (256 × 256), used by the extension manifest. The original six-petal mark uses soft radial shapes and a central opening, in charcoal green on warm ivory. `dock.svg` is the matching 24 × 24 monochrome Activity Bar icon; `currentColor` lets VS Code apply the theme color. It is an AgentDock mark, not a modified provider logo.

To regenerate the PNG, render `icon.svg` at its native 256 × 256 size, preserving transparency at the rounded corners.

`screenshots/review.png` and `screenshots/chat.png` render the actual AgentDock webview with the demonstration data in `scripts/preview-panel.mjs`. They contain no personal conversations or account data.

## Provider assets

`codex.svg` is an unchanged copy of `resources/blossom-black.svg` from the installed OpenAI Codex VS Code extension (`openai.chatgpt`, version `26.1002.51308`). That extension uses its matching white SVG for the Codex activity bar. Source: [OpenAI Codex extension](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt). AgentDock switches the monochrome mark to white in VS Code dark/high contrast themes through CSS.
