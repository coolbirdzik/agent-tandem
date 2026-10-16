import type { HistoryStore } from './history';

export interface ImageSnapshot { src?: string; notice?: string; size: number; missing?: boolean }
export interface ImageComparison { before: ImageSnapshot; after: ImageSnapshot }
const imageTypes: Record<string, string> = {
  png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
  avif: 'image/avif', svg: 'image/svg+xml', tiff: 'image/tiff', tif: 'image/tiff',
};
export const imageMime = (file: string): string | undefined => imageTypes[file.split('.').pop()!.toLowerCase()];
// Bound the bridge payload independently of the text-diff limit. Unsupported
// decoders and oversized sides retain their size and whole-file review actions.
export const maxImagePreviewBytes = 16 * 1024 * 1024;
/** A side read directly as bytes, such as a Git object; no bytes means the file is absent on that side. */
export function imageSnapshot(file: string, bytes?: Uint8Array): ImageSnapshot {
  if (!bytes?.length) return { size: 0, missing: true };
  if (bytes.length > maxImagePreviewBytes) return { size: bytes.length, notice: 'Image is too large to preview (16 MB limit).' };
  return { size: bytes.length, src: `data:${imageMime(file)};base64,${Buffer.from(bytes).toString('base64')}` };
}
export async function imageSnapshots(history: HistoryStore, file: string, before?: string, after?: string): Promise<ImageComparison | undefined> {
  const mime = imageMime(file);
  if (!mime) return;
  const read = async (hash?: string): Promise<ImageSnapshot> => {
    if (!hash) return { size: 0, missing: true };
    const { size } = await history.inspectBlob(hash);
    if (size > maxImagePreviewBytes) return { size, notice: 'Image is too large to preview (16 MB limit).' };
    const bytes = await history.readBlob(hash);
    return { size, src: `data:${mime};base64,${bytes.toString('base64')}` };
  };
  const [left, right] = await Promise.all([read(before), read(after)]);
  return { before: left, after: right };
}
