import * as vscode from 'vscode';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { HistoryStore } from '../core/history';
import { assertPath, decodeText } from '../core/history';
import type { Session, ViewState } from '../core/types';
import type { Selection } from '../core/change-preview';
import { panelHtml } from './panel-html';
import type { ChangeNavigation } from './change-navigation';
export type { Selection } from '../core/change-preview';

export function snapshotUri(sessionId: string, snapshotId: string, file: string): vscode.Uri {
  assertPath(file);
  return vscode.Uri.from({ scheme: 'agenttandem-snapshot', authority: sessionId, path: `/${snapshotId}/${file}` });
}

export class SnapshotDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private edits = vscode.workspace.onDidChangeTextDocument(event => {
    // Readonly UI does not stop another extension from using WorkspaceEdit.
    // Refresh our historical buffer from immutable storage, never from live files.
    if (event.document.uri.scheme === 'agenttandem-snapshot' && event.contentChanges.length) this.emitter.fire(event.document.uri);
  });
  constructor(private history: HistoryStore, private sessions: () => Session[]) {}
  dispose() { this.edits.dispose(); this.emitter.dispose(); }
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const session = this.sessions().find(item => item.id === uri.authority);
    const [snapshotId, ...segments] = uri.path.slice(1).split('/');
    if (!session || !snapshotId || uri.query || uri.fragment) throw new Error('Unknown snapshot resource.');
    const known = new Set([session.baseline, ...session.steps.flatMap(step => [step.before, ...(step.after ? [step.after] : [])])]);
    if (!known.has(snapshotId)) throw new Error('Snapshot does not belong to this session.');
    const file = segments.join('/');
    assertPath(file);
    const manifest = await this.history.snapshot(snapshotId);
    const hash = Object.hasOwn(manifest.files, file) ? manifest.files[file] : undefined;
    if (!hash) return ''; // Empty side of a real add/delete comparison.
    const bytes = await this.history.readBlob(hash);
    return decodeText(bytes) ?? `[Binary snapshot]\nFile: ${file}\nSize: ${bytes.length} bytes\nSHA-256: ${hash}\n\nBinary content is preserved; this preview shows metadata only.\n`;
  }
}

export function selectionFrom(value: unknown): Selection {
  if (!value || typeof value !== 'object') throw new Error('Choose a recorded step first.');
  const item = value as Record<string, unknown>;
  if (typeof item.sessionId !== 'string' || typeof item.stepId !== 'string' || (item.file !== undefined && typeof item.file !== 'string')) throw new Error('Invalid step selection.');
  return { sessionId: item.sessionId, stepId: item.stepId, file: item.file as string | undefined };
}

export async function openChanges(history: HistoryStore, sessions: Session[], selected: Selection,
  cumulative: boolean, navigation: ChangeNavigation, forceSingle = false): Promise<void> {
  const session = sessions.find(item => item.id === selected.sessionId);
  const step = session?.steps.find(item => item.id === selected.stepId);
  if (!session || !step?.after) throw new Error('This step has no complete after-snapshot.');
  const before = cumulative ? session.baseline : step.before;
  const changes = await history.changes(before, step.after);
  const filtered = selected.file ? changes.filter(change => change.path === selected.file) : changes;
  if (selected.file && !filtered.length) throw new Error('This file has no changes at the selected step.');
  if (!filtered.length) { await vscode.window.showInformationMessage('No file changes at this step. Inspect its output in AgentTandem.'); return; }
  const title = `${cumulative ? 'Cumulative' : 'Step'} · ${step.title}`;
  const uri = (snapshot: string, file: string) => snapshotUri(session.id, snapshot, file);
  const comparisons = changes.map(file => ({ file: file.path, original: uri(before, file.path), modified: uri(step.after!, file.path) }));
  if (filtered.length === 1 || forceSingle) {
    const file = filtered[0]!;
    await navigation.openFile(comparisons, title, changes.findIndex(change => change.path === file.path));
  } else {
    const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = filtered.map(file => [
      uri(step.after!, file.path), uri(before, file.path), uri(step.after!, file.path),
    ]);
    const available = await vscode.commands.getCommands(true);
    if (available.includes('vscode.changes')) {
      try { await vscode.commands.executeCommand('vscode.changes', `AgentTandem · ${title}`, resources); await navigation.track(comparisons, `AgentTandem · ${title}`); return; }
      catch { /* Older changes-editor versions can fall back to a file picker. */ }
    }
    const file = await vscode.window.showQuickPick(filtered.map(change => ({ label: change.path, description: change.kind })), { title });
    if (file) await openChanges(history, sessions, { ...selected, file: file.label }, cumulative, navigation, true);
  }
}

