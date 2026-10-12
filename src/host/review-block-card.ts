import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ReviewHunk } from '../core/review-hunks';

export type BlockAction = 'accept' | 'revert' | 'next';

/** A themed action card anchored immediately above one immutable diff block. */
export class ReviewBlockCard implements vscode.Disposable {
  readonly inset: vscode.WebviewEditorInset;
  private listeners: vscode.Disposable[];
  private disposed = false;
  constructor(editor: vscode.TextEditor, hunk: ReviewHunk, index: number, total: number, more: boolean, act: (action: BlockAction) => void, onDispose: () => void) {
    const line = Math.min(hunk.newLine, Math.max(editor.document.lineCount - 1, 0));
    // The native API adds one line, so -1 anchors the card directly above the block.
    this.inset = vscode.window.createWebviewTextEditorInset(editor, line - 1, 2, { enableScripts: true, localResourceRoots: [] });
    this.listeners = [this.inset.onDidDispose(() => { this.dispose(); onDispose(); }), this.inset.webview.onDidReceiveMessage(message => {
      if (this.disposed || !['accept', 'revert', 'next'].includes(message?.type)) return;
      if (message.type !== 'next') void this.inset.webview.postMessage({ type: 'busy' }).then(undefined, () => undefined);
      act(message.type as BlockAction);
    })];
    const nonce = randomBytes(16).toString('hex');
    const place = `block ${index + 1} of ${total}`;
    this.inset.webview.html = `<!doctype html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<style nonce="${nonce}">
html,body{margin:0;height:100%;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:12px}
body{display:flex;align-items:center;padding:0 10px;box-sizing:border-box}
.card{display:flex;align-items:center;gap:8px;max-width:100%;box-sizing:border-box;padding:4px 8px;border:1px solid var(--vscode-editorWidget-border,var(--vscode-panel-border,transparent));border-radius:6px;background:var(--vscode-editorWidget-background);box-shadow:0 2px 8px var(--vscode-widget-shadow,transparent)}
.chip{flex:none;padding:1px 8px;border-radius:10px;font-size:11px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.stats{flex:none;display:flex;gap:6px;font-size:11px}
.stats .add{color:var(--vscode-gitDecoration-addedResourceForeground,var(--vscode-charts-green))}
.stats .del{color:var(--vscode-gitDecoration-deletedResourceForeground,var(--vscode-charts-red))}
button{flex:none;display:inline-flex;align-items:center;gap:6px;font:inherit;line-height:16px;cursor:pointer;border:1px solid transparent;border-radius:4px;padding:4px 12px;white-space:nowrap}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button.primary:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
button.ghost{background:transparent;color:var(--vscode-foreground);border-color:var(--vscode-editorWidget-border,transparent)}
button.ghost:hover{background:var(--vscode-toolbar-hoverBackground)}
button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
button:disabled{opacity:.5;cursor:default}
.hint{opacity:.65;font-size:10px}
@media(max-width:700px){.hint{display:none}}
@media(max-width:520px){.stats{display:none}}
@media(max-width:430px){.chip{display:none}}
@media(max-width:320px){button.ghost{display:none}}
</style></head><body data-review-block="${hunk.id}" data-block-index="${index + 1}" data-block-line="${line}">
<div class="card">
<span class="chip">Block ${index + 1}/${total}</span>
<span class="stats" aria-label="${hunk.newLines} added, ${hunk.oldLines} removed"><span class="add">+${hunk.newLines}</span><span class="del">&#8722;${hunk.oldLines}</span></span>
<button class="primary" data-action="accept" aria-label="Accept ${place}" title="Keep ${place} and mark it reviewed">&#10003; Accept<span class="hint">Alt+Y</span></button>
<button class="secondary" data-action="revert" aria-label="Reject ${place}" title="Reject ${place} and restore its previous content">&#10005; Reject<span class="hint">Alt+N</span></button>
${more ? '<button class="ghost" data-action="next" aria-label="Go to the next change" title="Go to the next change, continuing into the next changed file">&#8595; Next change</button>' : ''}
</div>
<script nonce="${nonce}">
const api=acquireVsCodeApi();
document.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>{
  if(button.dataset.action!=='next')document.querySelectorAll('button').forEach(b=>b.disabled=true);
  api.postMessage({type:button.dataset.action});
}));
window.addEventListener('message',event=>{if(event.data.type==='busy')document.querySelectorAll('button').forEach(b=>b.disabled=true);});
</script></body></html>`;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const listener of this.listeners) listener.dispose();
    this.inset.dispose();
  }
}
