import type { ViewState } from './core/types';
import type { CLIEntry, CLIRequest } from './providers/cli-registry';
import type { ConversationProvider } from './providers/conversations';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el;
};
/** Keep editable fields stable while history sync and CLI checks update the panel. */
export class CLIManagerView {
  private state?: ViewState;
  private signature = '';
  private editing = new Set<string>();
  private drafts = new Map<string, string>();
  private pending?: { revision: string; project?: string; seenBusy: boolean; action: CLIRequest['action']; provider: ConversationProvider; id?: string };
  constructor(private root: HTMLElement, private status: HTMLElement, private send: (request: CLIRequest) => void) {}
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
      const success = !state.error && !manager?.error && manager?.registry.revision !== this.pending.revision;
      if (success && this.pending.action === 'edit' && this.pending.id) {
        this.editing.delete(this.pending.id);
        for (const input of this.root.querySelectorAll<HTMLInputElement>('[data-cli-draft]')) if (input.dataset.cliDraft!.startsWith(`${this.pending.id}:`)) { this.drafts.delete(input.dataset.cliDraft!); input.remove(); }
      }
      if (success && this.pending.action === 'add') {
        for (const input of this.root.querySelectorAll<HTMLInputElement>('[data-cli-draft]')) if (input.dataset.cliDraft!.startsWith(`add:${this.pending.provider}:`)) { this.drafts.delete(input.dataset.cliDraft!); input.value = ''; }
      }
      this.pending = undefined;
    }
    const busy = !!manager?.busy || !!this.pending || state.chat?.status === 'running' || state.chat?.phase === 'finishing' || !!state.reviewBusy || !!state.review?.busy;
    const locked = busy || !manager?.trusted || !manager.registry.initialized;
    this.status.textContent = manager?.error ?? (!manager ? 'Loading CLI list…' : !manager.trusted ? 'Trust the workspace to manage local CLIs.' : busy ? 'Wait for the current action to finish.' : 'Only enabled CLIs can run agents.');
    const signature = JSON.stringify([state.project, manager, locked, [...this.editing]]);
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
      heading.append(this.button('Scan', () => this.request(provider, 'scan'), locked), this.button('Check versions', () => this.request(provider, 'refresh'), locked)); group.append(heading);
      const rows = manager.registry.entries.filter(row => row.provider === provider), active = manager.active[provider];
      const selections = node('div', undefined, 'cli-selections');
      const defaultSelect = this.select('Default on this machine', `cli-default-${provider}`, [['', 'Terminal CLI (PATH)'], ...rows.map(row => [row.id, row.name, !row.enabled || !!row.error] as [string, string, boolean])], manager.registry.defaults[provider], locked,
        id => this.request(provider, 'default', { id }));
      const projectSelect = this.select('This project', `cli-project-${provider}`, [['', 'Use default CLI'], ['path', 'Terminal CLI (PATH)'], ...rows.map(row => [row.id, row.name, !row.enabled || !!row.error] as [string, string, boolean])], active?.source === 'project' ? active.id ?? 'unavailable' : active?.source === 'path' ? 'path' : '', locked || !state.project,
        id => this.request(provider, 'use', { id }));
      selections.append(defaultSelect, projectSelect); group.append(selections);
      if (active?.error) group.append(node('p', active.error, 'cli-entry-error'));
      else if (active?.id) { const row = rows.find(row => row.id === active.id); group.append(node('p', `Using ${row?.name ?? 'CLI'} · ${active.source === 'project' ? 'project selection' : active.source === 'default' ? 'default' : 'terminal PATH'}`, 'cli-active')); }
      if (!rows.length) group.append(node('p', 'No CLI entries. Add an executable or scan installed CLIs.', 'meta'));
      for (const row of rows) group.append(this.entry(row, locked, active?.id === row.id, manager.registry.defaults[provider] === row.id));
      const add = node('form', undefined, 'cli-add-form'); add.setAttribute('aria-label', `Add ${provider} CLI`);
      add.append(this.input(`add:${provider}:name`, 'Name (optional)', locked), this.input(`add:${provider}:path`, 'Absolute executable path', locked));
      const actions = node('div', undefined, 'cli-row-actions');
      const submit = this.button('Add CLI', () => undefined, locked); submit.type = 'submit';
      actions.append(submit, this.button('Browse…', () => this.request(provider, 'add', { name: this.value(`add:${provider}:name`) }), locked)); add.append(actions);
      add.onsubmit = event => { event.preventDefault(); this.request(provider, 'add', { name: this.value(`add:${provider}:name`), executable: this.value(`add:${provider}:path`).trim() }); };
      group.append(add); this.root.append(group);
    }
  }
  private value(key: string) { return [...this.root.querySelectorAll<HTMLInputElement>('[data-cli-draft]')].find(input => input.dataset.cliDraft === key)?.value ?? this.drafts.get(key) ?? ''; }
  private input(key: string, label: string, disabled: boolean, initial = '') {
    const input = node('input'); input.type = 'text'; input.value = this.drafts.get(key) ?? initial; input.placeholder = label; input.setAttribute('aria-label', label); input.disabled = disabled;
    input.dataset.cliDraft = key; input.dataset.focusKey = `cli:${key}`; input.autocomplete = 'off'; input.spellcheck = false; return input;
  }
  private button(text: string, action: () => void, disabled: boolean) {
    const button = node('button', text, 'secondary'); button.type = 'button'; button.disabled = disabled; button.onclick = action; return button;
  }
  private select(label: string, id: string, options: Array<[string, string, boolean?]>, selected: string, disabled: boolean, changed: (id: string) => void) {
    const wrapper = node('label', label), select = node('select'); select.id = id; select.setAttribute('aria-label', label); select.dataset.focusKey = id; select.disabled = disabled;
    for (const [value, text, unavailable] of options) { const option = node('option', unavailable ? `${text} (disabled/unavailable)` : text); option.value = value; option.disabled = !!unavailable; select.append(option); }
    if (![...select.options].some(option => option.value === selected)) { const option = node('option', 'Unavailable selection'); option.value = selected; option.disabled = true; select.append(option); }
    select.value = selected; select.onchange = () => changed(select.value); wrapper.append(select); return wrapper;
  }
  private entry(entry: CLIEntry, locked: boolean, active: boolean, defaultCLI: boolean) {
    const article = node('article', undefined, 'cli-entry'); article.dataset.cliId = entry.id; article.dataset.enabled = String(entry.enabled);
    const heading = node('div', undefined, 'cli-entry-heading'); heading.append(node('h4', entry.name), node('span', [active ? 'In use' : '', defaultCLI ? 'Default' : '', entry.enabled ? 'Enabled' : 'Disabled'].filter(Boolean).join(' · '), 'meta')); article.append(heading);
    const executable = node('p', entry.executable, 'cli-path'); executable.title = entry.executable;
    article.append(node('p', entry.version, 'meta'), executable);
    if (entry.error) article.append(node('p', entry.error, 'cli-entry-error'));
    const actions = node('div', undefined, 'cli-row-actions');
    actions.append(this.button(entry.enabled ? 'Disable' : 'Enable', () => this.request(entry.provider, 'toggle', { id: entry.id, enabled: !entry.enabled }), locked),
      this.button('Edit', () => { this.editing.add(entry.id); if (this.state) this.render(this.state); }, locked),
      this.button('Remove', () => this.request(entry.provider, 'remove', { id: entry.id }), locked));
    article.append(actions);
    actions.lastElementChild?.setAttribute('title', 'Remove from this list; keep the executable on disk');
    if (this.editing.has(entry.id)) {
      const edit = node('form', undefined, 'cli-edit-form'); edit.setAttribute('aria-label', `Edit ${entry.name}`);
      edit.append(this.input(`${entry.id}:name`, 'CLI name', locked, entry.name), this.input(`${entry.id}:path`, 'CLI executable path', locked, entry.executable));
      const editActions = node('div', undefined, 'cli-row-actions'), save = this.button('Save', () => undefined, locked); save.type = 'submit';
      editActions.append(save, this.button('Cancel', () => { this.editing.delete(entry.id); this.drafts.delete(`${entry.id}:name`); this.drafts.delete(`${entry.id}:path`); edit.remove(); if (this.state) this.render(this.state); }, locked)); edit.append(editActions);
      edit.onsubmit = event => { event.preventDefault(); this.request(entry.provider, 'edit', { id: entry.id, name: this.value(`${entry.id}:name`), executable: this.value(`${entry.id}:path`).trim() }); };
      article.append(edit);
    }
    return article;
  }
}
