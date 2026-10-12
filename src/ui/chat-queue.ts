import type { ChatQueueState } from '../core/chat-queue';
import { attachmentCards } from './chat-attachments';
export interface QueueAction { project: string; action: 'remove' | 'edit' | 'pause' | 'resume'; id?: string; text?: string }
export class ChatQueueView {
  private revision = '';
  private edits = new Map<string, string>();
  constructor(private root: HTMLElement, private send: (action: QueueAction) => void) {}
  render(queue?: ChatQueueState, busy = false) {
    this.root.hidden = !queue?.items.length;
    const revision = JSON.stringify([queue, busy]); if (revision === this.revision) return; this.revision = revision;
    const focus = (document.activeElement as HTMLElement | null)?.dataset.queueFocus;
    this.root.replaceChildren(); if (!queue?.items.length) { this.edits.clear(); return; }
    const node = (tag: string, text?: string, className?: string) => { const value = document.createElement(tag); value.textContent = text ?? ''; if (className) value.className = className; return value; };
    const action = (label: string, icon: string, run: () => void, key: string) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button'; button.title = label; button.setAttribute('aria-label', label); button.dataset.queueFocus = key;
      button.append(node('span', undefined, `codicon codicon-${icon}`)); button.onclick = run; return button;
    };
    const heading = node('header', undefined, 'queue-heading'); heading.append(node('strong', `${queue.items.length} queued`));
    const toggle = action(queue.paused ? 'Resume queued messages' : 'Pause queued messages', queue.paused ? 'play' : 'debug-pause', () => this.send({ project: queue.project, action: queue.paused ? 'resume' : 'pause' }), 'toggle');
    toggle.disabled = !!queue.paused && busy; heading.append(toggle); this.root.append(heading);
    if (queue.paused) this.root.append(node('p', queue.paused, 'queue-notice'));
    const list = node('ol', undefined, 'queue-items'); this.root.append(list);
    for (const item of queue.items) {
      const row = node('li', undefined, 'queue-item'); row.dataset.queueId = item.requestId;
      if (this.edits.has(item.requestId)) {
        const editor = document.createElement('textarea'); editor.value = this.edits.get(item.requestId)!; editor.rows = 2; editor.maxLength = 200000; editor.setAttribute('aria-label', 'Edit queued message'); editor.dataset.queueFocus = `input:${item.requestId}`;
        editor.oninput = () => { editor.setCustomValidity(''); this.edits.set(item.requestId, editor.value); };
        row.append(editor, action('Save queued message', 'check', () => {
          if (!editor.value.trim() && !item.attachments?.length) { editor.setCustomValidity('Enter a message.'); editor.reportValidity(); return; }
          this.send({ project: queue.project, action: 'edit', id: item.requestId, text: editor.value }); this.edits.delete(item.requestId); this.revision = ''; this.render(queue, busy);
        }, `save:${item.requestId}`), action('Cancel queue edit', 'close', () => { this.edits.delete(item.requestId); this.revision = ''; this.render(queue, busy); }, `cancel:${item.requestId}`));
      } else {
        const text = node('span', item.text, 'queue-text'); text.title = item.text;
        row.append(text, action('Edit queued message', 'edit', () => {
          this.edits.set(item.requestId, item.text); this.revision = ''; this.render(queue, busy);
          [...this.root.querySelectorAll<HTMLTextAreaElement>('textarea')].find(node => node.dataset.queueFocus === `input:${item.requestId}`)?.focus();
        }, `edit:${item.requestId}`));
      }
      row.append(action('Remove queued message', 'close', () => this.send({ project: queue.project, action: 'remove', id: item.requestId }), `remove:${item.requestId}`));
      if (item.attachments?.length) { const cards = node('div', undefined, 'chat-attachments queue-attachments'); attachmentCards(cards, item.attachments); row.append(cards); }
      list.append(row);
    }
    for (const id of this.edits.keys()) if (!queue.items.some(item => item.requestId === id)) this.edits.delete(id);
    if (focus) [...this.root.querySelectorAll<HTMLElement>('[data-queue-focus]')].find(node => node.dataset.queueFocus === focus)?.focus({ preventScroll: true });
  }
}
