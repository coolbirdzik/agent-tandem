import * as vscode from 'vscode';
import { webviewResource } from './webview-resource';
import { randomBytes } from 'node:crypto';
import type { ImageComparison } from '../core/media-preview';
import { imageMime } from '../core/media-preview';
import type { ChangeComparison } from './change-navigation';

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/** Image counterpart to the native text diff, using the same navigation scope. */
export class ImageDiff implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private version = 0;
  constructor(private extensionUri: vscode.Uri, private read: (file: ChangeComparison) => Promise<ImageComparison | undefined>) {}
  async open(file: ChangeComparison, title: string): Promise<boolean> {
    if (!imageMime(file.file)) return false;
    const version = ++this.version;
    const images = await this.read(file);
    if (version !== this.version) return true;
    if (!images) return false;
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('agentTandem.imageDiff', title, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')] });
      this.panel = panel;
      panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; this.version++; } });
      panel.webview.onDidReceiveMessage(message => {
        const commands: Record<string, string> = { previous: 'agentTandem.previousFile', next: 'agentTandem.nextFile', choose: 'agentTandem.chooseChangedFile' };
        if (panel.active && typeof message?.type === 'string' && Object.hasOwn(commands, message.type)) void vscode.commands.executeCommand(commands[message.type]!);
      });
    } else this.panel.reveal(vscode.ViewColumn.Active);
    const panel = this.panel;
    panel.title = title;
    const resource = (folder: string, name: string) => escape(webviewResource(panel.webview, this.extensionUri, folder, name));
    const nonce = randomBytes(18).toString('base64');
    panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${resource('media', 'review-editor.css')}"></head><body><header class="review-header"><strong>${escape(file.file)}</strong><div class="header-actions"><button data-action="previous">Previous file</button><button data-action="choose">Choose file</button><button data-action="next">Next file</button></div></header><main id="images" aria-label="Image changes"></main><footer>Saved image snapshots · Before / After</footer><script id="image-data" type="application/json">${JSON.stringify({ images, file: file.file }).replace(/</g, '\\u003c')}</script><script nonce="${nonce}" src="${resource('dist', 'image-diff.js')}"></script></body></html>`;
    return true;
  }
  dispose() { this.version++; this.panel?.dispose(); }
}
