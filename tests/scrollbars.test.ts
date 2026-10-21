// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { autoHideScrollbars } from '../src/ui/scrollbars';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); vi.useRealTimers(); document.body.replaceChildren(); });

it('shows nested scrollbars independently and hides them after scrolling stops', () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="outer"><div id="inner"></div></div>';
  const outer = document.getElementById('outer')!, inner = document.getElementById('inner')!;
  dispose = autoHideScrollbars();
  inner.dispatchEvent(new Event('scroll'));
  expect(inner.classList.contains('is-scrolling')).toBe(true);
  expect(outer.classList.contains('is-scrolling')).toBe(false);
  vi.advanceTimersByTime(500);
  inner.dispatchEvent(new Event('scroll'));
  outer.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(500);
  expect(inner.classList.contains('is-scrolling')).toBe(true);
  vi.advanceTimersByTime(300);
  expect(inner.classList.contains('is-scrolling')).toBe(false);
  expect(outer.classList.contains('is-scrolling')).toBe(false);
});

it('handles page scrolling and removes listeners and pending timers on disposal', () => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement });
  dispose = autoHideScrollbars();
  document.dispatchEvent(new Event('scroll'));
  expect(document.documentElement.classList.contains('is-scrolling')).toBe(true);
  dispose();
  expect(document.documentElement.classList.contains('is-scrolling')).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  document.dispatchEvent(new Event('scroll'));
  expect(document.documentElement.classList.contains('is-scrolling')).toBe(false);
  Reflect.deleteProperty(document, 'scrollingElement');
});

function scroller() {
  const element = document.createElement('div');
  element.style.overflowX = 'auto';
  element.style.overflowY = 'auto';
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 100 }, scrollHeight: { configurable: true, value: 400 },
    clientWidth: { configurable: true, value: 200 }, scrollWidth: { configurable: true, value: 500 },
  });
  document.body.append(element);
  return element;
}
const paint = () => vi.advanceTimersByTime(20);

it('renders both overlay axes without wrapping content and supports keyboard and wheel scrolling', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] });
  const element = scroller();
  dispose = autoHideScrollbars();
  paint();
  const vertical = document.querySelector<HTMLElement>('[data-axis="y"]')!;
  const horizontal = document.querySelector<HTMLElement>('[data-axis="x"]')!;
  expect(document.documentElement.classList.contains('overlay-scrollbars')).toBe(true);
  expect(element.parentElement).toBe(document.body);
  expect(element.children.length).toBe(0);
  expect(vertical.parentElement?.parentElement).toBe(document.body);
  expect(vertical.getAttribute('aria-controls')).toBe(element.id);
  expect(vertical.style.height).toBe('90px');
  vertical.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(element.scrollTop).toBe(300);
  horizontal.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, bubbles: true, cancelable: true }));
  expect(element.scrollLeft).toBe(30);
  expect(vertical.parentElement?.classList.contains('is-scrolling')).toBe(true);
  vi.advanceTimersByTime(800);
  expect(vertical.parentElement?.classList.contains('is-scrolling')).toBe(false);
  dispose();
  expect(element.id).toBe('');
  expect(document.documentElement.classList.contains('overlay-scrollbars')).toBe(false);
  expect(document.querySelector('.scrollbar-track')).toBeNull();
});

it('supports dragging, cancellation and independent RTL horizontal scrolling', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] });
  const element = scroller();
  element.style.direction = 'rtl';
  dispose = autoHideScrollbars();
  paint();
  const horizontal = document.querySelector<HTMLElement>('[data-axis="x"]')!;
  horizontal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
  expect(element.scrollLeft).toBe(-300);
  const vertical = document.querySelector<HTMLElement>('[data-axis="y"]')!;
  const pointer = (type: string, y: number) => {
    const event = new MouseEvent(type, { clientY: y, button: 0, bubbles: true });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    return event;
  };
  vertical.firstElementChild!.dispatchEvent(pointer('pointerdown', 0));
  document.dispatchEvent(pointer('pointermove', 30));
  expect(element.scrollTop).toBeCloseTo(300 * 30 / 67.5);
  document.dispatchEvent(pointer('pointercancel', 30));
  expect(vertical.classList.contains('is-dragging')).toBe(false);
  const offset = element.scrollTop;
  document.dispatchEvent(pointer('pointermove', 50));
  expect(element.scrollTop).toBe(offset);
});

it('discovers new overflowing content, removes obsolete bars, and leaves Monaco in charge of its scrollbar', async () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] });
  dispose = autoHideScrollbars();
  paint();
  const element = scroller();
  const editor = scroller();
  editor.className = 'monaco-editor';
  await Promise.resolve();
  paint();
  expect(document.querySelectorAll('.scrollbar-track')).toHaveLength(2);
  Object.defineProperties(element, { scrollHeight: { value: 100 }, scrollWidth: { value: 200 } });
  element.textContent = 'Short content';
  await Promise.resolve();
  paint();
  expect(document.querySelectorAll('.scrollbar-track')).toHaveLength(0);
});
