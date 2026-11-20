import { positionPicker } from './dropdown';

const formatter = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { calendar: 'gregory', timeZone: 'UTC', ...options });
const monthYear = formatter({ month: 'long', year: 'numeric' });
const monthName = formatter({ month: 'short' });
const weekday = formatter({ weekday: 'short' });
const fullDate = formatter({ dateStyle: 'full' });
const year = formatter({ year: 'numeric' });
const dayNumber = new Intl.NumberFormat(undefined, { useGrouping: false });

function today() {
  const date = new Date();
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}
const isoDay = (date: Date) => [String(date.getUTCFullYear()).padStart(4, '0'), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join('-');
const mondayOffset = (date: Date) => (date.getUTCDay() + 6) % 7;
function shiftDay(date: Date, days: number) {
  const next = new Date(date); next.setUTCDate(next.getUTCDate() + days); return next;
}
function shiftMonth(date: Date, months: number) {
  const next = new Date(date); next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + months + 1, 0);
  next.setUTCDate(Math.min(date.getUTCDate(), next.getUTCDate())); return next;
}
function button(text: string, className: string, action: () => void, icon?: string) {
  const node = document.createElement('button'); node.type = 'button'; node.className = className; node.onclick = action;
  if (icon) {
    const mark = document.createElement('span'); mark.className = `codicon codicon-${icon}`; mark.setAttribute('aria-hidden', 'true');
    node.append(mark); node.setAttribute('aria-label', text);
  } else node.textContent = text;
  return node;
}

interface DateField { input: HTMLInputElement; wrapper: HTMLElement; trigger: HTMLButtonElement; label: string }

/** The date input keeps native keyboard entry and the ISO value used by the form. */
export class DatePickers {
  private fields: DateField[] = [];
  private active?: DateField;
  private date = today();
  private choosingMonth = false;
  private panel = document.createElement('div');
  private grid = document.createElement('div');
  private heading = button('', 'calendar-title', () => { this.choosingMonth = !this.choosingMonth; this.render(); });
  private previous = button('Previous month', 'calendar-arrow', () => this.navigate(-1), 'chevron-left');
  private next = button('Next month', 'calendar-arrow', () => this.navigate(1), 'chevron-right');
  private clear = button('Clear', 'calendar-action', () => this.choose(''));

  constructor(root: HTMLElement) {
    this.panel.id = 'date-picker'; this.panel.className = 'dropdown-menu calendar-picker'; this.panel.hidden = true;
    this.panel.setAttribute('role', 'dialog');
    const header = document.createElement('div'); header.className = 'calendar-header';
    header.append(this.previous, this.heading, this.next);
    const footer = document.createElement('div'); footer.className = 'calendar-footer';
    footer.append(this.clear, button('Today', 'calendar-action', () => this.choose(isoDay(today()))));
    this.panel.append(header, this.grid, footer);
    for (const input of root.querySelectorAll<HTMLInputElement>('input[type=date]')) {
      const label = input.getAttribute('aria-label') || input.labels?.[0]?.textContent?.trim() || 'Date';
      const wrapper = document.createElement('span'); wrapper.className = 'date-field';
      const trigger = button(`Choose date for ${label}`, 'date-field-button', () => this.toggle(field), 'calendar');
      const field: DateField = { input, wrapper, trigger, label };
      input.setAttribute('aria-label', label);
      trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
      input.before(wrapper); wrapper.append(input, trigger); this.fields.push(field);
      input.addEventListener('keydown', event => {
        if (event.key === 'F4' || (event.altKey && event.key === 'ArrowDown')) { event.preventDefault(); this.open(field); }
      });
      input.addEventListener('input', () => { if (this.active === field) this.close(); });
      wrapper.addEventListener('keydown', event => {
        if (event.key === 'Escape' && this.active === field) { event.preventDefault(); event.stopPropagation(); this.close(true); }
      });
    }
    window.addEventListener('click', event => this.dismissOutside(event), true);
    window.addEventListener('focusin', event => this.dismissOutside(event));
    window.addEventListener('resize', () => this.position());
    window.addEventListener('scroll', () => this.position(), true);
    this.sync();
  }

  sync() {
    for (const { input, trigger } of this.fields) trigger.disabled = input.disabled;
    if (this.active && (this.active.input.disabled || this.active.wrapper.closest('[hidden], dialog:not([open])'))) this.close();
  }

  private close(restore = false) {
    if (!this.active) return;
    const { trigger } = this.active; this.active = undefined;
    this.panel.hidden = true; this.panel.remove();
    trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-controls');
    if (restore) trigger.focus({ preventScroll: true });
  }

  private dismissOutside(event: Event) {
    if (this.active && !this.active.wrapper.contains(event.target as Node)) this.close();
  }