export class TandemView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private tab?: vscode.WebviewPanel;
  private subscriptions: vscode.Disposable[] = [];
  constructor(private readonly extensionUri: vscode.Uri, private readonly state: () => ViewState,
    private readonly invoke: (command: string, selection?: unknown) => Promise<unknown>,
    private readonly report: (error: unknown) => void) {}
  get resolved() { return !!this.view; }
  async open() {
    await vscode.commands.executeCommand('agentTandem.panel.focus');
    this.view?.show(false); this.update();
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.configure(view.webview, false);
    this.subscriptions.push(view.onDidDispose(() => { if (this.view === view) this.view = undefined; }));
    this.subscriptions.push(view.onDidChangeVisibility(() => { if (view.visible) this.update(); }));
    this.update();
  }
  openInTab() {
    if (this.tab) { this.tab.reveal(); this.update(); return; }
    const tab = vscode.window.createWebviewPanel('agentTandem.preview', 'AgentTandem', vscode.ViewColumn.One, { enableScripts: true });
    this.tab = tab; this.configure(tab.webview, true);
    this.subscriptions.push(tab.onDidDispose(() => { this.tab = undefined; }));
    this.update();
  }
  private configure(webview: vscode.Webview, editorTab: boolean) {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')] };
    const resource = (folder: string, file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, folder, file)).toString();
    webview.html = panelHtml({ script: resource('dist', 'webview.js'), style: resource('media', 'panel.css'), icons: resource('media', 'codicons/codicon.css'), claude: resource('media', 'claude.svg'), codex: resource('media', 'codex.svg'), cspSource: webview.cspSource, nonce: randomBytes(18).toString('base64') }, editorTab);
    const bridge = webview.onDidReceiveMessage(async (message: unknown) => {
      try {
        if (!message || typeof message !== 'object') throw new Error('Invalid request.');
        const data = message as Record<string, unknown>;
        if (data.type === 'ready') { this.update(); return; }
        const commands: Record<string, string> = { demo: 'agentTandem.runDemo', stop: 'agentTandem.stop', probe: 'agentTandem.checkProviders', step: 'agentTandem.openStep', cumulative: 'agentTandem.openCumulative', file: 'agentTandem.openFile', sync: 'agentTandem.syncConversations', conversation: 'agentTandem.openConversation', screen: 'agentTandem.showSection', previewFile: 'agentTandem.previewFile', tab: 'agentTandem.openInTab', 'editor-step': 'agentTandem.openStepInEditor', 'editor-file': 'agentTandem.openFileInEditor', 'editor-cumulative': 'agentTandem.openCumulativeInEditor' };
        const type = String(data.type);
        Object.assign(commands, { previewCheckpoint: 'agentTandem.previewCheckpoint', restoreCheckpoint: 'agentTandem.restoreCheckpoint', closeCheckpointPreview: 'agentTandem.closeCheckpointPreview' });
        Object.assign(commands, { sendChat: 'agentTandem.sendChat', newChat: 'agentTandem.newChat', setAccessMode: 'agentTandem.setAccessMode', setModel: 'agentTandem.setModel', setReasoningEffort: 'agentTandem.setReasoningEffort', chooseCLI: 'agentTandem.chooseCLI', cliAction: 'agentTandem.cliAction', refreshCLIs: 'agentTandem.refreshCLIs', refreshModels: 'agentTandem.refreshModels', stopChat: 'agentTandem.stopChat', answerAgent: 'agentTandem.answerAgent', acceptChanges: 'agentTandem.acceptChanges', revertChanges: 'agentTandem.revertChanges', previewReview: 'agentTandem.previewReview', closeReviewPreview: 'agentTandem.closeReviewPreview', refreshReview: 'agentTandem.refreshReview' });
        commands.setFastMode = 'agentTandem.setFastMode';
        commands.refreshAccount = 'agentTandem.refreshAccount';
        commands.queueAction = 'agentTandem.queueAction';
        commands.settings = 'agentTandem.openSettings';
        commands.toggleExternalReview = 'agentTandem.toggleExternalReview';
        commands.trackingControls = 'agentTandem.trackingControls';
        commands.gettingStarted = 'agentTandem.gettingStarted';
        commands.captureExternalChanges = 'agentTandem.captureExternalChanges';
        commands.previewRevert = 'agentTandem.previewRevert';
        commands.confirmRevert = 'agentTandem.confirmRevert';
        commands.cancelRevert = 'agentTandem.cancelRevert';
        commands.undoRevert = 'agentTandem.undoRevert';
        commands.reviewLatest = 'agentTandem.reviewLatest';
        if (!Object.hasOwn(commands, type)) throw new Error('Unsupported request.');
        const selected = ['step', 'cumulative', 'file', 'editor-step', 'editor-file', 'editor-cumulative'].includes(type) ? selectionFrom(data.selection) : data.selection;
        await this.invoke(commands[type]!, selected);
      } catch (error) { this.report(error); }
    });
    this.subscriptions.push(bridge);
  }
  update() {
    const message = { type: 'state', state: this.state() };
    if (this.view) {
      const count = message.state.review?.files.length ?? 0;
      this.view.badge = count ? { value: count, tooltip: `${count} files pending review` } : undefined;
      void this.view.webview.postMessage(message);
    }
    if (this.tab) void this.tab.webview.postMessage(message);
  }
  dispose() { for (const item of this.subscriptions.splice(0)) item.dispose(); this.tab?.dispose(); }
}
