import * as vscode from 'vscode';
import { useReviewDiffLayout } from './diff-layout';
import path from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { ChangeFileBadge } from './change-file-badge';

export interface ChangeComparison { file: string; original: vscode.Uri; modified: vscode.Uri; review?: { project: string; revision: string; group?: string } }
interface Scope { files: ChangeComparison[]; title: string; index: number }
interface SavedScope { files: { file: string; original: string; modified: string; review?: { project: string; revision: string; group?: string } }[]; title: string; index: number }
export interface ChangeNavigationState { file: string; index: number; total: number }
const owns = (uri: vscode.Uri) => uri.scheme === 'agenttandem-review' || uri.scheme === 'agenttandem-snapshot';
const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;
const same = (left: vscode.Uri, right: vscode.Uri) => left.toString() === right.toString();
function kind(tab: vscode.Tab | undefined): 'single' | 'multi' | undefined {
  if (tab?.input instanceof vscode.TabInputTextDiff) return owns(tab.input.original) && owns(tab.input.modified) ? 'single' : undefined;
  const input = tab?.input as { textDiffs?: unknown } | undefined;
  if (tab?.label.startsWith('AgentTandem · ') && (input === undefined || Array.isArray(input?.textDiffs))) return 'multi';
  return undefined;
}

export class ChangeNavigation {
  private changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private opening = new vscode.EventEmitter<void>();
  readonly onWillOpen = this.opening.event;
  private scopes = new WeakMap<vscode.Tab, Scope>();
  private saved: Scope[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private saves: Promise<unknown> = Promise.resolve();
  private storageFile: string;
  private counter = vscode.window.createStatusBarItem('agentTandem.changeCount', vscode.StatusBarAlignment.Right, 110);
  private badge = new ChangeFileBadge(() => this.chooseFile());
  constructor(private context: vscode.ExtensionContext) {
    this.storageFile = path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'change-navigation.json');
    this.counter.name = 'AgentTandem change file count';
    this.counter.command = 'agentTandem.chooseChangedFile';
    context.subscriptions.push(this.counter, this.badge, this.changes, this.opening,
      vscode.window.tabGroups.onDidChangeTabs(event => { this.update(); if (event.closed.length) void this.persist(); }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.update()),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('agentTandem.showFileCounterInEditor')) this.update(); }),
      vscode.window.onDidChangeTextEditorSelection(() => this.update()));
    for (const direction of ['previous', 'next'] as const) context.subscriptions.push(vscode.commands.registerCommand(`agentTandem.${direction}Change`, () => {
      const job = this.queue.then(() => this.navigate(direction));
      this.queue = job.catch(() => undefined);
      return job;
    }));
    for (const direction of ['previous', 'next'] as const) context.subscriptions.push(vscode.commands.registerCommand(`agentTandem.${direction}File`, (anchor?: unknown) => {
      const job = this.queue.then(() => this.navigateFile(direction, anchor));
      this.queue = job.catch(() => undefined); return job;
    }));
    context.subscriptions.push(vscode.commands.registerCommand('agentTandem.chooseChangedFile', () => this.chooseFile()));
    this.update();
  }
  async restore() {
    const data: unknown = await readFile(this.storageFile, 'utf8').then(text => JSON.parse(text)).catch(() => []);
    this.saved = (Array.isArray(data) ? data as SavedScope[] : []).flatMap(saved => {
      try {
        const files = saved.files.map(file => ({ file: file.file, original: vscode.Uri.parse(file.original), modified: vscode.Uri.parse(file.modified),
          review: typeof file.review?.project === 'string' && typeof file.review?.revision === 'string' ? file.review : undefined }));
        return typeof saved.title === 'string' && files.length && files.every(file => owns(file.original) && owns(file.modified)) ? [{ files, title: saved.title, index: saved.index ?? 0 }] : [];
      } catch { return []; }
    });
    this.scopes = new WeakMap(); this.update();
  }
  private scope(tab: vscode.Tab | undefined): Scope | undefined {
    if (!tab || !kind(tab)) return;
    const known = this.scopes.get(tab);
    if (known) return known;
    const input = tab.input;
    const restored = this.saved.find(scope => input instanceof vscode.TabInputTextDiff
      ? scope.files.some(file => same(file.original, input.original) && same(file.modified, input.modified))
      : tab.label === scope.title || tab.label.startsWith(`${scope.title} (`));
    if (restored) { this.scopes.set(tab, restored); return restored; }
    if (input instanceof vscode.TabInputTextDiff) {
      const fallback = { files: [{ file: path.basename(input.modified.path), original: input.original, modified: input.modified }], title: 'AgentTandem changes', index: 0 };
      this.scopes.set(tab, fallback); return fallback;
    }
  }
  private index(scope: Scope, tab: vscode.Tab): number {
    const input = tab.input;
    if (input instanceof vscode.TabInputTextDiff) return scope.files.findIndex(file => same(file.original, input.original) && same(file.modified, input.modified));
    const uri = vscode.window.activeTextEditor?.document.uri;
    const index = uri ? scope.files.findIndex(file => same(file.modified, uri) || same(file.original, uri)) : -1;
    return index >= 0 ? index : Math.min(scope.index, scope.files.length - 1);
  }
  state(): ChangeNavigationState | undefined {
    const tab = activeTab(), scope = this.scope(tab);
    if (!tab || !scope) return;
    const index = this.index(scope, tab), file = scope.files[index];
    if (file) return { file: file.file, index: index + 1, total: scope.files.length };
  }
  comparison(): ChangeComparison | undefined {
    const tab = activeTab(), scope = this.scope(tab);
    return tab && scope ? scope.files[this.index(scope, tab)] : undefined;
  }
  comparisons(): readonly ChangeComparison[] {
    const tab = activeTab(); return this.scope(tab)?.files ?? [];
  }
  /** Refresh pending scopes and retire reviewed snapshots without touching saved-step diffs. */
  async refreshReview(project: string, files: ChangeComparison[], preserve?: vscode.Tab) {
    const retired: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) {
      const scope = this.scope(tab);
      if (!scope?.files.some(file => file.review?.project === project)) continue;
      const scopeGroup = scope.files[0]?.review?.group;
      const scoped = files.filter(file => !scopeGroup || file.review?.group === scopeGroup).map(file => ({ ...file, review: file.review ? { ...file.review, group: scopeGroup } : undefined }));
      const input = tab.input;
      const index = input instanceof vscode.TabInputTextDiff
        ? scoped.findIndex(file => same(file.original, input.original) && same(file.modified, input.modified)) : -1;
      if (index >= 0) this.scopes.set(tab, { files: scoped, title: scope.title, index });
      else if (tab !== preserve) retired.push(tab);
    }
    if (retired.length) await vscode.window.tabGroups.close(retired, true);
    this.update(); await this.persist();
  }
  prepareOpen() { this.badge.dispose(); this.opening.fire(); }
  private update() {
    const modified = vscode.window.tabGroups.all.flatMap(group => group.tabs.flatMap(tab =>
      tab.input instanceof vscode.TabInputTextDiff && kind(tab) === 'single' ? [tab.input.modified.toString()] : []));
    void vscode.commands.executeCommand('setContext', 'agentTandem.changeModifiedResources', modified);
    const state = this.state();
    const editor = vscode.window.activeTextEditor;
    const showBadge = vscode.workspace.getConfiguration('agentTandem').get<boolean>('showFileCounterInEditor', true);
    this.badge.update(showBadge && editor && owns(editor.document.uri) && state ? editor : undefined, state);
    void vscode.commands.executeCommand('setContext', 'agentTandem.changeNavigation', !!state);
    void vscode.commands.executeCommand('setContext', 'agentTandem.multipleChangedFiles', !!state && state.total > 1);
    this.changes.fire();
    if (!state) { this.counter.hide(); return; }
    this.counter.text = `$(diff) File ${state.index}/${state.total}`;
    this.counter.tooltip = `${state.file}\nClick to choose a changed file. Previous/Next file skips directly between files; Previous/Next change follows individual edits.`;
    this.counter.accessibilityInformation = { label: `AgentTandem changed file ${state.index} of ${state.total}: ${state.file}` };
    this.counter.show();
  }
  private async chooseFile() {
    const tab = activeTab(), scope = this.scope(tab);
    if (!tab || !scope) return;
    const current = this.index(scope, tab);
    const picked = await vscode.window.showQuickPick(scope.files.map((file, index) => ({
      label: file.file, description: `File ${index + 1}/${scope.files.length}${index === current ? ' · current' : ''}`, index,
    })), { title: 'AgentTandem · Changed files', placeHolder: 'Choose a file to review' });
    if (!picked || activeTab() !== tab) return;
    const job = this.queue.then(() => this.showFile(scope, picked.index));
    this.queue = job.catch(() => undefined); await job;
  }
  private async persist() {
    const scopes = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs.flatMap(tab => {
      const scope = this.scope(tab); return scope ? [scope] : [];
    })));
    this.saved = [...scopes];
    const data = JSON.stringify(this.saved.map(scope => ({
      title: scope.title, index: scope.index, files: scope.files.map(file => ({ file: file.file, original: file.original.toString(), modified: file.modified.toString(), review: file.review })),
    })));
    const job = this.saves.then(async () => {
      await mkdir(path.dirname(this.storageFile), { recursive: true });
      const temporary = `${this.storageFile}.tmp`;
      await writeFile(temporary, data);
      await rename(temporary, this.storageFile);
    });
    this.saves = job.catch(() => undefined); await job;
  }
  async track(files: ChangeComparison[], title: string) {
    const tab = activeTab();
    if (!tab || !kind(tab) || !files.length) return;
    this.scopes.set(tab, { files, title, index: 0 });
    this.update(); await this.persist();
  }
  async openFile(files: ChangeComparison[], title: string, index: number) {
    await this.showFile({ files, title, index }, index);
  }
  private async showFile(scope: Scope, index: number) {
    const file = scope.files[index];
    if (!file) throw new Error('Choose a changed file.');
    await useReviewDiffLayout();
    this.prepareOpen();
    await vscode.commands.executeCommand('vscode.diff', file.original, file.modified,
      `${path.basename(file.file)} · ${scope.title} · File ${index + 1}/${scope.files.length}`, { preview: true });
    const tab = activeTab();
    if (!(tab?.input instanceof vscode.TabInputTextDiff) || !same(tab.input.modified, file.modified)) return;
    scope.index = index; this.scopes.set(tab, scope);
    this.update(); await this.persist();
  }
  private async navigate(direction: 'previous' | 'next') {
    const tab = activeTab(), scope = this.scope(tab);
    if (!tab || !scope) return;
    if (kind(tab) === 'multi') {
      this.prepareOpen();
      await vscode.commands.executeCommand(`multiDiffEditor.goTo${direction === 'next' ? 'Next' : 'Previous'}Change`);
      if (activeTab() === tab) { scope.index = this.index(scope, tab); this.update(); await this.persist(); }
      return;
    }
    const input = tab.input as vscode.TabInputTextDiff;
    const editor = vscode.window.visibleTextEditors.find(editor => same(editor.document.uri, input.modified));
    if (!editor) return;
    const before = editor.selection.active;
    await vscode.commands.executeCommand(`workbench.action.compareEditor.${direction}Change`);
    // Selection notifications arrive after the native command result.
    await new Promise(resolve => setTimeout(resolve, 50));
    if (activeTab() !== tab) return;
    const after = editor.selection.active;
    const wrapped = direction === 'next' ? after.isBeforeOrEqual(before) : after.isAfterOrEqual(before);
    if (wrapped && scope.files.length > 1) {
      const index = (this.index(scope, tab) + (direction === 'next' ? 1 : -1) + scope.files.length) % scope.files.length;
      await this.showFile(scope, index);
      const target = scope.files[index]!;
      const nextEditor = vscode.window.visibleTextEditors.find(editor => same(editor.document.uri, target.modified));
      if (nextEditor) nextEditor.selection = new vscode.Selection(0, 0, 0, 0);
      // Previous selects the last hunk. Previous+Next selects the first even
      // when it starts at line one, where Next alone would skip it.
      await vscode.commands.executeCommand('workbench.action.compareEditor.previousChange');
      if (direction === 'next') await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
    }
    this.update();
  }
  private async navigateFile(direction: 'previous' | 'next', anchor?: unknown) {
    const tab = activeTab(), scope = this.scope(tab);
    if (!tab || !scope || scope.files.length < 2) return;
    const current = this.index(scope, tab), comparison = scope.files[current];
    // Editor-title menus supply a resource URI; CodeLens supplies a review anchor.
    if (anchor instanceof vscode.Uri) {
      if (owns(anchor) && comparison && !same(anchor, comparison.original) && !same(anchor, comparison.modified)) return;
      anchor = undefined;
    }
    // A delayed CodeLens click must still belong to this file and revision.
    if (anchor !== undefined) {
      if (!anchor || typeof anchor !== 'object') return;
      const request = anchor as { file?: unknown; project?: unknown; revision?: unknown };
      if (request.file !== comparison?.file || request.project !== comparison?.review?.project || request.revision !== comparison?.review?.revision) return;
    }
    const index = (current + (direction === 'next' ? 1 : -1) + scope.files.length) % scope.files.length;
    await this.showFile(scope, index);
    // Direct file review replaces the overview, retaining its complete scope.
    // Keeping the reused multi-diff pane alive can leave its embedded editor
    // focused after returning to the overview in recent VS Code builds.
    if (kind(tab) === 'multi' && activeTab() !== tab && vscode.window.tabGroups.all.some(group => group.tabs.includes(tab))) await vscode.window.tabGroups.close(tab, true);
    const editor = vscode.window.activeTextEditor;
    if (!editor || !same(editor.document.uri, scope.files[index]!.modified)) return;
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    // Start at the first change even when it begins on line one.
    await vscode.commands.executeCommand('workbench.action.compareEditor.previousChange');
    await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
    this.update();
  }
}
export async function registerChangeNavigation(context: vscode.ExtensionContext) {
  const navigation = new ChangeNavigation(context); await navigation.restore(); return navigation;
}
