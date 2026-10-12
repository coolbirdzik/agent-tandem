import { attachmentBytes, attachmentKind, chatAttachments, imageDataUrl, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, type ChatAttachment } from '../core/attachments';
const typeFor = (file: File) => file.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac' }[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream');
export function attachmentCards(root: HTMLElement, items: ChatAttachment[], remove?: (index: number) => void) {
  root.replaceChildren(); root.hidden = !items.length;
  items.forEach((item, index) => {
    const card = document.createElement('div'); card.className = 'attachment-card';
    const url = imageDataUrl(item);
    if (url) { const image = document.createElement('img'); image.src = url; image.alt = item.name; card.append(image); }
    else { const icon = document.createElement('span'); icon.className = `codicon codicon-${attachmentKind(item) === 'audio' ? 'unmute' : 'file'}`; icon.setAttribute('aria-hidden', 'true'); card.append(icon); }
    const label = document.createElement('span'); label.className = 'attachment-name'; label.textContent = item.name; label.title = `${item.name} · ${Math.ceil(attachmentBytes(item) / 1024)} KB`; card.append(label);
    if (remove) { const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button'; button.setAttribute('aria-label', `Remove ${item.name}`); button.title = `Remove ${item.name}`; button.textContent = '×'; button.onclick = () => remove(index); card.append(button); }
    root.append(card);
  });
}
/** Draft attachments follow the same per-view/per-conversation lifetime as text. */
export class ChatAttachments {
  private drafts = new Map<string, ChatAttachment[]>();
  private jobs = new Map<string, number>();
  private errors = new Map<string, string>();
  private versions = new Map<string, number>();
  constructor(private root: HTMLElement, private input: HTMLTextAreaElement, private form: HTMLElement, private picker: HTMLInputElement,
    private key: () => string, private changed: () => void) {
    picker.onchange = () => { void this.addFiles(Array.from(picker.files ?? [])); picker.value = ''; };
    input.addEventListener('paste', event => {
      const files = Array.from(event.clipboardData?.items ?? []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file);
      if (!files.length) return;
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain');
      if (text) { input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end'); input.dispatchEvent(new Event('input')); }
      void this.addFiles(files);
    });
    form.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) { event.preventDefault(); form.classList.add('attachment-drop'); } });
    form.addEventListener('dragleave', event => { if (!form.contains(event.relatedTarget as Node | null)) form.classList.remove('attachment-drop'); });
    form.addEventListener('drop', event => { form.classList.remove('attachment-drop'); const files = Array.from(event.dataTransfer?.files ?? []); if (files.length) { event.preventDefault(); void this.addFiles(files); } });
  }
  forKey(key: string) { return this.drafts.get(key) ?? []; }
  get items() { return this.forKey(this.key()); }
  get busy() { return !!this.jobs.get(this.key()); }
  set(items: ChatAttachment[], key = this.key()) { this.versions.set(key, (this.versions.get(key) ?? 0) + 1); this.drafts.set(key, [...items]); this.errors.delete(key); this.render(); this.changed(); }
  delete(key: string) { this.versions.set(key, (this.versions.get(key) ?? 0) + 1); this.drafts.delete(key); this.errors.delete(key); this.render(); }
  clearSent(key: string, items: ChatAttachment[]) { const current = this.drafts.get(key); if (current) this.drafts.set(key, current.filter(item => !items.includes(item))); this.render(); }
  async addFiles(files: File[]) {
    const key = this.key(); if (!key || !files.length) return;
    const version = this.versions.get(key) ?? 0;
    this.jobs.set(key, (this.jobs.get(key) ?? 0) + 1); this.errors.delete(key); this.render(); this.changed();
    try {
      if (files.length + (this.drafts.get(key)?.length ?? 0) > MAX_ATTACHMENTS) throw new Error(`Attach up to ${MAX_ATTACHMENTS} files.`);
      let bytes = (this.drafts.get(key) ?? []).reduce((sum, item) => sum + attachmentBytes(item), 0);
      for (const file of files) {
        const mimeType = typeFor(file), image = mimeType.startsWith('image/');
        if (file.size > (image ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES)) throw new Error(`${file.name} is too large. Images allow 5 MB; other files allow 20 MB.`);
        bytes += file.size; if (bytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('Attachments exceed 25 MB in total.');
      }
      const items = await Promise.all(files.map(file => new Promise<ChatAttachment>((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
        reader.onload = () => resolve({ name: file.name || 'Pasted image.png', mimeType: typeFor(file), data: String(reader.result).split(',')[1] ?? '' }); reader.readAsDataURL(file);
      })));
      if ((this.versions.get(key) ?? 0) !== version) return;
      const merged = chatAttachments([...(this.drafts.get(key) ?? []), ...items]); this.drafts.set(key, merged);
    } catch (error) { if ((this.versions.get(key) ?? 0) === version) this.errors.set(key, error instanceof Error ? error.message : 'Could not attach files.'); }
    finally { this.jobs.set(key, Math.max(0, (this.jobs.get(key) ?? 1) - 1)); this.render(); this.changed(); }
  }
  render() {
    attachmentCards(this.root, this.items, index => { const next = [...this.items]; next.splice(index, 1); this.set(next); });
    const status = document.getElementById('attachment-status')!; status.textContent = this.errors.get(this.key()) ?? (this.busy ? 'Reading attachments…' : ''); status.hidden = !status.textContent;
  }
}
