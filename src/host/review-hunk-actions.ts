import * as vscode from 'vscode';
import type { ReviewStore, ReviewState, ReviewHunkRequest } from '../core/review';
import type { ReviewHunk } from '../core/review-hunks';
import type { ChangeNavigation } from './change-navigation';
import { reviewSnapshotUri } from './review-editor';
import { ReviewHunkLenses, type HunkLensTarget } from './review-hunk-lenses';
import { ReviewBlockCard } from './review-block-card';
import { blockActionsStyle } from './diff-layout';

type BlockRequest = ReviewHunkRequest & { line: number };
interface EditorCards { key: string; cards: Map<string, ReviewBlockCard> }

/** Each pending block owns revision-bound Accept/Reject actions inside the editor. */
export class ReviewHunkActions implements vscode.Disposable {
  private listeners: vscode.Disposable[];
  private pending: ReturnType<typeof setTimeout> | undefined;
  private version = 0;
  private deciding = false;
  private cache = new Map<string, Promise<ReviewHunk[]>>();
  private lenses = new ReviewHunkLenses(document => this.lensTarget(document));
  private signature = '';
  private target: (ReviewHunkRequest & { line: number; uri: string }) | undefined;
  private editors = new Map<vscode.TextEditor, EditorCards>();
  private insets = typeof vscode.window.createWebviewTextEditorInset === 'function';
  constructor(
    private reviews: ReviewStore,
    private navigation: ChangeNavigation,
    private state: () => { project?: string; review?: ReviewState; busy: boolean },
    private decide: (request: ReviewHunkRequest, revert: boolean) => Promise<void>,
    private report: (error: unknown) => void,
  ) {
    this.listeners = [
      this.lenses,
      navigation.onDidChange(() => this.update()),
      navigation.onWillOpen(() => this.clear()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.update()),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.update()),
      vscode.window.onDidChangeTextEditorSelection(() => this.update()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.update()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('agentTandem.blockActionsStyle')) return;
        this.clearCards(); this.lenses.refresh(); this.update();
      }),
      // One lens click decides exactly the block it was rendered for.
      ...([['acceptHunk', false], ['rejectHunk', true]] as const).map(([name, revert]) => vscode.commands.registerCommand(`agentTandem.${name}`, async (value: unknown) => {
        const request = this.request(value);
        if (request) await this.actOnBlock(request, revert);
      })),
      // Keyboard review keeps acting on the block under the cursor.
      ...(['accept', 'revert'] as const).map(action => vscode.commands.registerCommand(`agentTandem.${action}CurrentChange`, async () => {
        const target = this.target, editor = vscode.window.activeTextEditor;
        if (!target || !editor || target.uri !== editor.document.uri.toString() || target.line !== editor.selection.active.line) return;
        await this.act(editor, target, action === 'revert');
      })),
    ];
    this.update();
  }
  private request(value: unknown): BlockRequest | undefined {
    const request = value as Partial<BlockRequest> | undefined;
    if (!request || typeof request.project !== 'string' || typeof request.revision !== 'string'
      || typeof request.file !== 'string' || typeof request.hunk !== 'string') return;
    const line = Number.isInteger(request.line) && request.line! >= 0 ? request.line! : 0;
    return { project: request.project, revision: request.revision, file: request.file, hunk: request.hunk, line };
  }
  private current(project: string, revision: string, file: string, editor: vscode.TextEditor) {
    const state = this.state(), pending = state.review?.files.find(item => item.path === file);
    const comparison = this.navigation.comparisons().find(item => item.file === file);
    return !!(pending && state.project === project && state.review?.revision === revision &&
      comparison?.review?.project === project && comparison.review.revision === revision &&
      comparison.original.toString() === reviewSnapshotUri(pending.before, file).toString() &&
      comparison.modified.toString() === reviewSnapshotUri(pending.after, file).toString() &&
      editor.document.uri.toString() === comparison.modified.toString() && vscode.window.visibleTextEditors.includes(editor));
  }
  private async actOnBlock(request: BlockRequest, revert: boolean) {
    const state = this.state(), file = state.review?.files.find(item => item.path === request.file);
    const uri = file ? reviewSnapshotUri(file.after, file.path).toString() : undefined;
    const editor = uri ? vscode.window.visibleTextEditors.find(item => item.document.uri.toString() === uri) : undefined;
    if (!editor) { this.update(); return; }
    await this.act(editor, request, revert);
  }
  private async act(editor: vscode.TextEditor, request: ReviewHunkRequest & { line?: number }, revert: boolean) {
    // A stale lens belongs to a replaced revision; refresh instead of writing files.
    if (this.deciding || this.state().busy || !this.current(request.project, request.revision, request.file, editor)) { this.update(); return; }
    this.deciding = true; this.target = undefined; this.clear();
    try { await this.decide(request, revert); } catch (error) { this.report(error); }
    finally { this.deciding = false; this.update(); }
  }
  private hunks(project: string, revision: string, file: string) {
    const key = `${project}:${revision}:${file}`;
    for (const entry of this.cache.keys()) if (!entry.startsWith(`${project}:${revision}:`)) this.cache.delete(entry);
    let job = this.cache.get(key);
    if (!job) { job = this.reviews.hunks({ project, revision, file }); this.cache.set(key, job); }
    return job;
  }
  /** Cards own the editor whenever insets work, so both styles never stack up. */
  private get cardsActive() { return blockActionsStyle() === 'auto' && this.insets; }
  private async lensTarget(document: vscode.TextDocument): Promise<HunkLensTarget | undefined> {
    if (blockActionsStyle() === 'off' || this.cardsActive) return;
    const state = this.state();
    if (!state.project || !state.review || state.busy || this.deciding) return;
    const project = state.project, review = state.review;
    const file = review.files.find(item => document.uri.toString() === reviewSnapshotUri(item.after, item.path).toString());
    const editor = vscode.window.visibleTextEditors.find(item => item.document === document);
    if (!file || !editor || !this.current(project, review.revision, file.path, editor)) return;
    try {
      const hunks = await this.hunks(project, review.revision, file.path);
      // A later turn or decision can land while this provider awaits.
      if (!this.current(project, review.revision, file.path, editor)) return;
      return { project, revision: review.revision, file: file.path, files: this.navigation.comparisons().length, hunks };
    } catch {
      // Binary/large/stale files retain the existing file-level sidebar actions.
      return;
    }
  }
  update() {
    clearTimeout(this.pending);
    const version = ++this.version;
    this.target = undefined;
    void vscode.commands.executeCommand('setContext', 'agentTandem.canDecideHunk', false);
    const state = this.state();
    if (!state.project || !state.review || state.busy || this.deciding) { this.clear(); return; }
    const project = state.project, review = state.review;
    const candidates = vscode.window.visibleTextEditors.flatMap(editor => {
      const file = review.files.find(file => editor.document.uri.toString() === reviewSnapshotUri(file.after, file.path).toString());
      return file && this.current(project, review.revision, file.path, editor) ? [{ editor, file: file.path }] : [];
    });
    for (const editor of this.editors.keys()) if (!candidates.some(item => item.editor === editor)) this.removeEditor(editor);
    void vscode.commands.executeCommand('setContext', 'agentTandem.reviewChange', candidates.length > 0);
    this.publish(`${project}:${review.revision}:${candidates.map(item => item.file).sort().join('|')}`);
    if (!candidates.length) return;
    this.pending = setTimeout(() => {
      void Promise.all(candidates.map(({ editor, file }) => this.follow(version, project, review, editor, file)));
    }, 100);
  }
  /** Re-render lenses only when the pending revision or the reviewed editors change. */
  private publish(signature: string) {
    if (signature === this.signature) return;
    this.signature = signature; this.lenses.refresh();
  }
  private async follow(version: number, project: string, review: ReviewState, editor: vscode.TextEditor, file: string) {
    try {
      const hunks = await this.hunks(project, review.revision, file);
      if (version !== this.version || !this.current(project, review.revision, file, editor)) return;
      this.mount(project, review, editor, file, hunks);
      if (editor !== vscode.window.activeTextEditor) return;
      const line = editor.selection.active.line;
      const hunk = hunks.find(item => { const start = Math.min(item.newLine, editor.document.lineCount - 1); return line >= start && line < start + Math.max(1, item.newLines); });
      this.target = hunk ? { project, revision: review.revision, file, hunk: hunk.id, line, uri: editor.document.uri.toString() } : undefined;
      void vscode.commands.executeCommand('setContext', 'agentTandem.canDecideHunk', !!hunk);
    } catch {
      // Binary/large/stale files retain the existing file-level sidebar actions.
      this.removeEditor(editor);
    }
  }
  private mount(project: string, review: ReviewState, editor: vscode.TextEditor, file: string, hunks: ReviewHunk[]) {
    if (!this.cardsActive) { this.removeEditor(editor); return; }
    const key = `${project}:${review.revision}:${file}`;
    let blocks = this.editors.get(editor);
    if (blocks?.key !== key) { this.removeEditor(editor); blocks = { key, cards: new Map() }; this.editors.set(editor, blocks); }
    // Mount controls near the viewport; retain a generous margin to avoid scroll churn.
    const visible = hunks.filter(hunk => editor.visibleRanges.some(range => hunk.newLine >= range.start.line - 80 && hunk.newLine <= range.end.line + 80));
    for (const [id, card] of blocks.cards) if (!visible.some(hunk => hunk.id === id)) { blocks.cards.delete(id); card.dispose(); }
    for (const hunk of visible) {
      if (blocks.cards.has(hunk.id)) continue;
      const request = { project, revision: review.revision, file, hunk: hunk.id, line: hunk.newLine };
      const collection = blocks;
      try {
        const card = new ReviewBlockCard(editor, hunk, hunks.indexOf(hunk), hunks.length, hunks.length > 1 || this.navigation.comparisons().length > 1,
          action => { if (action === 'next') void vscode.commands.executeCommand('agentTandem.nextChange'); else void this.act(editor, request, action === 'revert'); },
          () => collection.cards.delete(hunk.id));
        blocks.cards.set(hunk.id, card);
      } catch {
        // The inset API is proposed and can be unavailable; keep review usable.
        this.insets = false; this.clearCards(); this.lenses.refresh(); return;
      }
    }
  }
  private removeEditor(editor: vscode.TextEditor) {
    const blocks = this.editors.get(editor); this.editors.delete(editor);
    if (blocks) for (const card of blocks.cards.values()) card.dispose();
  }
  private clearCards() { for (const editor of [...this.editors.keys()]) this.removeEditor(editor); }
  private clear() {
    clearTimeout(this.pending); this.version++; this.target = undefined;
    this.clearCards(); this.publish('');
    void vscode.commands.executeCommand('setContext', 'agentTandem.reviewChange', false);
    void vscode.commands.executeCommand('setContext', 'agentTandem.canDecideHunk', false);
  }
  dispose() {
    this.clear(); this.cache.clear();
    for (const listener of this.listeners) listener.dispose();
  }
}
