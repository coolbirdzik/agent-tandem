export interface ReviewEditorResources { script: string; style: string; icons: string; monacoStyle: string; worker: string; cspSource: string; nonce: string }
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
export function reviewWebviewHtml(resources: ReviewEditorResources): string {
  const r = Object.fromEntries(Object.entries(resources).map(([key, value]) => [key, escape(value)])) as unknown as ReviewEditorResources;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${r.cspSource} data:; style-src ${r.cspSource} 'unsafe-inline'; script-src 'nonce-${r.nonce}'; connect-src ${r.cspSource}; worker-src blob:;">
<meta name="review-worker" content="${r.worker}">
<title>AgentTandem Review</title><link rel="stylesheet" href="${r.monacoStyle}"><link rel="stylesheet" href="${r.icons}"><link rel="stylesheet" href="${r.style}"></head>
<body><header class="review-header"><div class="review-title"><span class="codicon codicon-diff" aria-hidden="true"></span><strong>Review changes</strong><span id="file-count"></span></div>
<div class="header-actions"><button id="undo" hidden title="Undo the latest Revert"><span class="codicon codicon-discard" aria-hidden="true"></span>Undo revert</button><button id="refresh" title="Capture saved changes and refresh"><span class="codicon codicon-refresh" aria-hidden="true"></span><span>Refresh</span></button><button id="native" title="Open this file in VS Code's native diff"><span class="codicon codicon-go-to-file" aria-hidden="true"></span><span>Native diff</span></button></div></header>
<nav class="file-toolbar" aria-label="Change navigation"><label class="file-picker" for="files"><span class="codicon codicon-files" aria-hidden="true"></span><select id="files" aria-label="Changed file"></select></label><div class="file-buttons"><button id="previous-file" title="Previous file (Alt+PageUp)" aria-label="Previous file"><span class="codicon codicon-chevron-left" aria-hidden="true"></span></button><button id="next-file" title="Next file (Alt+PageDown)" aria-label="Next file">Next file<span class="codicon codicon-chevron-right" aria-hidden="true"></span></button></div><span id="file-kind"></span><div class="navigation"><button id="previous" title="Previous change (Alt+Up)" aria-label="Previous change"><span class="codicon codicon-arrow-up" aria-hidden="true"></span></button><span id="block-count" aria-live="polite"></span><button id="next" title="Next change (Alt+Down)" aria-label="Next change"><span class="codicon codicon-arrow-down" aria-hidden="true"></span>Next change</button></div></nav>
<div id="error" role="alert" hidden></div><div id="status" role="status" aria-live="polite"></div>
<main id="diff" aria-label="File changes"><p class="empty">Loading saved changes…</p></main>
<footer>Accept keeps applied code. Reject restores the saved baseline.</footer>
<script nonce="${r.nonce}" src="${r.script}"></script></body></html>`;
}
