import { createHash } from 'node:crypto';
import { diffLines } from 'diff';
import { decodeText } from './history';

export interface ReviewHunk {
  id: string; oldLine: number; oldLines: number; newLine: number; newLines: number;
  oldStart: number; oldEnd: number; newStart: number; newEnd: number;
}

/** Byte-preserving line edits; offsets address the exact immutable snapshot text. */
export function reviewHunks(before: string, after: string): ReviewHunk[] {
  const parts = diffLines(before, after, { timeout: 1000 });
  if (!parts) throw new Error('This file needs file-level review: computing changes took too long.');
  let oldLine = 0, newLine = 0, oldOffset = 0, newOffset = 0;
  let current: Omit<ReviewHunk, 'id'> | undefined;
  const snapshots = createHash('sha256').update(before).update('\0').update(after).digest('hex');
  const result: ReviewHunk[] = [];
  const finish = () => {
    if (!current) return;
    const id = createHash('sha256').update(snapshots).update(JSON.stringify(current)).digest('hex');
    result.push({ id, ...current }); current = undefined;
  };
  for (const part of parts) {
    if (!part.added && !part.removed) {
      finish(); oldOffset += part.value.length; newOffset += part.value.length;
      oldLine += part.count; newLine += part.count; continue;
    }
    current ??= { oldLine, newLine, oldLines: 0, newLines: 0, oldStart: oldOffset, oldEnd: oldOffset, newStart: newOffset, newEnd: newOffset };
    if (part.removed) { oldOffset += part.value.length; oldLine += part.count; current.oldEnd = oldOffset; current.oldLines += part.count; }
    if (part.added) { newOffset += part.value.length; newLine += part.count; current.newEnd = newOffset; current.newLines += part.count; }
  }
  finish(); return result;
}

export function textSnapshot(bytes: Buffer): string {
  const text = decodeText(bytes);
  if (text === undefined) throw new Error('Binary changes need file-level review.');
  return text;
}

export function encodeSnapshot(text: string, original: Buffer): Buffer {
  if (original[0] === 0xff && original[1] === 0xfe) return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (original[0] === 0xfe && original[1] === 0xff) return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
  return Buffer.from(text, 'utf8');
}
