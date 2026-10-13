import * as vscode from 'vscode';
import { useReviewDiffLayout } from './diff-layout';
import type { ChangeNavigation } from './change-navigation';
import { assertPath, decodeText, type HistoryStore } from '../core/history';
import type { ReviewStore, ReviewRequest } from '../core/review';
import { imageMime } from '../core/media-preview';

export function reviewSnapshotUri(hash: string | undefined, file: string): vscode.Uri {
  assertPath(file);
  if (hash !== undefined && !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid review snapshot.');
  return vscode.Uri.from({ scheme: 'agenttandem-review', authority: hash ?? 'empty', path: `/${file}` });
}

/** Immutable before/after documents also remain readable after Accept or reload. */
export class ReviewDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private edits = vscode.workspace.onDidChangeTextDocument(event => {
    if (event.document.uri.scheme === 'agenttandem-review' && event.contentChanges.length) this.emitter.fire(event.document.uri);
  });
  constructor(private history: HistoryStore) {}
  dispose() { this.edits.dispose(); this.emitter.dispose(); }
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const hash = this.blob(uri);
    if (!hash) return '';
    const bytes = await this.history.readBlob(hash);
    return decodeText(bytes) ?? `[Binary snapshot]\nFile: ${uri.path.slice(1)}\nSize: ${bytes.length} bytes\nSHA-256: ${hash}\n`;
  }
  blob(uri: vscode.Uri): string | undefined {
    assertPath(uri.path.slice(1));
    if (uri.scheme !== 'agenttandem-review' || uri.query || uri.fragment) throw new Error('Invalid review resource.');
    if (uri.authority === 'empty') return;
    if (!/^[a-f0-9]{64}$/.test(uri.authority)) throw new Error('Invalid review snapshot.');
    return uri.authority;
  }
}

export async function openReviewChanges(reviews: ReviewStore, request: ReviewRequest, navigation: ChangeNavigation, current: () => boolean = () => true): Promise<void> {
  const files = await reviews.editorFiles({ ...request, file: undefined });
  const selectedIndex = request.file ? files.findIndex(file => file.path === request.file) : 0;
  if (selectedIndex < 0) throw new Error('Choose a pending file change.');
  const comparisons = files.map(file => ({ file: file.path, original: reviewSnapshotUri(file.before, file.path), modified: reviewSnapshotUri(file.after, file.path), review: { project: request.project, revision: request.revision, ...(request.group ? { group: request.group } : {}) } }));
  if (!current()) return;
  if (request.file || files.length === 1 || files.some(file => imageMime(file.path))) {
    await navigation.openFile(comparisons, 'AgentTandem changes', selectedIndex);
    return;
  }
  // Give empty add/delete sides stable identities too, so native navigation
  // can identify the current file instead of an anonymous synthetic buffer.
  const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = files.map(file => [
    vscode.Uri.joinPath(vscode.Uri.file(request.project), file.path),
    reviewSnapshotUri(file.before, file.path),
    reviewSnapshotUri(file.after, file.path),
  ]);
  const commands = await vscode.commands.getCommands(true);
  if (!current()) return;
  if (commands.includes('vscode.changes')) {
    await useReviewDiffLayout();
    if (!current()) return;
    navigation.prepareOpen();
    await vscode.commands.executeCommand('vscode.changes', 'AgentTandem · Pending changes', resources);
    await navigation.track(comparisons, 'AgentTandem · Pending changes');
    return;
  }
  const selected = await vscode.window.showQuickPick(files.map(file => ({ label: file.path, description: file.kind })), { title: 'AgentTandem · Pending changes' });
  if (selected && current()) await openReviewChanges(reviews, { ...request, file: selected.label }, navigation, current);
}
