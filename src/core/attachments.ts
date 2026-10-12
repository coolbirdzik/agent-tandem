export interface ChatAttachment { name: string; mimeType: string; data: string }
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export function attachmentKind(item: Pick<ChatAttachment, 'mimeType'>): 'image' | 'audio' | 'document' | 'file' {
  return imageTypes.includes(item.mimeType) ? 'image' : item.mimeType.startsWith('audio/') ? 'audio' : item.mimeType === 'application/pdf' ? 'document' : 'file';
}
export function attachmentBytes(item: ChatAttachment): number { return item.data.length / 4 * 3 - (item.data.endsWith('==') ? 2 : item.data.endsWith('=') ? 1 : 0); }
export function chatAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new Error(`Attach up to ${MAX_ATTACHMENTS} files.`);
  let total = 0;
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 255 || /[\x00-\x1f]/.test(item.name) ||
      typeof item.mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(item.mimeType) || typeof item.data !== 'string' || item.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 ||
      item.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) throw new Error('Invalid attachment. Choose the file again.');
    const result = { name: item.name, mimeType: item.mimeType.toLowerCase(), data: item.data }, bytes = attachmentBytes(result);
    if (result.mimeType.startsWith('image/') && !imageTypes.includes(result.mimeType)) throw new Error('Use PNG, JPEG, GIF or WebP images.');
    if (bytes > (attachmentKind(result) === 'image' ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES)) throw new Error(`${result.name} is too large. Images allow 5 MB; other files allow 20 MB.`);
    total += bytes; if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('Attachments exceed 25 MB in total.');
    return result;
  });
}
export const attachmentLabel = (item: Pick<ChatAttachment, 'name' | 'mimeType'>) => `[${attachmentKind(item) === 'image' ? 'Image' : attachmentKind(item) === 'audio' ? 'Audio' : 'File'}: ${item.name}]`;
export function imageDataUrl(item: ChatAttachment): string | undefined { return attachmentKind(item) === 'image' ? `data:${item.mimeType};base64,${item.data}` : undefined; }
