import type { ViewState } from './core/types';
import type { CLIEntry, CLIRequest } from './providers/cli-registry';
import type { ConversationProvider } from './providers/conversations';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el;
};
const cliVersion = (version: string) => version.replace(/^codex-cli\s+/i, '').replace(/\s*\(Claude Code\)$/i, '').trim() || 'Version unavailable';
/** Describe recognizable installation locations without assuming every custom executable is global. */
const cliOrigin = (executable: string) => {
  const file = executable.replace(/\\/g, '/');
  if (/\/(?:openai\.chatgpt|anthropic\.claude-code)(?:-[^/]+)?\//i.test(file)) {
    const editor = /\/\.cursor\//i.test(file) ? 'Cursor' : /\/\.vscode-insiders\//i.test(file) ? 'VS Code Insiders' : 'Editor';
    return { label: `${/\/\.vscode\//i.test(file) ? 'VS Code' : editor} extension`, icon: 'extensions' };
  }
  if (/\/(?:lib\/node_modules\/(?:@openai\/codex|@anthropic-ai\/claude-code)|\.local\/(?:bin|share\/(?:claude|codex))|\.claude\/local|\.codex\/bin)(?:\/|$)/i.test(file) || /^(?:\/usr\/(?:local\/)?bin\/|\/opt\/homebrew\/|[a-z]:\/Users\/[^/]+\/AppData\/(?:Roaming\/npm|Local\/(?:Programs|Microsoft\/WinGet))\/)/i.test(file)) return { label: 'Global installation', icon: 'terminal-compact' };
  return { label: 'Local executable' };
};
/** Keep editable fields stable while history sync and CLI checks update the panel. */
export class CLIManagerView {
  private state?: ViewState;
  private signature = '';
  private adding = new Set<ConversationProvider>();
  private editing = new Set<string>();
  private drafts = new Map<string, string>();
  private pending?: { revision: string; project?: string; seenBusy: boolean; action: CLIRequest['action']; provider: ConversationProvider; id?: string };
  constructor(private root: HTMLElement, private status: HTMLElement, private send: (request: CLIRequest) => void,
    private copyPath: (executable: string) => void) {}
  private request(provider: ConversationProvider, action: CLIRequest['action'], details: Partial<CLIRequest> = {}) {
    const state = this.state, manager = state?.cliManager;
    if (!manager || manager.busy || this.pending) return;
    this.pending = { revision: manager.registry.revision, project: state.project, seenBusy: false, action, provider, id: details.id };
    this.send({ project: state.project, revision: manager.registry.revision, provider, action, ...details });
    this.render(state);
  }
  render(state: ViewState) {
    this.state = state;
    const manager = state.cliManager;
    if (this.pending && manager?.busy) this.pending.seenBusy = true;
    if (this.pending && (state.project !== this.pending.project || state.error || manager?.registry.revision !== this.pending.revision || (this.pending.seenBusy && !manager?.busy))) {
      const success = state.project === this.pending.project && !state.error && manager && !manager.error && manager.registry.revision !== this.pending.revision;
      if (success && this.pending.action === 'edit' && this.pending.id) {
        this.editing.delete(this.pending.id);
        this.discardDrafts(this.pending.id);
      }
      if (success && this.pending.action === 'add') {
        this.adding.delete(this.pending.provider);
        this.discardDrafts(`add:${this.pending.provider}`);
      }
      this.pending = undefined;
    }
    const busy = !!manager?.busy || !!this.pending || state.chat?.status === 'running' || state.chat?.phase === 'finishing' || !!state.reviewBusy || !!state.review?.busy;
    const locked = busy || !manager?.trusted || !manager.registry.initialized;
    this.status.textContent = manager?.error ?? (!manager ? 'Loading CLI list…' : !manager.trusted ? 'Trust the workspace to manage local CLIs.' : busy ? 'Wait for the current action to finish.' : '');
    const signature = JSON.stringify([state.project, manager, locked, [...this.adding], [...this.editing]]);
    if (signature === this.signature) return;
    this.signature = signature;
    for (const input of this.root.querySelectorAll<HTMLInputElement>('[data-cli-draft]')) this.drafts.set(input.dataset.cliDraft!, input.value);
    this.root.replaceChildren();
    if (!manager) return;
    for (const provider of ['Codex', 'Claude'] as const) {
      const group = node('section', undefined, 'cli-group'); group.setAttribute('aria-label', `${provider} CLI installations`);
      const heading = node('div', undefined, 'cli-group-heading'), title = node('h3', provider === 'Claude' ? 'Claude Code' : 'Codex');
      const logo = node('img'); logo.className = 'provider-icon'; logo.dataset.provider = provider; logo.alt = '';
      logo.src = provider === 'Codex' ? document.body.dataset.codexIcon! : document.body.dataset.claudeIcon!;
      title.prepend(logo); heading.append(title);
      const addKey = `add:${provider}`;
      const adding = this.adding.has(provider);
      const addButton = this.button('Add', () => {
        this.adding.add(provider);
        this.renderAndFocus(`cli:${addKey}:name`);
      }, locked, 'primary');
      addButton.dataset.focusKey = `cli:${addKey}:button`;
      addButton.setAttribute('aria-expanded', String(adding));
      const actions = node('div', undefined, 'cli-group-actions');
      actions.append(this.button('Scan', () => this.request(provider, 'scan'), locked), this.button('Check versions', () => this.request(provider, 'refresh'), locked), addButton);
      heading.append(actions);
      group.append(heading);
      if (adding) group.append(this.addForm(provider, addKey, locked));
      const rows = manager.registry.entries.filter(row => row.provider === provider), active = manager.active[provider];
      const selections = node('div', undefined, 'cli-selections');
      const defaultSelect = this.select('Default', `cli-default-${provider}`, [['', 'Automatic'], ...rows.map(row => [row.id, row.name, !row.enabled || !!row.error] as [string, string, boolean])], manager.registry.defaults[provider], locked,
        id => this.request(provider, 'default', { id }));
      const projectSelect = this.select('This project', `cli-project-${provider}`, [['', 'Use Default'], ...rows.map(row => [row.id, row.name, !row.enabled || !!row.error] as [string, string, boolean])], active?.source === 'project' ? active.id ?? 'unavailable' : active?.source === 'path' ? 'path' : '', locked || !state.project,
        id => this.request(provider, 'use', { id }), active?.source === 'path' ? 'Using terminal PATH' : undefined);
      selections.append(defaultSelect, projectSelect); group.append(selections);
      if (active?.error) group.append(node('p', active.error, 'cli-entry-error'));
      if (!rows.length) group.append(node('p', 'No CLI entries. Add an executable or scan installed CLIs.', 'meta'));
      for (const row of rows) group.append(this.entry(row, locked, active?.id === row.id, manager.registry.defaults[provider] === row.id));
      this.root.append(group);
    }
  }
  private renderAndFocus(key: string) {
    if (this.state) this.render(this.state);
    [...this.root.querySelectorAll<HTMLElement>('[data-focus-key]')].find(element => element.dataset.focusKey === key)?.focus();
  }
  private discardDrafts(prefix: string) {
    const keys = [`${prefix}:name`, `${prefix}:path`];
    for (const key of keys) this.drafts.delete(key);
    for (const input of this.root.querySelectorAll<HTMLInputElement>('[data-cli-draft]')) {
      if (keys.includes(input.dataset.cliDraft!)) input.remove();
    }
  }
  private addForm(provider: ConversationProvider, key: string, locked: boolean) {
    const add = node('form', undefined, 'cli-add-form'); add.setAttribute('aria-label', `Add ${provider} CLI`);
    add.append(this.input(`${key}:name`, 'Name (optional)', locked), this.input(`${key}:path`, 'Absolute executable path', locked));
    const actions = node('div', undefined, 'cli-row-actions');
    const submit = this.button('Add CLI', () => undefined, locked); submit.type = 'submit';
    actions.append(submit, this.button('Browse…', () => this.request(provider, 'add', { name: this.value(`${key}:name`) }), locked),
      this.button('Cancel', () => {
        this.adding.delete(provider);
        this.discardDrafts(key);
        this.renderAndFocus(`cli:${key}:button`);
      }, locked));
    add.append(actions);
    add.onsubmit = event => {
      event.preventDefault();
      this.request(provider, 'add', { name: this.value(`${key}:name`), executable: this.value(`${key}:path`).trim() });
    };
    return add;
  }
  private value(key: string) { return [...this.root.querySelectorAll<HTMLInputElement>('[data-cli-draft]')].find(input => input.dataset.cliDraft === key)?.value ?? this.drafts.get(key) ?? ''; }
  private input(key: string, label: string, disabled: boolean, initial = '') {
    const input = node('input'); input.type = 'text'; input.value = this.drafts.get(key) ?? initial; input.placeholder = label; input.setAttribute('aria-label', label); input.disabled = disabled;
    input.dataset.cliDraft = key; input.dataset.focusKey = `cli:${key}`; input.autocomplete = 'off'; input.spellcheck = false; return input;
  }
  private button(text: string, action: () => void, disabled: boolean, className = 'secondary') {
    const button = node('button', text, className); button.type = 'button'; button.disabled = disabled; button.onclick = action; return button;
  }
  private pathButton(executable: string) {
    const button = this.button(executable, () => this.copyPath(executable), false, 'cli-path');
    button.title = executable;
    button.setAttribute('aria-label', `Copy executable path: ${executable}`);
    return button;
  }
  private select(label: string, id: string, options: Array<[string, string, boolean?]>, selected: string, disabled: boolean, changed: (id: string) => void, missingSelectionLabel = 'Unavailable selection') {
    const wrapper = node('label', label), select = node('select'); select.id = id; select.setAttribute('aria-label', label); select.dataset.focusKey = id; select.disabled = disabled;
    for (const [value, text, unavailable] of options) { const option = node('option', text); option.value = value; option.disabled = !!unavailable; select.append(option); }
    if (![...select.options].some(option => option.value === selected)) { const option = node('option', missingSelectionLabel); option.value = selected; option.disabled = true; select.append(option); }
    select.value = selected; select.onchange = () => changed(select.value); wrapper.append(select); return wrapper;
  }
  private entry(entry: CLIEntry, locked: boolean, active: boolean, defaultCLI: boolean) {
    const article = node('article', undefined, 'cli-entry'); article.dataset.cliId = entry.id; article.dataset.enabled = String(entry.enabled);
    const editButtonKey = `cli:${entry.id}:edit`;
    if (this.editing.has(entry.id)) {
      const edit = node('form', undefined, 'cli-edit-form'); edit.setAttribute('aria-label', `Edit ${entry.name}`);
      edit.append(this.input(`${entry.id}:name`, 'CLI name', locked, entry.name), this.input(`${entry.id}:path`, 'CLI executable path', locked, entry.executable));
      const actions = node('div', undefined, 'cli-row-actions'), save = this.button('Save', () => undefined, locked); save.type = 'submit';
      actions.append(save, this.button('Cancel', () => {
        this.editing.delete(entry.id);
        this.discardDrafts(entry.id);
        this.renderAndFocus(editButtonKey);
      }, locked));
      edit.append(actions);
      edit.onsubmit = event => { event.preventDefault(); this.request(entry.provider, 'edit', { id: entry.id, name: this.value(`${entry.id}:name`), executable: this.value(`${entry.id}:path`).trim() }); };
      article.append(edit);
      return article;
    }
    const origin = cliOrigin(entry.executable);
    const heading = node('div', undefined, 'cli-entry-heading');
    const identity = node('div', undefined, 'cli-entry-identity');
    if (origin.icon) {
      const icon = node('span', undefined, `codicon codicon-${origin.icon}`);
      icon.setAttribute('aria-hidden', 'true');
      identity.append(icon);
    }
    const details = node('div');
    details.append(node('h4', cliVersion(entry.version)), node('p', origin.label, 'meta'));
    identity.append(details);
    const status = [active ? 'In use' : '', defaultCLI ? 'Default' : '', entry.enabled ? 'Enabled' : 'Disabled'].filter(Boolean).join(' · ');
    heading.append(identity, node('span', status, 'meta'));
    article.append(heading);
    article.append(this.pathButton(entry.executable));
    if (entry.error) article.append(node('p', entry.error, 'cli-entry-error'));
    const actions = node('div', undefined, 'cli-row-actions');
    const edit = this.button('Edit', () => {
      this.editing.add(entry.id);
      this.renderAndFocus(`cli:${entry.id}:name`);
    }, locked);
    edit.dataset.focusKey = editButtonKey;
    actions.append(this.button(entry.enabled ? 'Disable' : 'Enable', () => this.request(entry.provider, 'toggle', { id: entry.id, enabled: !entry.enabled }), locked),
      edit,
      this.button('Remove', () => this.request(entry.provider, 'remove', { id: entry.id }), locked));
    article.append(actions);
    actions.lastElementChild?.setAttribute('title', 'Remove from this list; keep the executable on disk');
    return article;
  }
}
