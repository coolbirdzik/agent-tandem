import type { ImageComparison, ImageSnapshot } from './core/media-preview';

/** Use image elements, including for SVG, so snapshot markup never enters the DOM. */
export function renderImageComparison(images: ImageComparison, file: string): HTMLElement {
  const comparison = document.createElement('div'); comparison.className = 'image-comparison';
  const side = (label: string, snapshot: ImageSnapshot) => {
    const pane = document.createElement('section'); pane.className = 'image-side'; pane.setAttribute('aria-label', `${label} image`);
    const heading = document.createElement('h3'); heading.textContent = label;
    const size = document.createElement('span'); size.className = 'image-size'; size.textContent = `${snapshot.size.toLocaleString()} bytes`; heading.append(size);
    const viewport = document.createElement('div'); viewport.className = 'image-viewport';
    const notice = document.createElement('p'); notice.className = 'image-notice';
    notice.textContent = snapshot.missing ? `No ${label.toLowerCase()} image · file ${label === 'Before' ? 'added' : 'deleted'}.` : snapshot.notice ?? 'This image format could not be displayed.';
    if (snapshot.src) {
      const image = document.createElement('img'); image.alt = `${label}: ${file}`;
      image.onerror = () => { image.remove(); viewport.replaceChildren(notice); };
      image.src = snapshot.src; viewport.append(image);
    } else viewport.append(notice);
    pane.append(heading, viewport); return pane;
  };
  comparison.append(side('Before', images.before), side('After', images.after)); return comparison;
}
