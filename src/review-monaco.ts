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

/** A read-only full-file diff; decisions always use the host's immutable hunks. */
export class ReviewCodeEditor {
  private editor: monaco.editor.IStandaloneDiffEditor;
  private original: monaco.editor.ITextModel;
  private modified: monaco.editor.ITextModel;
  private themeObserver: MutationObserver;
  private resizeObserver: ResizeObserver;
  private zones: { id: string; node: HTMLElement; zone: monaco.editor.IViewZone }[] = [];
  private disposed = false;
  private ready = false;
  private pendingFocus?: number;
  private pendingScroll?: number;
  private listeners: monaco.IDisposable[] = [];

  constructor(container: HTMLElement, private file: ReviewWebviewFile, sections: HTMLElement[], onSelect: (index: number) => void, onScroll: () => void) {
    container.classList.add('monaco-review');
    delete container.dataset.diffReady;
    const language = languageFor(file.path);
    container.dataset.language = language;
    this.original = monaco.editor.createModel(file.beforeText ?? '', language);
    this.modified = monaco.editor.createModel(file.afterText ?? '', language);
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
    this.editor.setModel({ original: this.original, modified: this.modified });
    const modified = this.editor.getModifiedEditor();
    modified.changeViewZones(accessor => sections.forEach((node, index) => {
      const hunk = file.hunks[index]!;
      const zone: monaco.editor.IViewZone = { afterLineNumber: Math.min(hunk.newLine, this.modified.getLineCount()), ordinal: -10000, heightInPx: 44, domNode: node, showInHiddenAreas: true };
      this.zones.push({ id: accessor.addZone(zone), node, zone });
    }));
    // Toolbar height follows wrapping at narrow widths, without covering code.
    this.resizeObserver = new ResizeObserver(() => {
      if (this.disposed) return;
      modified.changeViewZones(accessor => this.zones.forEach(({ id, node, zone }) => {
        const height = Math.ceil(node.firstElementChild?.getBoundingClientRect().height ?? 44);
        if (height > 0 && height !== zone.heightInPx) { zone.heightInPx = height; accessor.layoutZone(id); }
      }));
    });
    sections.forEach(node => this.resizeObserver.observe(node.firstElementChild!));
    this.listeners.push(this.editor.onDidUpdateDiff(() => {
      this.ready = true;
      container.dataset.diffReady = 'true';
      if (this.pendingFocus !== undefined) { const index = this.pendingFocus; this.pendingFocus = undefined; this.focus(index); }
      else if (this.pendingScroll !== undefined) { modified.setScrollTop(this.pendingScroll); this.pendingScroll = undefined; }
    }), modified.onDidChangeCursorPosition(event => {
      let index = 0;
      file.hunks.forEach((hunk, i) => { if (hunk.newLine < event.position.lineNumber) index = i; });
      onSelect(index);
    }), modified.onDidScrollChange(onScroll));
  }

  focus(index: number) {
    const entry = this.zones[index];
    if (!entry) return;
    if (!this.ready) { this.pendingFocus = index; return; }
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
  set scrollTop(value: number) {
    this.editor.getModifiedEditor().setScrollTop(value);
    if (!this.ready) this.pendingScroll = value;
  }
  dispose() {
    this.disposed = true; this.themeObserver.disconnect(); this.resizeObserver.disconnect();
    this.listeners.forEach(listener => listener.dispose());
    this.editor.dispose(); this.original.dispose(); this.modified.dispose();
  }
}
