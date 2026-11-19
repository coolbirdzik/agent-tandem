export interface ReviewEditorResources { script: string; style: string; icons: string; monacoStyle: string; worker: string; cspSource: string; nonce: string }
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
export function reviewWebviewHtml(resources: ReviewEditorResources): string {
  const r = Object.fromEntries(Object.entries(resources).map(([key, value]) => [key, escape(value)])) as unknown as ReviewEditorResources;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${r.cspSource} data:; font-src ${r.cspSource} data:; style-src ${r.cspSource} 'unsafe-inline'; script-src 'nonce-${r.nonce}'; connect-src ${r.cspSource}; worker-src blob:;">
<meta name="review-worker" content="${r.worker}">
<title>AgentTandem Review</title><link rel="stylesheet" href="${r.monacoStyle}"><link rel="stylesheet" href="${r.icons}"><link rel="stylesheet" href="${r.style}"></head>
<body><header class="review-header"><nav class="file-toolbar" aria-label="Change navigation">
<div class="file-picker"><span class="codicon codicon-diff" aria-hidden="true"></span><select id="files" aria-label="Changed file" disabled></select></div>
<div class="file-decisions" role="group" aria-label="File actions">
<button id="reject-all-file" class="file-reject-all" aria-label="Revert all" title="Revert all pending changes in this file and restore its saved baseline"><span class="codicon codicon-discard-all" aria-hidden="true"></span><span class="action-label">Revert all</span></button>
<button id="accept-all-file" class="file-accept-all" aria-label="Accept all" title="Accept all pending changes in this file"><span class="codicon codicon-check-all" aria-hidden="true"></span><span class="action-label">Accept all</span></button>
<button id="discard-edit" aria-label="Discard draft" title="Discard unsaved review edits" hidden><span class="codicon codicon-discard" aria-hidden="true"></span><span class="action-label">Discard draft</span></button>
<button id="save-edit" aria-label="Save edits" title="Save edits to the workspace file (Ctrl/Cmd+S)" hidden><span class="codicon codicon-save" aria-hidden="true"></span><span class="action-label">Save edits</span></button></div>
<div class="file-buttons" role="group" aria-label="File navigation"><button id="previous-file" title="Previous file (Alt+PageUp)" aria-label="Previous file"><span class="codicon codicon-chevron-left" aria-hidden="true"></span></button><button id="next-file" title="Next file (Alt+PageDown)" aria-label="Next file"><span class="codicon codicon-chevron-right" aria-hidden="true"></span></button></div>
<div class="navigation" role="group" aria-label="Change navigation"><button id="previous" title="Previous change (Alt+Up)" aria-label="Previous change"><span class="codicon codicon-arrow-up" aria-hidden="true"></span></button><span id="block-count" aria-live="polite"></span><button id="next" title="Next change (Alt+Down)" aria-label="Next change"><span class="codicon codicon-arrow-down" aria-hidden="true"></span></button></div>
<button id="review-more" type="button" aria-label="More review actions" aria-haspopup="menu" title="More review actions" disabled><span class="codicon codicon-ellipsis" aria-hidden="true"></span></button>
</nav></header>
<div id="error" role="alert" hidden></div><div id="status" role="status" aria-live="polite"></div>
<div class="review-layout"><main id="diff" aria-label="File changes"><p class="empty">Loading saved changes…</p></main></div>
<script nonce="${r.nonce}" src="${r.script}"></script></body></html>`;
}
