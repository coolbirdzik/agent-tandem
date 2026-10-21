// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { hoverHints } from '../src/ui/hover-hints';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); vi.useRealTimers(); document.body.replaceChildren(); });
const over = (node: Element) => node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
const tip = () => document.querySelector<HTMLElement>('[role=tooltip]')!;

it('styles dynamic titles after a delay, preserves text safely and restores titles on exit', () => {
  vi.useFakeTimers(); dispose = hoverHints();
  const button = document.createElement('button');
  button.title = 'Refresh <models>\nCLI path'; document.body.append(button);
  over(button);
  expect(button.title).toBe('');
  vi.advanceTimersByTime(449); expect(tip().hidden).toBe(true);
  vi.advanceTimersByTime(1);
  expect(tip().textContent).toBe('Refresh <models>\nCLI path');
  expect(tip().children.length).toBe(0);
  expect(button.getAttribute('aria-describedby')).toBe(tip().id);
  button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  vi.advanceTimersByTime(120);
  expect(tip().hidden).toBe(true); expect(button.title).toBe('Refresh <models>\nCLI path');
  expect(button.hasAttribute('aria-describedby')).toBe(false);
});

it('supports keyboard focus, Escape, and existing accessible descriptions', () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<button title="Send message" aria-describedby="help">Send</button>';
  const button = document.querySelector('button')!; dispose = hoverHints();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })); button.focus();
  vi.advanceTimersByTime(0);
  expect(tip().hidden).toBe(false);
  expect(button.getAttribute('aria-describedby')).toBe(`help ${tip().id}`);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(tip().hidden).toBe(true); expect(button.getAttribute('aria-describedby')).toBe('help');
});

it('keeps hints open when the pointer enters them and dismisses on scrolling', () => {
  vi.useFakeTimers(); document.body.innerHTML = '<button title="Details">Info</button>';
  const button = document.querySelector('button')!; dispose = hoverHints();
  over(button); vi.advanceTimersByTime(450);
  button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: tip() }));
  over(tip()); expect(tip().hidden).toBe(false);
  document.dispatchEvent(new Event('scroll')); expect(tip().hidden).toBe(true);
});

it('dismisses removed or updated targets without overwriting new titles', async () => {
  vi.useFakeTimers(); document.body.innerHTML = '<button title="Old">Info</button>';
  const button = document.querySelector('button')!; dispose = hoverHints();
  over(button); vi.advanceTimersByTime(450);
  button.title = 'New'; await Promise.resolve();
  expect(button.title).toBe('New'); expect(tip().hidden).toBe(true);
  over(button); vi.advanceTimersByTime(450); button.remove(); await Promise.resolve();
  expect(tip().hidden).toBe(true); expect(button.title).toBe('New');
});

it('clamps hints to the viewport and cleans up pending hints', () => {
  vi.useFakeTimers(); document.body.innerHTML = '<button title="Details">Info</button>';
  const button = document.querySelector('button')!; dispose = hoverHints();
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ left: 1000, top: 760, bottom: 780, width: 20 } as DOMRect);
  vi.spyOn(tip(), 'getBoundingClientRect').mockReturnValue({ width: 200, height: 60 } as DOMRect);
  over(button); vi.advanceTimersByTime(450);
  expect(tip().style.left).toBe('816px'); expect(tip().style.top).toBe('694px');
  dispose(); expect(button.title).toBe('Details'); expect(document.querySelector('[role=tooltip]')).toBeNull();
  over(button); expect(vi.getTimerCount()).toBe(0);
});