  private toggle(field: DateField) {
    if (this.active === field) this.close(true); else this.open(field);
  }

  private open(field: DateField) {
    if (field.input.disabled) return;
    this.close(); this.active = field; this.date = field.input.valueAsDate ?? today(); this.choosingMonth = false;
    field.wrapper.append(this.panel); this.panel.hidden = false;
    this.panel.setAttribute('aria-label', `Calendar for ${field.label}`);
    field.trigger.setAttribute('aria-expanded', 'true'); field.trigger.setAttribute('aria-controls', this.panel.id);
    this.render(true);
  }

  private position() { if (this.active) positionPicker(this.active.wrapper, this.panel, 280, 360); }

  private choose(value: string) {
    const input = this.active!.input, previous = input.value;
    this.close(true); input.value = value;
    if (input.value !== previous) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  private navigate(direction: number) { this.move(shiftMonth(this.date, direction * (this.choosingMonth ? 12 : 1))); }

  private move(date: Date, focus = false) {
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1) return;
    this.date = date; this.render(focus);
  }

  private render(focus = false) {
    const selected = this.active!.input.value, current = isoDay(today());
    this.heading.textContent = this.choosingMonth ? year.format(this.date) : monthYear.format(this.date);
    this.heading.title = this.choosingMonth ? 'Show calendar days' : 'Choose month and year';
    this.previous.setAttribute('aria-label', this.choosingMonth ? 'Previous year' : 'Previous month');
    this.next.setAttribute('aria-label', this.choosingMonth ? 'Next year' : 'Next month');
    this.clear.disabled = !selected;
    this.grid.replaceChildren(); this.grid.className = this.choosingMonth ? 'calendar-months' : 'calendar-days';
    if (this.choosingMonth) {
      this.grid.removeAttribute('role'); this.grid.removeAttribute('aria-label');
      for (let month = 0; month < 12; month++) {
        const date = shiftMonth(this.date, month - this.date.getUTCMonth());
        if (!Number.isFinite(date.getTime())) break;
        const option = button(monthName.format(date), 'calendar-cell', () => { this.choosingMonth = false; this.move(date, true); });
        if (month === this.date.getUTCMonth()) option.setAttribute('aria-current', 'true');
        this.grid.append(option);
      }
      this.position(); return;
    }
    this.grid.setAttribute('role', 'grid'); this.grid.setAttribute('aria-label', monthYear.format(this.date));
    const names = document.createElement('div'); names.className = 'calendar-row'; names.setAttribute('role', 'row');
    for (let i = 0; i < 7; i++) {
      const name = document.createElement('span'); name.setAttribute('role', 'columnheader');
      name.textContent = weekday.format(new Date(Date.UTC(2024, 0, i + 1))); names.append(name);
    }
    this.grid.append(names);
    const first = new Date(this.date); first.setUTCDate(1);
    const start = shiftDay(first, -mondayOffset(first));
    let target: HTMLButtonElement | undefined;
    for (let week = 0; week < 6; week++) {
      const row = document.createElement('div'); row.className = 'calendar-row'; row.setAttribute('role', 'row');
      for (let i = 0; i < 7; i++) {
        const date = shiftDay(start, week * 7 + i);
        const cell = document.createElement('span'); cell.setAttribute('role', 'gridcell'); row.append(cell);
        if (!Number.isFinite(date.getTime())) continue;
        const value = isoDay(date); cell.setAttribute('aria-selected', String(value === selected));
        const day = button(dayNumber.format(date.getUTCDate()), 'calendar-cell', () => this.choose(value));
        day.setAttribute('aria-label', fullDate.format(date)); day.tabIndex = -1; day.disabled = date.getUTCFullYear() < 1;
        if (value === current) day.setAttribute('aria-current', 'date');
        if (date.getUTCMonth() !== this.date.getUTCMonth()) day.classList.add('calendar-outside');
        if (date.getTime() === this.date.getTime()) { day.tabIndex = 0; target = day; }
        day.onkeydown = event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.choose(value); return; }
          const offset = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -mondayOffset(date), End: 6 - mondayOffset(date) } as Record<string, number>)[event.key];
          const change = event.key === 'PageUp' ? -1 : event.key === 'PageDown' ? 1 : 0;
          if (offset === undefined && !change) return;
          event.preventDefault(); this.move(change ? shiftMonth(date, change * (event.shiftKey ? 12 : 1)) : shiftDay(date, offset!), true);
        };
        cell.append(day);
      }
      this.grid.append(row);
    }
    this.position();
    if (focus && target) { target.focus({ preventScroll: true }); target.scrollIntoView?.({ block: 'nearest' }); }
  }
}
