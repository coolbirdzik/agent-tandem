import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import type { ConversationMessage } from '../providers/conversations';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const markdown = new Marked({ renderer: { html: ({ text }) => escapeHtml(text), image: ({ text }) => escapeHtml(text) } });

export function renderMessageText(text: string) {
  const content = document.createElement('div');
  content.className = 'message-text markdown';
  content.innerHTML = DOMPurify.sanitize(markdown.parse(text, { async: false }), { ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], ALLOWED_ATTR: ['href', 'title', 'class', 'start'], ALLOW_DATA_ATTR: false });
  content.querySelectorAll<HTMLAnchorElement>('a').forEach(link => {
    if (!/^(https?:|mailto:)/i.test(link.getAttribute('href') ?? '')) link.removeAttribute('href');
    else { link.rel = 'noopener noreferrer'; link.target = '_blank'; }
  });
  return content;
}

export function renderToolMessage(message: ConversationMessage, open = false, time?: HTMLTimeElement) {
  const details = document.createElement('details');
  details.id = `tool-${message.id}`;
  details.open = open;
  const summary = document.createElement('summary');
  const icon = document.createElement('span');
  icon.className = message.toolName === 'Result' ? 'codicon codicon-output' : 'codicon codicon-terminal';
  icon.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = message.toolName ?? 'Tool';
  const chevron = document.createElement('span');
  chevron.className = 'tool-chevron codicon codicon-chevron-right';
  chevron.setAttribute('aria-hidden', 'true');
  const output = document.createElement('pre');
  output.textContent = message.text;
  summary.append(icon, name, chevron);
  if (time) chevron.before(time);
  details.append(summary, output);
  return details;
}
