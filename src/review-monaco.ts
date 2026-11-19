import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import type { ReviewWebviewFile } from './core/review';

// JSON's full language service is unnecessary for read-only snapshots.
monaco.languages.register({ id: 'json', extensions: ['.json', '.jsonc', '.code-workspace'], filenames: ['.babelrc', '.eslintrc'] });
monaco.languages.setMonarchTokensProvider('json', { tokenizer: {
  root: [
    [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key'], [/"(?:[^"\\]|\\.)*"/, 'string.value'],
    [/\b(?:true|false|null)\b/, 'keyword'], [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
    [/\/\/.*$/, 'comment'], [/\/\*/, 'comment', '@comment'], [/[{}[\]:,]/, 'delimiter'],
  ],
  comment: [[/[^*/]+/, 'comment'], [/\*\//, 'comment', '@pop'], [/[*/]/, 'comment']],
} });

// VS Code Webviews require workers to start from a blob, not a resource URI.
// Bundle locally: opening a review never downloads code or sends source away.
let workerUrl: Promise<string> | undefined;
(self as typeof self & { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker: async () => {
    workerUrl ??= fetch(document.querySelector<HTMLMetaElement>('meta[name="review-worker"]')!.content)
      .then(response => { if (!response.ok) throw new Error('Could not load the review worker.'); return response.blob(); })
      .then(blob => URL.createObjectURL(new Blob([blob], { type: 'text/javascript' })))
      .catch(error => { workerUrl = undefined; throw error; });
    return new Worker(await workerUrl, { name: 'agent-tandem-diff' });
  },
};

function languageFor(file: string): string {
  const name = file.split(/[\\/]/).pop()!.toLowerCase();
  return monaco.languages.getLanguages().find(language =>
    language.filenames?.some(filename => filename.toLowerCase() === name)
    || language.extensions?.some(extension => name.endsWith(extension.toLowerCase())))?.id ?? 'plaintext';
}

function updateSnapshot(model: monaco.editor.ITextModel, snapshot: string, anchor = 0): number {
  const before = model.getValue();
  const eol = model.getEOL();
  const bom = '\uFEFF';
  if (snapshot.startsWith(bom) !== model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true).startsWith(bom)
    || (snapshot.includes('\n') && snapshot.includes('\r\n') !== (eol === '\r\n'))) {
    const position = model.getPositionAt(anchor);
    model.setValue(snapshot);
    return model.getOffsetAt(model.validatePosition(position));
  }
  const after = snapshot.replace(/^\uFEFF/, '').replace(/\r\n|\r|\n/g, eol);
  if (before === after) return anchor;

  // Keep unchanged text outside the edit so Monaco can retain its view state.
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < Math.min(oldEnd, newEnd) && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--; newEnd--;
  }
  // Monaco ranges cannot address the middle of a CRLF.
  if (before[start - 1] === '\r' && before[start] === '\n') start--;
  if (before[oldEnd - 1] === '\r' && before[oldEnd] === '\n') { oldEnd++; newEnd++; }
  model.applyEdits([{
    range: monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(oldEnd)),
    text: after.slice(start, newEnd),
  }]);
  if (anchor >= oldEnd) return anchor + newEnd - oldEnd;
  return Math.min(anchor, newEnd);
}

/** The modified model can hold a draft over the host's saved snapshots. */
export class ReviewCodeEditor {
  private editor: monaco.editor.IStandaloneDiffEditor;
  private diffModel: monaco.editor.IDiffEditorViewModel;
  private original: monaco.editor.ITextModel;
  private modified: monaco.editor.ITextModel;
  private themeObserver: MutationObserver;
  private resizeObserver: ResizeObserver;
  private zones: { id: string; node: HTMLElement; zone: monaco.editor.IViewZone }[] = [];
  private disposed = false;
  private ready = false;
  private pendingFocus?: number;
  private pendingViewport?: { line: number; offset: number };
  private listeners: monaco.IDisposable[] = [];
  private savedVersion: number;
  private syncing = false;

  constructor(private container: HTMLElement, private file: ReviewWebviewFile, sections: HTMLElement[], onSelect: (index: number) => void, onScroll: () => void, onEdit: () => void) {
    container.classList.add('monaco-review');
    delete container.dataset.diffReady;
    const language = languageFor(file.path);
    container.dataset.language = language;
    this.original = monaco.editor.createModel(file.beforeText ?? '', language);
    this.modified = monaco.editor.createModel(file.afterText ?? '', language);
    this.savedVersion = this.modified.getAlternativeVersionId();
    this.editor = monaco.editor.createDiffEditor(container, {
      automaticLayout: true, renderSideBySide: false, readOnly: true, originalEditable: false,
      domReadOnly: true, renderIndicators: true, renderGutterMenu: false, enableSplitViewResizing: false,
      ignoreTrimWhitespace: false, diffAlgorithm: 'advanced', maxComputationTime: 5000,
      hideUnchangedRegions: { enabled: false }, minimap: { enabled: false },
      scrollBeyondLastLine: false, fixedOverflowWidgets: true, wordWrap: 'off',
      stickyScroll: { enabled: false }, codeLens: false, links: false, contextmenu: false,
      padding: { top: 8, bottom: 16 },
      scrollbar: { vertical: 'auto', horizontal: 'auto', verticalHasArrows: false, horizontalHasArrows: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: true },
      lineNumbersMinChars: 4,
      ariaLabel: `Saved changes in ${file.path}`,
    });
    const syncTheme = () => {
      const styles = getComputedStyle(document.body);
      const highContrast = document.body.classList.contains('vscode-high-contrast');
      const highContrastLight = document.body.classList.contains('vscode-high-contrast-light');
      const light = document.body.classList.contains('vscode-light');
      const colors: Record<string, string> = {};
      for (const key of ['editor.background', 'editor.foreground', 'editorLineNumber.foreground', 'editor.selectionBackground', 'editor.lineHighlightBackground', 'diffEditor.insertedLineBackground', 'diffEditor.removedLineBackground']) {
        const value = styles.getPropertyValue(`--vscode-${key.replaceAll('.', '-')}`).trim();
        if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) colors[key] = value;
      }
      monaco.editor.defineTheme('agent-tandem-review', { base: highContrast ? 'hc-black' : highContrastLight ? 'hc-light' : light ? 'vs' : 'vs-dark', inherit: true, rules: [], colors });
      monaco.editor.setTheme('agent-tandem-review');
      this.editor.updateOptions({ fontFamily: styles.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace', fontSize: parseFloat(styles.getPropertyValue('--vscode-editor-font-size')) || 14 });
    };
    syncTheme();
    this.themeObserver = new MutationObserver(syncTheme);
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-vscode-theme-id'] });
    this.diffModel = this.editor.createViewModel({ original: this.original, modified: this.modified });
    this.editor.setModel(this.diffModel);
    const modified = this.editor.getModifiedEditor();
    const syncToolbarWidth = ({ contentWidth }: monaco.editor.EditorLayoutInfo) => {
      container.style.setProperty('--review-content-width', `${contentWidth}px`);
    };
    syncToolbarWidth(modified.getLayoutInfo());
    this.listeners.push(modified.onDidLayoutChange(syncToolbarWidth));
    // Keep the view zone aligned with the rendered toolbar height.
    this.resizeObserver = new ResizeObserver(() => {
      if (this.disposed) return;
      modified.changeViewZones(accessor => this.zones.forEach(({ id, node, zone }) => {
        const height = Math.ceil(node.firstElementChild?.getBoundingClientRect().height ?? 44);
        if (height > 0 && height !== zone.heightInPx) { zone.heightInPx = height; accessor.layoutZone(id); }
      }));
    });
    this.replaceZones(sections);
    this.listeners.push(modified.onDidChangeCursorPosition(event => {
      if (!this.ready || this.dirty) return;
      let index = 0;
      this.file.hunks.forEach((hunk, i) => { if (hunk.newLine < event.position.lineNumber) index = i; });
      onSelect(index);
    }), modified.onDidScrollChange(onScroll), this.modified.onDidChangeContent(() => {
      if (this.syncing) return;
      if (!this.ready) void this.finishDiff();
      onEdit();
    }));
    void this.finishDiff();
  }

  private async finishDiff() {
    const originalVersion = this.original.getVersionId(), modifiedVersion = this.modified.getVersionId();
    await this.diffModel.waitForDiff();
    if (this.disposed || originalVersion !== this.original.getVersionId() || modifiedVersion !== this.modified.getVersionId()) return;
    this.ready = true;
    this.container.dataset.diffReady = 'true';
    const focus = this.pendingFocus, viewport = this.pendingViewport;
    this.pendingFocus = this.pendingViewport = undefined;
    if (focus !== undefined) this.focus(focus);
    else if (viewport) this.restoreViewport(viewport);
  }

  private replaceZones(sections: HTMLElement[]) {
    this.resizeObserver.disconnect();
    this.editor.getModifiedEditor().changeViewZones(accessor => {
      this.zones.forEach(({ id }) => accessor.removeZone(id));
      this.zones = sections.map((node, index) => {
        const hunk = this.file.hunks[index]!;
        const zone: monaco.editor.IViewZone = { afterLineNumber: Math.min(hunk.newLine, this.modified.getLineCount()), ordinal: -10000, heightInPx: 44, domNode: node, showInHiddenAreas: true };
        return { id: accessor.addZone(zone), node, zone };
      });
    });
    sections.forEach(node => this.resizeObserver.observe(node.firstElementChild!));
  }

  private restoreViewport({ line, offset }: { line: number; offset: number }) {
    const editor = this.editor.getModifiedEditor();
    editor.setScrollTop(editor.getTopForLineNumber(line, true) + offset);
  }

  update(file: ReviewWebviewFile, sections: HTMLElement[]) {
    const editor = this.editor.getModifiedEditor();
    const line = this.pendingViewport?.line ?? editor.getVisibleRanges()[0]?.startLineNumber ?? 1;
    const anchor = this.modified.getOffsetAt({ lineNumber: line, column: 1 });
    const offset = this.pendingViewport?.offset ?? editor.getScrollTop() - editor.getTopForLineNumber(line, true);
    const originalVersion = this.original.getVersionId(), modifiedVersion = this.modified.getVersionId();
    const wasReady = this.ready;
    this.ready = false;
    if (file.beforeText !== this.file.beforeText) updateSnapshot(this.original, file.beforeText ?? '');
    this.syncing = true;
    const nextAnchor = file.afterText === this.file.afterText ? anchor : updateSnapshot(this.modified, file.afterText ?? '', anchor);
    this.markSaved();
    this.syncing = false;
    this.file = file;
    this.replaceZones(sections);
    const viewport = { line: this.modified.getPositionAt(nextAnchor).lineNumber, offset };
    // Restore again after Monaco recalculates the height of inline deletions.
    if (originalVersion !== this.original.getVersionId() || modifiedVersion !== this.modified.getVersionId()) {
      delete this.container.dataset.diffReady;
      this.pendingFocus = undefined;
      void this.finishDiff();
    } else {
      this.ready = wasReady;
    }
    if (!this.ready) this.pendingViewport = viewport;
    this.restoreViewport(viewport);
  }

  focus(index: number) {
    const entry = this.zones[index];
    if (!entry) return;
    if (!this.ready) { this.pendingViewport = undefined; this.pendingFocus = index; return; }
    const editor = this.editor.getModifiedEditor();
    editor.setScrollLeft(0);
    const line = Math.min(this.file.hunks[index]!.newLine + 1, this.modified.getLineCount());
    editor.revealLineNearTop(line, monaco.editor.ScrollType.Immediate);
    // Use the zone's actual top, which includes deleted lines and prior toolbars.
    const offset = entry.node.getBoundingClientRect().top - editor.getContainerDomNode().getBoundingClientRect().top;
    editor.setScrollTop(Math.max(0, editor.getScrollTop() + offset - 12));
    entry.node.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }
  get scrollTop() { return this.editor.getModifiedEditor().getScrollTop(); }
  get dirty() { return this.modified.getAlternativeVersionId() !== this.savedVersion; }
  get text() { return this.modified.getValue(monaco.editor.EndOfLinePreference.TextDefined, true); }
  markSaved() { this.savedVersion = this.modified.getAlternativeVersionId(); }
  setEditable(editable: boolean) {
    this.editor.updateOptions({ readOnly: !editable, domReadOnly: !editable });
  }
  discard() {
    const editor = this.editor.getModifiedEditor(), view = editor.saveViewState();
    this.syncing = true;
    this.modified.setValue(this.file.afterText ?? '');
    this.markSaved();
    this.syncing = false;
    if (view) editor.restoreViewState(view);
    if (!this.ready) void this.finishDiff();
  }
  dispose() {
    this.disposed = true; this.themeObserver.disconnect(); this.resizeObserver.disconnect();
    this.listeners.forEach(listener => listener.dispose());
    this.editor.dispose(); this.original.dispose(); this.modified.dispose();
  }
}
