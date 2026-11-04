import { quotaGlyphCharacter, quotaWindowIcon } from '../core/quota-status';

/** Render quota-window names as the same filled badges used in the native status bar. */
export function quotaWindowLabel<K extends keyof HTMLElementTagNameMap = 'span'>(text: string, tag: K = 'span' as K, className = ''): HTMLElementTagNameMap[K] {
  const root = document.createElement(tag); root.className = className;
  appendQuotaWindowLabel(root, text); return root;
}

/** Call only with quota labels/captions, never arbitrary account names or countdowns. */
export function appendQuotaWindowLabel(root: HTMLElement, text: string) {
  for (const part of text.split(/\b(5h|7d)\b/)) {
    const icon = quotaWindowIcon(part), character = icon && quotaGlyphCharacter(icon);
    if (!character) { root.append(document.createTextNode(part)); continue; }
    const badge = document.createElement('span'); badge.className = 'quota-window-badge'; badge.textContent = character;
    badge.setAttribute('role', 'img'); badge.setAttribute('aria-label', part); badge.title = part;
    root.append(badge);
  }
}
