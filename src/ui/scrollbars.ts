import { scrollShadows } from './scroll-shadows';

/** Use the shadow layer's clipped viewport for scrollbars that never occupy layout. */
export function autoHideScrollbars(root: Document = document): () => void {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  const overlays = new Map<HTMLElement, HTMLElement>();
  const view = root.defaultView!;
  const generatedIds = new Map<HTMLElement, string>();
  let nextId = 0;
  let stopDrag: (() => void) | undefined;
  let dragTarget: HTMLElement | undefined;
  const hadClass = root.documentElement.classList.contains('overlay-scrollbars');
  root.documentElement.classList.add('overlay-scrollbars');

  function reveal(target: Element) {
    clearTimeout(timers.get(target));
    target.classList.add('is-scrolling');
    overlays.get(target as HTMLElement)?.classList.add('is-scrolling');
    timers.set(target, setTimeout(() => {
      target.classList.remove('is-scrolling');
      overlays.get(target as HTMLElement)?.classList.remove('is-scrolling');
      timers.delete(target);
    }, 800));
  }

  const disposeShadows = scrollShadows(root, (element, overlay) => {
    overlays.set(element, overlay);
    overlay.removeAttribute('aria-hidden');
    if (!element.id) {
      let id: string;
      do { id = `tandem-scroll-${++nextId}`; } while (root.getElementById(id));
      element.id = id;
      generatedIds.set(element, id);
    }
    overlay.classList.toggle('is-scrolling', element.classList.contains('is-scrolling'));
    const styles = view.getComputedStyle(element);
    const page = element === root.scrollingElement;
    const width = page ? root.documentElement.clientWidth : element.clientWidth;
    const height = page ? root.documentElement.clientHeight : element.clientHeight;
    const vertical = element.scrollHeight > height + 1 && (page || /auto|scroll|overlay/.test(styles.overflowY || styles.overflow));
    const horizontal = element.scrollWidth > width + 1 && (page || /auto|scroll|overlay/.test(styles.overflowX || styles.overflow));
    for (const axis of ['y', 'x'] as const) {
      let track = overlay.querySelector<HTMLElement>(`[data-axis="${axis}"]`);
      if (!(axis === 'y' ? vertical : horizontal)) { track?.remove(); continue; }
      const size = axis === 'y' ? height : width;
      const extent = axis === 'y' ? element.scrollHeight : element.scrollWidth;
      const length = Math.max(0, size - ((axis === 'y' ? horizontal : vertical) ? 10 : 0));
      const thumbSize = Math.min(length, Math.max(20, length * size / extent));
      const max = extent - size;
      const rtl = axis === 'x' && styles.direction === 'rtl';
      const offset = () => axis === 'y' ? element.scrollTop : rtl ? max + element.scrollLeft : element.scrollLeft;
      const setOffset = (value: number) => {
        value = Math.max(0, Math.min(max, value));
        if (axis === 'y') element.scrollTop = value;
        else element.scrollLeft = rtl ? value - max : value;
        reveal(element);
      };
      if (!track) {
        track = root.createElement('div');
        track.className = 'scrollbar-track';
        track.dataset.axis = axis;
        track.tabIndex = 0;
        track.setAttribute('role', 'scrollbar');
        track.setAttribute('aria-label', axis === 'y' ? 'Vertical scroll' : 'Horizontal scroll');
        track.setAttribute('aria-orientation', axis === 'y' ? 'vertical' : 'horizontal');
        const thumb = root.createElement('div');
        thumb.className = 'scrollbar-thumb';
        track.append(thumb);
        overlay.append(track);
      }
      const thumb = track.firstElementChild as HTMLElement;
      const travel = length - thumbSize;
      Object.assign(track.style, axis === 'y' ? { height: `${length}px` } : { width: `${length}px` });
      Object.assign(thumb.style, axis === 'y'
        ? { height: `${thumbSize}px`, top: `${travel * offset() / max}px` }
        : { width: `${thumbSize}px`, left: `${travel * offset() / max}px` });
      track.setAttribute('aria-controls', element.id);
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', String(max));
      track.setAttribute('aria-valuenow', String(Math.round(offset())));
      track.onkeydown = event => {
        let value = offset();
        if (event.key === 'Home') value = 0;
        else if (event.key === 'End') value = max;
        else if (event.key === 'PageDown') value += size;
        else if (event.key === 'PageUp') value -= size;
        else if (event.key === (axis === 'y' ? 'ArrowDown' : 'ArrowRight')) value += 40;
        else if (event.key === (axis === 'y' ? 'ArrowUp' : 'ArrowLeft')) value -= 40;
        else return;
        event.preventDefault();
        setOffset(value);
      };
      track.onwheel = event => {
        event.preventDefault();
        const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size : 1;
        setOffset(offset() + (axis === 'y' ? event.deltaY : event.deltaX || event.deltaY) * scale);
      };
      track.onpointerdown = event => {
        if (event.button !== 0 || !travel) return;
        event.preventDefault();
        stopDrag?.();
        const coordinate = (e: PointerEvent) => axis === 'y' ? e.clientY : e.clientX;
        if (event.target !== thumb) {
          const rect = track!.getBoundingClientRect();
          setOffset((coordinate(event) - (axis === 'y' ? rect.top : rect.left) - thumbSize / 2) * max / travel);
        }
        const start = coordinate(event), initial = offset(), pointerId = event.pointerId;
        dragTarget = element;
        track!.classList.add('is-dragging');
        track!.setPointerCapture?.(pointerId);
        const move = (e: PointerEvent) => {
          if (e.pointerId === pointerId) setOffset(initial + (coordinate(e) - start) * max / travel);
        };
        const end = (e: PointerEvent) => { if (e.pointerId === pointerId) stopDrag?.(); };
        stopDrag = () => {
          track!.classList.remove('is-dragging');
          if (track!.hasPointerCapture?.(pointerId)) track!.releasePointerCapture(pointerId);
          root.removeEventListener('pointermove', move);
          root.removeEventListener('pointerup', end);
          root.removeEventListener('pointercancel', end);
          stopDrag = undefined;
          dragTarget = undefined;
          reveal(element);
        };
        root.addEventListener('pointermove', move);
        root.addEventListener('pointerup', end);
        root.addEventListener('pointercancel', end);
      };
    }
  }, element => {
    // Release every reference as soon as a message or its scrollbar disappears,
    // including the last scroller (there may never be another overlay render).
    if (dragTarget === element) stopDrag?.();
    clearTimeout(timers.get(element));
    timers.delete(element);
    element.classList.remove('is-scrolling');
    overlays.delete(element);
    const id = generatedIds.get(element);
    if (id && element.id === id) element.removeAttribute('id');
    generatedIds.delete(element);
  });
  const onScroll = (event: Event) => {
    const target = event.target === root ? root.scrollingElement : event.target;
    if (target instanceof Element && !target.closest('.monaco-editor, .monaco-diff-editor')) reveal(target);
  };
  const onPointerOver = (event: Event) => {
    if (!(event.target instanceof Element)) return;
    for (const [element, overlay] of overlays) {
      if (element.contains(event.target) || overlay.contains(event.target)) reveal(element);
    }
  };
  root.addEventListener('scroll', onScroll, { capture: true, passive: true });
  root.addEventListener('pointerover', onPointerOver, { passive: true });
  return () => {
    stopDrag?.();
    disposeShadows();
    root.removeEventListener('scroll', onScroll, true);
    root.removeEventListener('pointerover', onPointerOver);
    for (const [target, timer] of timers) {
      clearTimeout(timer);
      target.classList.remove('is-scrolling');
    }
    timers.clear();
    overlays.clear();
    for (const [element, id] of generatedIds) {
      if (element.id === id) element.removeAttribute('id');
    }
    generatedIds.clear();
    if (!hadClass) root.documentElement.classList.remove('overlay-scrollbars');
  };
}
