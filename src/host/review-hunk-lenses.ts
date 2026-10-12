import * as vscode from 'vscode';
import type { ReviewHunk } from '../core/review-hunks';

export interface HunkLensTarget { project: string; revision: string; file: string; files: number; hunks: ReviewHunk[] }

/**
 * Accept/Reject/Next sit on code lenses above each pending block, so released
 * VS Code builds render them without the proposed editor-inset API.
 */
export class ReviewHunkLenses implements vscode.CodeLensProvider, vscode.Disposable {
  private changes = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changes.event;
  private registration = vscode.languages.registerCodeLensProvider({ scheme: 'agentdock-review' }, this);
  constructor(private resolve: (document: vscode.TextDocument) => Promise<HunkLensTarget | undefined>) {}

  refresh() { this.changes.fire(); }

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const target = await this.resolve(document);
    if (!target || token.isCancellationRequested) return [];
    const { project, revision, file, hunks } = target;
    const last = Math.max(document.lineCount - 1, 0);
    return hunks.flatMap((hunk, index) => {
      const line = Math.min(Math.max(hunk.newLine, 0), last);
      const range = new vscode.Range(line, 0, line, 0);
      // Bind every action to this immutable hunk and revision, never to the cursor.
      const request = { project, revision, file, hunk: hunk.id, line };
      const place = `block ${index + 1} of ${hunks.length} in ${file}`;
      const lenses = [
        new vscode.CodeLens(range, { title: '$(check) Accept', tooltip: `Keep ${place} and mark it reviewed`, command: 'agentDock.acceptHunk', arguments: [request] }),
        new vscode.CodeLens(range, { title: '$(discard) Reject', tooltip: `Reject ${place} and restore its previous content`, command: 'agentDock.rejectHunk', arguments: [request] }),
      ];
      if (hunks.length > 1 || target.files > 1) lenses.push(new vscode.CodeLens(range,
        { title: '$(arrow-down) Next change', tooltip: 'Go to the next change, continuing into the next changed file', command: 'agentDock.nextChange' }));
      lenses.push(new vscode.CodeLens(range, { title: `Block ${index + 1}/${hunks.length}`, command: '' }));
      return lenses;
    });
  }

  dispose() { this.registration.dispose(); this.changes.dispose(); }
}
