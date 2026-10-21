// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { scrollShadows } from '../src/ui/scroll-shadows';

let dispose: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] }); });
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function scroller() {
  const element = document.createElement('div');
  element.style.overflowX = 'auto';
  element.style.overflowY = 'auto';
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 300 },
    clientWidth: { configurable: true, value: 100 },
    scrollWidth: { configurable: true, value: 250 },
  });
  document.body.append(element);
  return element;
}
const paint = () => vi.advanceTimersByTime(20);

it('marks only edges with hidden content, including horizontal and nested scrolling', () => {
  const outer = scroller(), inner = scroller();
  outer.append(inner);
  dispose = scrollShadows();
  paint();
  expect(inner.dataset.scrollShadow).toBe('bottom right');
  inner.scrollTop = 90;
  inner.scrollLeft = 50;
  inner.dispatchEvent(new Event('scroll'));
  paint();
  expect(inner.dataset.scrollShadow).toBe('top bottom left right');
  expect(outer.dataset.scrollShadow).toBe('bottom right');
  inner.scrollTop = 200;
  inner.scrollLeft = 150;
  inner.dispatchEvent(new Event('scroll'));
  paint();
  expect(inner.dataset.scrollShadow).toBe('top left');
});

it('discovers dynamic lists and clears shadows when content no longer overflows', async () => {
  dispose = scrollShadows();
  paint();
  const element = scroller();
  await Promise.resolve();
  paint();
  expect(element.dataset.scrollShadow).toBe('bottom right');
  Object.defineProperties(element, { scrollHeight: { value: 100 }, scrollWidth: { value: 100 } });
  element.textContent = 'Short list';
  await Promise.resolve();
  paint();
  expect(element.hasAttribute('data-scroll-shadow')).toBe(false);
});

it('handles RTL scroll offsets and skips clipped content and Monaco', () => {
  const element = scroller();
  element.style.direction = 'rtl';
  const clipped = scroller();
  clipped.style.overflowX = 'hidden';
  clipped.style.overflowY = 'hidden';
  const monaco = scroller();
  monaco.className = 'monaco-editor';
  dispose = scrollShadows();
  paint();
  expect(element.dataset.scrollShadow).toBe('bottom left');
  expect(clipped.hasAttribute('data-scroll-shadow')).toBe(false);
  expect(monaco.hasAttribute('data-scroll-shadow')).toBe(false);
  element.scrollLeft = -150;
  element.dispatchEvent(new Event('scroll'));
  paint();
  expect(element.dataset.scrollShadow).toBe('bottom right');
});

it('renders above opaque cards without changing their shadows and removes overlays on disposal', () => {
  const element = scroller();
  element.style.boxShadow = '0 3px 12px black';
  element.style.setProperty('--scroll-shadow-base', '0 1px 2px red');
  dispose = scrollShadows();
  paint();
  const overlay = document.querySelector<HTMLElement>('.scroll-shadow-overlay')!;
  expect(overlay.parentElement).toBe(document.body);
  expect(overlay.dataset.scrollShadow).toBe('bottom right');
  expect(overlay.getAttribute('aria-hidden')).toBe('true');
  expect(element.style.boxShadow).toBe('0 3px 12px black');
  expect(element.style.getPropertyValue('--scroll-shadow-base')).toBe('0 1px 2px red');
  dispose();
  expect(element.hasAttribute('data-scroll-shadow')).toBe(false);
  expect(element.style.getPropertyValue('--scroll-shadow-base')).toBe('0 1px 2px red');
  expect(document.querySelector('.scroll-shadow-overlay')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  element.dispatchEvent(new Event('scroll'));
  expect(vi.getTimerCount()).toBe(0);
});
