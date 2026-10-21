/** Keep edge shadows in sync with scrolling, layout and dynamically rendered lists. */
export function scrollShadows(root: Document = document, decorateOverlay?: (element: HTMLElement, overlay: HTMLElement) => void,
  removeOverlay?: (element: HTMLElement) => void): () => void {
  const view = root.defaultView!;
  const tracked = new Set<HTMLElement>();
  const overlays = new Map<HTMLElement, HTMLElement>();
  let frame: number | undefined;
  let discover = true;
  const canScroll = (value: string) => /^(auto|scroll|overlay)$/.test(value);
  const resize = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => schedule()) : undefined;

  function update() {
    frame = undefined;
    if (discover) {
      discover = false;
      const candidates = new Set<HTMLElement>();
      for (const element of root.querySelectorAll<HTMLElement>('*')) {
        // Monaco owns its virtual scrolling and renders its own shadows.
        if (element.closest('.monaco-editor, .monaco-diff-editor, .scroll-shadow-overlay')) continue;
        const styles = view.getComputedStyle(element);
        if (element !== root.scrollingElement && !canScroll(styles.overflowX || styles.overflow) && !canScroll(styles.overflowY || styles.overflow)) continue;
        candidates.add(element);
        tracked.add(element);
      }
      for (const element of tracked) {
        if (candidates.has(element)) continue;
        restore(element);
        tracked.delete(element);
      }
      // Observe content as well as containers: streaming and image loads can
      // change scroll extents without changing the container's own dimensions.
      resize?.disconnect();
      if (root.documentElement) resize?.observe(root.documentElement);
      for (const element of tracked.keys()) {
        resize?.observe(element);
        for (const child of element.children) resize?.observe(child);
      }
    }
    for (const element of tracked.keys()) {
      const styles = view.getComputedStyle(element);
      const page = element === root.scrollingElement;
      const vertical = page || canScroll(styles.overflowY || styles.overflow);
      const horizontal = page || canScroll(styles.overflowX || styles.overflow);
      const edges: string[] = [];
      if (element.clientHeight && vertical && element.scrollHeight > element.clientHeight + 1) {
        if (element.scrollTop > 1) edges.push('top');
        if (element.scrollTop < element.scrollHeight - element.clientHeight - 1) edges.push('bottom');
      }
      if (element.clientWidth && horizontal && element.scrollWidth > element.clientWidth + 1) {
        const remaining = element.scrollWidth - element.clientWidth;
        const left = styles.direction === 'rtl' ? remaining + element.scrollLeft : element.scrollLeft;
        if (left > 1) edges.push('left');
        if (left < remaining - 1) edges.push('right');
      }
      if (edges.length) {
        element.setAttribute('data-scroll-shadow', edges.join(' '));
        renderOverlay(element, edges.join(' '));
      } else restore(element);
    }
  }

  function restore(element: HTMLElement) {
    element.removeAttribute('data-scroll-shadow');
    overlays.get(element)?.remove();
    if (overlays.delete(element)) removeOverlay?.(element);
  }

  function renderOverlay(element: HTMLElement, edges: string) {
    let overlay = overlays.get(element);
    const host = element.closest('dialog:modal') ?? root.body;
    if (!overlay) {
      overlay = root.createElement('div');
      overlay.className = 'scroll-shadow-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      overlays.set(element, overlay);
    }
    if (overlay.parentElement !== host) host.append(overlay);
    overlay.setAttribute('data-scroll-shadow', edges);
    const page = element === root.scrollingElement;
    const rect = element.getBoundingClientRect();
    const x = page ? 0 : rect.left + element.clientLeft;
    const y = page ? 0 : rect.top + element.clientTop;
    const width = page ? root.documentElement.clientWidth : element.clientWidth;
    const height = page ? root.documentElement.clientHeight : element.clientHeight;
    let top = Math.max(0, -y), left = Math.max(0, -x);
    let right = Math.max(0, x + width - view.innerWidth);
    let bottom = Math.max(0, y + height - view.innerHeight);
    let layer = 1;
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
      const style = view.getComputedStyle(parent);
      layer = Math.max(layer, (Number.parseInt(style.zIndex) || 0) + 1);
      if (parent === element) continue;
      const bounds = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowY || style.overflow)) {
        top = Math.max(top, bounds.top + parent.clientTop - y);
        bottom = Math.max(bottom, y + height - bounds.top - parent.clientTop - parent.clientHeight);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowX || style.overflow)) {
        left = Math.max(left, bounds.left + parent.clientLeft - x);
        right = Math.max(right, x + width - bounds.left - parent.clientLeft - parent.clientWidth);
      }
    }
    Object.assign(overlay.style, {
      left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`,
      borderRadius: view.getComputedStyle(element).borderRadius,
      zIndex: String(layer), clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px)`,
    });
    decorateOverlay?.(element, overlay);
  }

  function schedule() {
    frame ??= view.requestAnimationFrame(update);
  }
  const onLayout = () => { discover = true; schedule(); };
  const mutations = new view.MutationObserver(records => {
    const meaningful = records.filter(record => {
      if (record.target instanceof Element && record.target.closest('.scroll-shadow-overlay')) return false;
      if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node instanceof Element && node.classList.contains('scroll-shadow-overlay'))) return false;
      if (record.target instanceof Element && record.target.closest('.monaco-editor, .monaco-diff-editor')) return false;
      // Revealing a scrollbar does not change which elements can scroll.
      if (record.attributeName === 'class' && record.target instanceof Element) {
        const withoutScrolling = (value: string) => value.split(/\s+/).filter(name => name && name !== 'is-scrolling').sort().join(' ');
        return withoutScrolling(record.oldValue ?? '') !== withoutScrolling(record.target.getAttribute('class') ?? '');
      }
      return true;
    });
    if (!meaningful.length) return;
    if (meaningful.some(record => record.type !== 'characterData')) discover = true;
    schedule();
  });
  mutations.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
  root.addEventListener('scroll', schedule, { capture: true, passive: true });
  root.addEventListener('load', onLayout, true);
  view.addEventListener('resize', onLayout);
  schedule();
  return () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    mutations.disconnect();
    resize?.disconnect();
    root.removeEventListener('scroll', schedule, true);
    root.removeEventListener('load', onLayout, true);
    view.removeEventListener('resize', onLayout);
    for (const element of tracked) restore(element);
    tracked.clear();
  };
}
