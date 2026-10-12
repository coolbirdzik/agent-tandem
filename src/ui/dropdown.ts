/** A single themed, keyboard-accessible picker for every select in the panel.
 * The select remains the form/value source; the browser's native menu is hidden.
 */
export class Dropdowns {
  private controls = new Map<HTMLSelectElement, Dropdown>();
  private active?: Dropdown;
  constructor(private root: HTMLElement) {
    window.addEventListener('click', event => {
      if (this.active && !this.active.contains(event.target as Node)) this.close();
    }, true);
    window.addEventListener('focusin', event => {
      if (this.active && !this.active.contains(event.target as Node)) this.close();
    });
    window.addEventListener('resize', () => this.active?.position());
    window.addEventListener('scroll', () => this.active?.position(), true);
  }
  sync() {
    for (const [select, control] of this.controls) {
      if (!this.root.contains(select)) { if (this.active === control) this.close(); control.dispose(); this.controls.delete(select); }
    }
    for (const select of this.root.querySelectorAll<HTMLSelectElement>('select:not([data-native-only])')) {
      let control = this.controls.get(select);
      if (!control) {
        control = new Dropdown(select, () => {
          if (this.active === control) { this.close(); return; }
          this.close(); this.active = control; control!.open();
        }, restore => this.close(restore ?? true));
        this.controls.set(select, control);
      }
      control.sync();
    }
    if (this.active && !this.active.isOpen) this.active = undefined;
  }
  close(restoreFocus = false) { const active = this.active; this.active = undefined; active?.close(restoreFocus); }
  closeWithin(root: HTMLElement) { if (this.active && root.contains(this.active.trigger)) this.close(); }
  focus(select: HTMLSelectElement) { this.controls.get(select)?.trigger.focus(); }
}

