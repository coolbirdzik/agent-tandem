import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ChangeNavigationState } from './change-navigation';

/** A small view zone inside the native editor, not a replacement diff editor. */
export class ChangeFileBadge implements vscode.Disposable {
  private inset: vscode.WebviewEditorInset | undefined;
  private listeners: vscode.Disposable[] = [];
  private state: ChangeNavigationState | undefined;
  private pending: ReturnType<typeof setTimeout> | undefined;
  constructor(private chooseFile: () => Promise<void>) {}

  update(editor: vscode.TextEditor | undefined, state: ChangeNavigationState | undefined) {
    clearTimeout(this.pending); this.pending = undefined;
    // Stable Marketplace builds use the existing status-bar file picker.
    if (typeof vscode.window.createWebviewTextEditorInset !== 'function') { this.dispose(); return; }
    if (!editor || !state) { this.dispose(); return; }
    if (this.inset?.editor === editor) {
      const changed = this.state?.file !== state.file || this.state?.index !== state.index || this.state?.total !== state.total;
      this.state = state;
      if (changed) void this.inset.webview.postMessage({ type: 'count', ...state }).then(undefined, () => this.dispose());
      return;
    }
    this.dispose();
    // Multi-diff virtualizes its editors; wait for the incoming editor to settle.
    this.pending = setTimeout(() => {
      this.pending = undefined;
      if (vscode.window.activeTextEditor === editor && vscode.window.visibleTextEditors.includes(editor)) {
        try { this.show(editor, state); } catch { this.dispose(); }
      }
    }, 100);
  }

  private show(editor: vscode.TextEditor, state: ChangeNavigationState) {
    this.state = state;
    // -1 places the zone before the first code line (the native API adds one).
    const inset = vscode.window.createWebviewTextEditorInset(editor, -1, 2, { enableScripts: true, localResourceRoots: [] });
    this.inset = inset;
    this.listeners.push(inset.onDidDispose(() => {
      if (this.inset === inset) this.dispose();
    }), inset.webview.onDidReceiveMessage(message => {
      if (this.inset !== inset) return;
      if (message?.type === 'ready') void inset.webview.postMessage({ type: 'count', ...this.state });
      if (message?.type === 'chooseFile') void this.chooseFile();
    }));
    const nonce = randomBytes(16).toString('hex');
    inset.webview.html = `<!doctype html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<style nonce="${nonce}">
html,body{margin:0;height:100%;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
body{display:flex;align-items:center;justify-content:flex-end;box-sizing:border-box;padding:2px 12px}
button{font:inherit;cursor:pointer;border:1px solid var(--vscode-widget-border,transparent);border-radius:4px;padding:3px 10px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
</style></head><body><button id="change-file-count" title="Choose a changed file">File ${state.index}/${state.total}</button>
<script nonce="${nonce}">
const api=acquireVsCodeApi(),button=document.getElementById('change-file-count');
button.addEventListener('click',()=>api.postMessage({type:'chooseFile'}));
window.addEventListener('message',event=>{const s=event.data;if(s.type!=='count')return;button.textContent='File '+s.index+'/'+s.total;button.setAttribute('aria-label','Choose changed file '+s.index+' of '+s.total);button.title=s.file+' — Choose a changed file';});
api.postMessage({type:'ready'});
</script></body></html>`;
  }

  dispose() {
    clearTimeout(this.pending); this.pending = undefined;
    const inset = this.inset;
    this.inset = undefined; this.state = undefined;
    for (const listener of this.listeners.splice(0)) listener.dispose();
    inset?.dispose();
  }
}
