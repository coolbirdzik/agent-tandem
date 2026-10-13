import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ReviewRequest, ReviewState, ReviewStore } from '../core/review';
import type { ReviewEditorState } from '../core/review-webview';
import { reviewGroup } from '../core/review-groups';
import { reviewWebviewHtml } from './review-webview-html';

/** Shared stable-API review editor. The host owns scope, revisions and all decisions. */
export class ReviewWebview implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private listeners: vscode.Disposable[] = [];
  private scope?: ReviewRequest;
  private model: ReviewEditorState = { files: [], busy: false };
  private version = 0;
  private signature = '';
  private posted = '';
  private pending?: ReturnType<typeof setTimeout>;
  private acting = false;
  constructor(private extensionUri: vscode.Uri, private reviews: ReviewStore,
    private current: () => { project?: string; review?: ReviewState; busy: boolean },
    private invoke: (command: string, value?: unknown) => Promise<unknown>,
    private native: (request: ReviewRequest) => Promise<void>) {}
  get state(): ReviewEditorState { return this.model; }
  async open(request: ReviewRequest, current: () => boolean) {
    await this.reviews.editorFiles(request);
    if (!current()) return;
    this.scope = { ...request }; this.signature = ''; this.version++;
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('agentTandem.review', 'AgentTandem · Review', vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')] });
      this.panel = panel;
      const resource = (folder: string, file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, folder, file)).toString();
      panel.webview.html = reviewWebviewHtml({ script: resource('dist', 'review-webview.js'), monacoStyle: resource('dist', 'review-webview.css'), worker: resource('dist', 'review-editor-worker.js'), style: resource('media', 'review-editor.css'), icons: resource('media', 'codicons/codicon.css'), cspSource: panel.webview.cspSource, nonce: randomBytes(18).toString('base64') });
      this.listeners.push(panel.onDidDispose(() => { if (this.panel === panel) this.close(); }),
        panel.onDidChangeViewState(() => { if (panel.visible) this.update(); }),
        panel.webview.onDidReceiveMessage(message => { void this.handle(message); }));
    } else this.panel.reveal(vscode.ViewColumn.Active);
    await this.load();
  }
  update() {
    if (!this.panel || !this.scope) return;
    const current = this.current();
    const busy = this.acting || current.busy || !!current.review?.busy;
    if (current.project !== this.scope.project) {
      this.version++; this.signature = ''; this.model = { files: [], busy: false, notice: 'The workspace changed. Open its pending changes from Review.' }; this.post(); return;
    }
    this.model = { ...this.model, busy, undo: current.review?.undo }; this.post();
    if (busy) return;
    const signature = `${current.project}:${current.review?.revision}:${this.scope.group ?? ''}:${this.scope.file ?? ''}`;
    if (signature === this.signature) return;
    clearTimeout(this.pending); const version = ++this.version;
    this.pending = setTimeout(() => { if (version === this.version) void this.load().catch(error => this.error(error)); }, 30);
  }
  private async load(navigation?: 'first' | 'last') {
    clearTimeout(this.pending);
    const version = ++this.version, scope = this.scope, current = this.current();
    if (!this.panel || !scope || current.project !== scope.project) return;
    if (current.busy || current.review?.busy) { this.update(); return; }
    const revision = current.review?.revision;
    const files = (current.review?.files ?? []).filter(file => !scope.group || reviewGroup(file) === scope.group);
    const oldIndex = this.model.files.findIndex(file => file.path === scope.file);
    const selected = files.find(file => file.path === scope.file) ?? files[Math.min(Math.max(0, oldIndex), files.length - 1)];
    const file = selected && revision ? await this.reviews.webviewFile({ project: scope.project, revision, file: selected.path, group: scope.group }) : undefined;
    const latest = this.current();
    if (version !== this.version || !this.panel || latest.project !== scope.project || latest.review?.revision !== revision) { this.update(); return; }
    this.scope = { ...scope, revision: revision ?? scope.revision, file: selected?.path };
    this.signature = `${scope.project}:${revision}:${scope.group ?? ''}:${selected?.path ?? ''}`;
    this.model = { project: scope.project, revision, group: scope.group, files: files.map(({ path, kind, additions, deletions }) => ({ path, kind, additions, deletions })), file, busy: this.acting || latest.busy, undo: latest.review?.undo, navigation,
      ...(!files.length ? { notice: 'All changes in this review have been reviewed.' } : {}) };
    this.panel.title = file ? `${file.path.split(/[\\/]/).pop()} · AgentTandem Review` : 'AgentTandem · Review';
    this.post();
  }
  private post(force = false) {
    if (!this.panel) return;
    // Snapshot text is immutable for a revision; unrelated chat/usage updates
    // must not resend megabytes of source or disturb the reading position.
    const key = JSON.stringify([this.model.project, this.model.revision, this.model.group, this.model.file?.path, this.model.busy, this.model.error, this.model.notice, this.model.undo?.id, this.model.navigation]);
    if (!force && key === this.posted) return;
    this.posted = key; void this.panel.webview.postMessage({ type: 'state', state: this.model });
  }
  private error(error: unknown) { this.model = { ...this.model, error: error instanceof Error ? error.message : String(error), busy: false }; this.post(); }
  private async handle(message: unknown) {
    if (!message || typeof message !== 'object' || !this.panel) return;
    const data = message as Record<string, unknown>;
    if (data.type === 'ready') { this.post(true); return; }
    if (this.acting) return;
    try {
      const current = this.current(), scope = this.scope;
      if (!scope || scope.project !== current.project || data.revision !== this.model.revision || data.revision !== current.review?.revision) throw new Error('Changes updated. Review the refreshed diff before deciding.');
      if (current.busy || current.review?.busy) throw new Error('Wait for the agent and change capture to finish.');
      if (data.type === 'selectFile') {
        if (typeof data.file !== 'string' || !this.model.files.some(file => file.path === data.file)) throw new Error('Choose a file in this review.');
        this.scope = { ...scope, file: data.file }; await this.load(data.navigation === 'last' ? 'last' : 'first'); return;
      }
      if (data.type === 'refresh') { await this.invoke('agentTandem.refreshReview'); await this.load(); return; }
      if (data.type === 'undo') { if (this.model.undo) await this.invoke('agentTandem.undoRevert', { project: scope.project, id: this.model.undo.id }); await this.load(); return; }
      const file = this.model.file;
      if (!file || data.file !== file.path) throw new Error('Choose the current file change.');
      const request: ReviewRequest = { project: scope.project, revision: this.model.revision!, group: scope.group, file: file.path };
      if (data.type === 'native') { await this.native(request); return; }
      if (data.type !== 'accept' && data.type !== 'reject') throw new Error('Unsupported review action.');
      if (data.hunk !== undefined && (typeof data.hunk !== 'string' || !file.hunks.some(hunk => hunk.id === data.hunk))) throw new Error('This block is no longer pending.');
      this.acting = true; this.model = { ...this.model, busy: true, error: undefined }; this.post();
      // Whole-file rejection discloses its scope; block rejection matches native review.
      if (data.type === 'reject' && data.hunk === undefined) {
        const answer = await vscode.window.showWarningMessage(`Revert all pending changes in ${file.path}?`, { modal: true, detail: 'Restore this file to its saved review baseline. Newer edits are checked before writing.' }, 'Revert file');
        if (answer !== 'Revert file') return;
      }
      await this.invoke(data.type === 'accept' ? 'agentTandem.acceptChanges' : 'agentTandem.revertChanges', { ...request, ...(data.hunk !== undefined ? { hunk: data.hunk } : {}) });
    } catch (error) { this.error(error); }
    finally {
      this.acting = false;
      const error = this.model.error;
      try { await this.load(); if (error) this.error(error); } catch (error) { this.error(error); }
    }
  }
  private close() {
    clearTimeout(this.pending); this.version++; this.panel = undefined; this.scope = undefined; this.signature = ''; this.posted = ''; this.model = { files: [], busy: false };
    for (const listener of this.listeners.splice(0)) listener.dispose();
  }
  dispose() { const panel = this.panel; this.close(); panel?.dispose(); }
}