let nextId = 0;
class Dropdown {
  readonly trigger = document.createElement('button');
  private wrapper = document.createElement('span');
  private menu = document.createElement('div');
  private caption = document.createElement('span');
  private leadingIcon = document.createElement('span');
  private signature = '';
  private index = -1;
  private search = '';
  private searchedAt = 0;
  get isOpen() { return !this.menu.hidden; }
  constructor(private select: HTMLSelectElement, toggle: () => void, private dismiss: (restore?: boolean) => void) {
    const id = select.id || `tandem-picker-${++nextId}`;
    this.wrapper.className = 'tandem-dropdown'; this.wrapper.dataset.select = id;
    select.before(this.wrapper); this.wrapper.append(select, this.trigger, this.menu);
    select.hidden = true; select.tabIndex = -1;
    this.trigger.type = 'button'; this.trigger.className = 'dropdown-trigger'; this.trigger.id = `${id}-trigger`;
    this.trigger.setAttribute('aria-haspopup', 'listbox'); this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-controls', `${id}-options`);
    if (select.dataset.focusKey) this.trigger.dataset.focusKey = `${select.dataset.focusKey}:picker`;
    this.caption.className = 'dropdown-caption';
    const chevron = document.createElement('span'); chevron.className = 'codicon codicon-chevron-down'; chevron.setAttribute('aria-hidden', 'true');
    this.leadingIcon.setAttribute('aria-hidden', 'true');
    this.leadingIcon.hidden = true;
    this.trigger.append(this.leadingIcon, this.caption, chevron); this.trigger.onclick = toggle;
    this.menu.id = `${id}-options`; this.menu.className = 'dropdown-menu'; this.menu.hidden = true;
    this.menu.setAttribute('role', 'listbox'); this.menu.tabIndex = -1;
    this.trigger.onkeydown = event => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); if (this.menu.hidden) toggle();
        if (event.key === 'Home' || event.key === 'End') this.move(event.key === 'Home' ? 0 : this.select.options.length - 1, event.key === 'Home' ? 1 : -1);
      }
    };
    this.menu.onkeydown = event => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') this.dismiss();
        else if (event.key === 'Enter' || event.key === ' ') this.choose(this.index);
        else if (event.key === 'Home' || event.key === 'End') this.move(event.key === 'Home' ? 0 : this.select.options.length - 1, event.key === 'Home' ? 1 : -1);
        else this.move(this.index + (event.key === 'ArrowDown' ? 1 : -1), event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Tab') { this.trigger.focus(); this.dismiss(false); }
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); this.search = Date.now() - this.searchedAt > 600 ? event.key : this.search + event.key;
        this.searchedAt = Date.now();
        const found = [...this.select.options].findIndex(option => !option.disabled && option.text.toLowerCase().startsWith(this.search.toLowerCase()));
        if (found >= 0) this.move(found, 1);
      }
    };
    select.addEventListener('change', () => this.sync());
    select.addEventListener('invalid', event => {
      event.preventDefault(); this.trigger.setAttribute('aria-invalid', 'true'); this.trigger.focus();
      if (this.menu.hidden) toggle();
    });
  }
  contains(target: Node) { return this.wrapper.contains(target); }
  sync() {
    this.trigger.disabled = this.select.disabled; this.trigger.title = this.select.title;
    if (this.select.validity.valid) this.trigger.removeAttribute('aria-invalid');
    const label = this.select.getAttribute('aria-label') ?? 'Choose';
    this.trigger.setAttribute('aria-label', `${label}: ${this.select.selectedOptions[0]?.text ?? 'Choose…'}`);
    this.menu.setAttribute('aria-label', label);
    this.caption.textContent = this.select.selectedOptions[0]?.text ?? 'Choose…';
    const selectedIcon = this.select.selectedOptions[0]?.dataset.icon;
    this.leadingIcon.hidden = !selectedIcon;
    this.leadingIcon.className = `dropdown-leading-icon codicon codicon-${selectedIcon ?? 'circle-outline'}`;
    const signature = JSON.stringify([...this.select.options].map(o => [o.value, o.text, o.title, o.disabled, o.dataset.icon]));
    if (signature !== this.signature) {
      this.signature = signature; this.menu.replaceChildren();
      [...this.select.options].forEach((option, index) => {
        const row = document.createElement('div'); row.className = 'dropdown-option'; row.id = `${this.menu.id}-${index}`;
        row.setAttribute('role', 'option'); row.setAttribute('aria-disabled', String(option.disabled));
        const check = document.createElement('span'); check.className = 'dropdown-check codicon codicon-check'; check.setAttribute('aria-hidden', 'true');
        const copy = document.createElement('span'); copy.className = 'dropdown-copy';
        const name = document.createElement('span'); name.textContent = option.text; copy.append(name);
        if (option.title) { const description = document.createElement('span'); description.className = 'dropdown-description'; description.textContent = option.title; copy.append(description); }
        row.append(check);
        if (option.dataset.icon) { const icon = document.createElement('span'); icon.className = `dropdown-option-icon codicon codicon-${option.dataset.icon}`; icon.setAttribute('aria-hidden', 'true'); row.append(icon); }
        row.append(copy); row.onclick = () => this.choose(index);
        row.onpointermove = () => { if (!option.disabled) this.highlight(index); };
        // Keep focus in the listbox while the pointer chooses a row.
        row.onmousedown = event => event.preventDefault(); this.menu.append(row);
      });
      if (!this.menu.hidden) this.move(Math.max(0, this.select.selectedIndex), 1);
    }
    [...this.menu.children].forEach((row, index) => row.setAttribute('aria-selected', String(index === this.select.selectedIndex)));
    if (this.select.disabled || this.select.closest('[hidden]:not(select)')) this.close();
    if (!this.menu.hidden) this.position();
  }
  open() {
    if (this.select.disabled) return;
    this.menu.hidden = false; this.trigger.setAttribute('aria-expanded', 'true'); this.search = '';
    this.position(); this.move(Math.max(0, this.select.selectedIndex), 1); this.menu.focus({ preventScroll: true });
  }
  close(restoreFocus = false) {
    const wasOpen = !this.menu.hidden; this.menu.hidden = true; this.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && wasOpen && this.trigger.isConnected && !this.trigger.disabled) this.trigger.focus({ preventScroll: true });
  }
  position() {
    const anchor = this.trigger.getBoundingClientRect(), gap = 5, edge = 8;
    const width = Math.min(Math.max(anchor.width, 200), window.innerWidth - edge * 2);
    const below = window.innerHeight - anchor.bottom - gap - edge, above = anchor.top - gap - edge;
    const down = below >= Math.min(240, this.menu.scrollHeight) || below >= above;
    this.menu.style.width = `${width}px`; this.menu.style.maxHeight = `${Math.max(24, Math.min(260, down ? below : above))}px`;
    this.menu.style.left = `${Math.max(edge, Math.min(anchor.left, window.innerWidth - width - edge))}px`;
    this.menu.style.top = `${down ? anchor.bottom + gap : Math.max(edge, anchor.top - this.menu.getBoundingClientRect().height - gap)}px`;
  }
  private highlight(index: number) {
    this.index = index;
    [...this.menu.children].forEach((row, i) => (row as HTMLElement).dataset.active = String(i === index));
    const row = this.menu.children[index] as HTMLElement | undefined;
    if (row) { this.menu.setAttribute('aria-activedescendant', row.id); row.scrollIntoView?.({ block: 'nearest' }); }
  }
  private move(start: number, direction: number) {
    const options = [...this.select.options];
    for (let n = 0; n < options.length; n++) {
      const index = ((start + direction * n) % options.length + options.length) % options.length;
      if (!options[index]!.disabled) { this.highlight(index); return; }
    }
    this.index = -1; this.menu.removeAttribute('aria-activedescendant');
  }
  private choose(index: number) {
    if (this.select.disabled || index < 0 || this.select.options[index]?.disabled) return;
    const changed = this.select.selectedIndex !== index;
    this.select.selectedIndex = index; this.dismiss(); this.sync();
    if (changed) this.select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  dispose() { this.close(); this.wrapper.remove(); }
}
