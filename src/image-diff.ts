import { renderImageComparison } from './image-comparison';
import type { ImageComparison } from './core/media-preview';
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const api = acquireVsCodeApi();
const data = JSON.parse(document.getElementById('image-data')!.textContent!) as { images: ImageComparison; file: string };
document.getElementById('images')!.append(renderImageComparison(data.images, data.file));
document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => { button.onclick = () => api.postMessage({ type: button.dataset.action }); });
window.addEventListener('keydown', event => {
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && ['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault(); api.postMessage({ type: ['PageDown', 'ArrowDown'].includes(event.key) ? 'next' : 'previous' });
  }
});
