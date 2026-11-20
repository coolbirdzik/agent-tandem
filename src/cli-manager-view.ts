import type { ViewState } from './core/types';
import { projectCLIChoices, projectCLISelection, type CLIEntry, type CLIRequest } from './providers/cli-registry';
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
  private editing = new Set<string>();
  private drafts = new Map<string, string>();
  private pending?: { revision: string; project?: string; seenBusy: boolean; action: CLIRequest['action']; id?: string };
  constructor(private root: HTMLElement, private status: HTMLElement, private send: (request: CLIRequest) => void,
    private copyPath: (executable: string) => void) {}
  private request(provider: ConversationProvider, action: CLIRequest['action'], details: Partial<CLIRequest> = {}) {
    const state = this.state, manager = state?.cliManager;
    if (!manager || manager.busy || this.pending) return;
    this.pending = { revision: manager.registry.revision, project: state.project, seenBusy: false, action, id: details.id };
    this.send({ project: state.project, revision: manager.registry.revision, provider, action, ...details });
    this.render(state);
  }
  render(state: ViewState) {
    if (state.screen === 'cli' && (this.state?.screen !== 'cli' || this.state.project !== state.project)) {
      for (const row of this.root.querySelectorAll<HTMLDetailsElement>('.cli-entry[open]')) row.open = false;
    }
    this.state = state;
    const manager = state.cliManager;
    if (this.pending && manager?.busy) this.pending.seenBusy = true;
    if (this.pending && (state.project !== this.pending.project || state.error || manager?.registry.revision !== this.pending.revision || (this.pending.seenBusy && !manager?.busy))) {
      const success = state.project === this.pending.project && !state.error && manager && !manager.error && manager.registry.revision !== this.pending.revision;
      if (success && this.pending.action === 'edit' && this.pending.id) {
        this.editing.delete(this.pending.id);
        this.discardDrafts(this.pending.id);
      }
      this.pending = undefined;
    }
    const busy = !!manager?.busy || !!this.pending || state.chat?.status === 'running' || state.chat?.phase === 'finishing' || !!state.reviewBusy || !!state.review?.busy;
    const locked = busy || !manager?.trusted || !manager.registry.initialized;
    this.status.textContent = manager?.error ?? (!manager ? 'Loading CLI list…' : !manager.trusted ? 'Trust the workspace to manage local CLIs.' : busy ? 'Wait for the current action to finish.' : '');
    const signature = JSON.stringify([state.project, manager, locked, [...this.editing]]);
    if (signature === this.signature) return;
    this.signature = signature;
    const expanded = new Set([...this.root.querySelectorAll<HTMLDetailsElement>('.cli-entry[open]')].map(row => row.dataset.cliId));
    for (const input of this.root.querySelectorAll<HTMLInputElement>('[data-cli-draft]')) this.drafts.set(input.dataset.cliDraft!, input.value);
    this.root.replaceChildren();
    if (!manager) return;
    for (const provider of ['Codex', 'Claude'] as const) {
      const group = node('section', undefined, 'cli-group'); group.setAttribute('aria-label', `${provider} CLI installations`);
      const heading = node('div', undefined, 'cli-group-heading'), title = node('h3', provider === 'Claude' ? 'Claude Code' : 'Codex');
      const logo = node('img'); logo.className = 'provider-icon'; logo.dataset.provider = provider; logo.alt = '';
      logo.src = provider === 'Codex' ? document.body.dataset.codexIcon! : document.body.dataset.claudeIcon!;
      title.prepend(logo); heading.append(title);
      const actions = node('div', undefined, 'cli-group-actions');
      actions.append(
        this.button('Scan', () => this.request(provider, 'scan'), locked, 'secondary', 'search'),
        this.button('Check versions', () => this.request(provider, 'refresh'), locked, 'secondary', 'refresh'),
        this.button('Add', () => this.request(provider, 'add'), locked, 'primary', 'add'),
      );
      heading.append(actions);
      group.append(heading);
      const rows = manager.registry.entries.filter(row => row.provider === provider), active = manager.active[provider];
      const selections = node('div', undefined, 'cli-selections');
      const defaultSelect = this.select('Default', `cli-default-${provider}`, [['', 'Automatic'], ...rows.map(row => [row.id, row.name, !row.enabled || !!row.error] as [string, string, boolean])], manager.registry.defaults[provider], locked,
        id => this.request(provider, 'default', { id }));
      const selected = projectCLISelection(active);
      const projectSelect = this.select('This project', `cli-project-${provider}`, projectCLIChoices(rows, selected).map(choice => [choice.id, choice.label, choice.disabled]), selected, locked || !state.project,
        id => this.request(provider, 'use', { id }));
      selections.append(defaultSelect, projectSelect); group.append(selections);
      if (active?.error) group.append(node('p', active.error, 'cli-entry-error'));
      if (!rows.length) group.append(node('p', 'No CLI entries. Add an executable or scan installed CLIs.', 'meta'));
      for (const row of rows) group.append(this.entry(row, locked, active?.id === row.id, manager.registry.defaults[provider] === row.id, expanded.has(row.id)));
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
  private value(key: string) { return [...this.root.querySelectorAll<HTMLInputElement>('[data-cli-draft]')].find(input => input.dataset.cliDraft === key)?.value ?? this.drafts.get(key) ?? ''; }
  private input(key: string, label: string, disabled: boolean, initial = '') {
    const input = node('input'); input.type = 'text'; input.value = this.drafts.get(key) ?? initial; input.placeholder = label; input.setAttribute('aria-label', label); input.disabled = disabled;
    input.dataset.cliDraft = key; input.dataset.focusKey = `cli:${key}`; input.autocomplete = 'off'; input.spellcheck = false; return input;
  }
  private button(text: string, action: () => void, disabled: boolean, className = 'secondary', iconName?: string) {
    const button = node('button', text, className); button.type = 'button'; button.disabled = disabled; button.onclick = action;
    if (iconName) {
      const icon = node('span', undefined, `codicon codicon-${iconName}`);
      icon.setAttribute('aria-hidden', 'true');
      button.prepend(icon);
    }
    return button;
  }
  private pathButton(executable: string) {
    const button = this.button(executable, () => this.copyPath(executable), false, 'cli-path');
    button.title = executable;
    button.setAttribute('aria-label', `Copy executable path: ${executable}`);
    return button;
  }
  private select(label: string, id: string, options: Array<[string, string, boolean?]>, selected: string, disabled: boolean, changed: (id: string) => void) {
    const wrapper = node('label', label), select = node('select'); select.id = id; select.setAttribute('aria-label', label); select.dataset.focusKey = id; select.disabled = disabled;
    for (const [value, text, unavailable] of options) { const option = node('option', text); option.value = value; option.disabled = !!unavailable; select.append(option); }
    if (![...select.options].some(option => option.value === selected)) { const option = node('option', 'Unavailable selection'); option.value = selected; option.disabled = true; select.append(option); }
    select.value = selected; select.onchange = () => changed(select.value); wrapper.append(select); return wrapper;
  }
  private entry(entry: CLIEntry, locked: boolean, active: boolean, defaultCLI: boolean, expanded: boolean) {
    const row = node('details', undefined, 'cli-entry'); row.dataset.cliId = entry.id; row.dataset.enabled = String(entry.enabled);
    row.open = expanded;
    const origin = cliOrigin(entry.executable);
    const heading = node('summary', undefined, 'cli-entry-heading');
    const identity = node('span', undefined, 'cli-entry-identity');
    if (origin.icon) {
      const icon = node('span', undefined, `codicon codicon-${origin.icon}`);
      icon.setAttribute('aria-hidden', 'true');
      identity.append(icon);
    }
    const installation = node('span', undefined, 'cli-entry-installation');
    installation.append(node('span', cliVersion(entry.version), 'cli-entry-version'), node('span', origin.label, 'meta'));
    identity.append(installation);
    const status = [active ? 'In use' : '', defaultCLI ? 'Default' : '', entry.enabled ? 'Enabled' : 'Disabled'].filter(Boolean).join(' · ');
    const chevron = node('span', undefined, 'cli-entry-chevron codicon codicon-chevron-down');
    chevron.setAttribute('aria-hidden', 'true');
    heading.append(identity, node('span', status, 'meta'), chevron);
    row.append(heading);
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
      row.append(edit);
      return row;
    }
    row.append(this.pathButton(entry.executable));
    if (entry.error) row.append(node('p', entry.error, 'cli-entry-error'));
    const actions = node('div', undefined, 'cli-row-actions');
    const edit = this.button('Edit', () => {
      this.editing.add(entry.id);
      this.renderAndFocus(`cli:${entry.id}:name`);
    }, locked);
    edit.dataset.focusKey = editButtonKey;
    actions.append(this.button(entry.enabled ? 'Disable' : 'Enable', () => this.request(entry.provider, 'toggle', { id: entry.id, enabled: !entry.enabled }), locked),
      edit,
      this.button('Remove', () => this.request(entry.provider, 'remove', { id: entry.id }), locked));
    row.append(actions);
    actions.lastElementChild?.setAttribute('title', 'Remove from this list; keep the executable on disk');
    return row;
  }
}
