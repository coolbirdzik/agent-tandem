// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dropdowns } from '../src/ui/dropdown';

const listeners: Array<[string, EventListenerOrEventListenerObject, any]> = [];
function picker() {
  document.body.innerHTML = '<select id="pick" aria-label="Model"><option value="a">Alpha</option><option value="bad" disabled>Disabled</option><option value="b" title="Fast reasoning">Beta</option></select><button id="outside">Outside</button>';
  const original = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => { listeners.push([type, listener, options]); original(type, listener, options); });
  const dropdowns = new Dropdowns(document.body); dropdowns.sync();
  const select = document.querySelector<HTMLSelectElement>('#pick')!, trigger = document.querySelector<HTMLButtonElement>('#pick-trigger')!, menu = document.querySelector<HTMLElement>('#pick-options')!;
  const key = (key: string) => menu.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { dropdowns, select, trigger, menu, key };
}
afterEach(() => { for (const [type, listener, options] of listeners.splice(0)) window.removeEventListener(type, listener, options); vi.restoreAllMocks(); document.body.replaceChildren(); });
describe('common dropdown', () => {
  it('replaces the native menu, exposes descriptions and chooses with arrows skipping disabled options', () => {
    const { select, trigger, menu, key } = picker(), change = vi.fn(); select.onchange = change;
    expect(select.hidden).toBe(true); trigger.click(); expect(document.activeElement).toBe(menu);
    expect(menu.textContent).toContain('Fast reasoning'); key('ArrowDown'); key('Enter');
    expect(select.value).toBe('b'); expect(change).toHaveBeenCalledTimes(1); expect(menu.hidden).toBe(true); expect(document.activeElement).toBe(trigger);
    trigger.click(); key('Enter'); expect(change).toHaveBeenCalledTimes(1);
  });
  it('supports Home/End, typeahead, Escape and Tab without submitting a form', () => {
    const { select, trigger, menu, key } = picker(); trigger.click(); key('End'); key('Home'); key('b'); key('Enter'); expect(select.value).toBe('b');
    trigger.click(); key('Escape'); expect(menu.hidden).toBe(true); expect(document.activeElement).toBe(trigger);
    trigger.click(); key('Tab'); expect(menu.hidden).toBe(true); trigger.click(); expect(menu.hidden).toBe(false);
  });
  it('preserves an open list on refresh, closes on outside focus/disable and cleans disconnected controls', () => {
    const { dropdowns, select, trigger, menu } = picker(); trigger.click(); const row = menu.firstElementChild;
    dropdowns.sync(); expect(menu.hidden).toBe(false); expect(menu.firstElementChild).toBe(row); expect(document.activeElement).toBe(menu);
    document.querySelector<HTMLButtonElement>('#outside')!.focus(); expect(menu.hidden).toBe(true);
    trigger.click(); select.disabled = true; dropdowns.sync(); expect(menu.hidden).toBe(true); expect(trigger.disabled).toBe(true);
    select.remove(); dropdowns.sync(); expect(document.querySelector('.dock-dropdown')).toBeNull();
  });
  it('renders untrusted labels as text and never chooses a disabled row', () => {
    const { select, trigger, menu } = picker(); select.options[0]!.text = '<img onerror="bad()">';
    select.dispatchEvent(new Event('change')); trigger.click(); (menu.children[1] as HTMLElement).click();
    expect(select.value).toBe('a'); expect(menu.querySelector('img')).toBeNull(); expect(menu.textContent).toContain('<img');
  });
  it('focuses the custom picker when a required hidden value fails form validation', () => {
    const { select, trigger, menu } = picker(); select.required = true; select.value = '';
    select.dispatchEvent(new Event('invalid', { cancelable: true }));
    expect(trigger.getAttribute('aria-invalid')).toBe('true'); expect(menu.hidden).toBe(false); expect(document.activeElement).toBe(menu);
  });
});
