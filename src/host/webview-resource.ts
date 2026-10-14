import * as vscode from 'vscode';

/** Preserve remote authority casing when Chromium normalizes the URL hostname. */
export function webviewResource(webview: Pick<vscode.Webview, 'asWebviewUri'>, extensionUri: vscode.Uri, ...parts: string[]): string {
  const uri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts));
  // VS Code encodes punctuation in remote authorities as -xxxx, but leaves
  // uppercase letters intact. A hostname lowercases those letters (WSL: Debian
  // becomes debian), so the resource loader can reject it with 401. Use the same
  // encoding for capitals before the URL reaches the browser.
  if (uri.scheme === 'https' && uri.authority.startsWith('vscode-remote+')) {
    return uri.with({ authority: uri.authority.replace(/[A-Z]/g, char => `-${char.charCodeAt(0).toString(16).padStart(4, '0')}`) }).toString();
  }
  return uri.toString();
}
