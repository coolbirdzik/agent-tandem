import { isMacKeyboard, shortcutMarkup } from './keyboard-shortcuts';

/** Shared hints for titles and controls that provide rich tooltip content. */
export function hoverHints(root: Document = document, renderContent?: (target: Element) => Node | undefined): () => void {
  const view = root.defaultView!;
  const mac = isMacKeyboard(view.navigator.platform);
  const hint = root.createElement('div');
  hint.className = 'tandem-hover-hint'; hint.id = 'tandem-hover-hint';
  hint.setAttribute('role', 'tooltip'); hint.hidden = true;
  if (typeof hint.showPopover === 'function') hint.setAttribute('popover', 'manual');
  root.body.append(hint);
  let target: Element | undefined, title: string | null = null, description: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let keyboard = false;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    clearTimeout(timer); clearTimeout(leaveTimer);
    if (hint.hasAttribute('popover') && hint.matches(':popover-open')) hint.hidePopover();
    hint.hidden = true;
    if (target) {
      // Do not overwrite a title updated by a render while the hint was open.
      if (title !== null && target.getAttribute('title') === '') target.setAttribute('title', title);
      if (description === null) target.removeAttribute('aria-describedby');
      else target.setAttribute('aria-describedby', description);
    }
    target = undefined;
  };
  const position = () => {
    if (!target) return;
    const rect = target.getBoundingClientRect(), box = hint.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left + (rect.width - box.width) / 2, view.innerWidth - box.width - 8));
    const below = rect.bottom + 6;
    const top = below + box.height <= view.innerHeight - 8 ? below : Math.max(8, rect.top - box.height - 6);
    hint.style.left = `${left}px`; hint.style.top = `${top}px`;
  };
  const show = (node: EventTarget | null, immediate: boolean) => {
    if (!(node instanceof view.Element)) return;
    const next = node.closest(renderContent ? '[title], [data-hover-hint]' : '[title]');
    if (next === target) return;
    hide();
    // Native select options and Monaco's own hover widgets retain their own behavior.
    if (!next || next.matches('option') || (next.closest('.monaco-editor') && !next.hasAttribute('data-shortcut'))) return;
    const nextTitle = next.getAttribute('title');
    const rich = renderContent && next.hasAttribute('data-hover-hint');
    if (!rich && !nextTitle?.trim()) return;
    target = next; title = nextTitle;
    description = next.getAttribute('aria-describedby');
    if (title !== null) next.setAttribute('title', '');
    timer = setTimeout(() => {
      if (!target?.isConnected || target.closest('[hidden], [inert]')) { hide(); return; }
      const content = rich ? renderContent(target) : undefined;
      if (!content && !title) { hide(); return; }
      hint.replaceChildren(content ?? title ?? '');
      const keys = shortcutMarkup(target.getAttribute('data-shortcut') ?? '', mac);
      if (keys) hint.insertAdjacentHTML('beforeend', keys);
      const alternative = shortcutMarkup(target.getAttribute('data-shortcut-alternative') ?? '', mac);
      if (alternative) { hint.append(' · Newline'); hint.insertAdjacentHTML('beforeend', alternative); }
      hint.hidden = false;
      if (hint.hasAttribute('popover')) hint.showPopover();
      target.setAttribute('aria-describedby', [description, hint.id].filter(Boolean).join(' '));
      position();
    }, immediate ? 0 : 450);
  };
  const over = (event: Event) => {
    clearTimeout(leaveTimer);
    if (event.target instanceof view.Node && hint.contains(event.target)) return;
    if (!keyboard) show(event.target, false);
  };
  const out = (event: Event) => {
    const related = (event as MouseEvent).relatedTarget;
    if (related instanceof view.Node && (target?.contains(related) || hint.contains(related))) return;
    if (!keyboard) leaveTimer = setTimeout(hide, 120);
  };
  const focus = (event: Event) => { if (keyboard) show(event.target, true); };
  const blur = () => { if (keyboard) hide(); };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') hide();
    if (event.key === 'Tab') keyboard = true;
  };
  const down = () => { keyboard = false; hide(); };
  // A view rerender must not leave a hint attached to a removed control.
  const observer = new view.MutationObserver(() => {
    if (target && (!target.isConnected || target.closest('[hidden], [inert]') || target.getAttribute('title') !== (title === null ? null : ''))) hide();
  });
  observer.observe(root.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title', 'hidden', 'inert'] });
  root.addEventListener('mouseover', over);
  root.addEventListener('mouseout', out);
  hint.addEventListener('mouseleave', hide);
  root.addEventListener('focusin', focus);
  root.addEventListener('focusout', blur);
  root.addEventListener('keydown', key);
  root.addEventListener('pointerdown', down, true);
  root.addEventListener('scroll', hide, true);
  view.addEventListener('resize', hide);
  view.addEventListener('blur', hide);
  return () => {
    observer.disconnect(); hide(); hint.remove();
    root.removeEventListener('mouseover', over); root.removeEventListener('mouseout', out);
    root.removeEventListener('focusin', focus); root.removeEventListener('focusout', blur);
    root.removeEventListener('keydown', key); root.removeEventListener('pointerdown', down, true);
    root.removeEventListener('scroll', hide, true);
    view.removeEventListener('resize', hide); view.removeEventListener('blur', hide);
  };
}
