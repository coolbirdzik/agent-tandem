import { createTwoFilesPatch, diffLines } from 'diff';

/** A run of lines in a line diff. Only sizes are kept: callers never need the text, so results stay tiny to send between threads. */
export interface DiffPart { added: boolean; removed: boolean; count: number; length: number }

/** Undefined when the diff did not finish within `timeout` milliseconds. */
export function computeLineParts(before: string, after: string, timeout: number): DiffPart[] | undefined {
  return diffLines(before, after, { timeout })?.map(part => ({ added: !!part.added, removed: !!part.removed, count: part.count, length: part.value.length }));
}

/** Unified patch with three lines of context; undefined when it did not finish within `timeout` milliseconds. */
export function computePatch(name: string, before: string, after: string, timeout: number): string | undefined {
  return createTwoFilesPatch(`before/${name}`, `after/${name}`, before, after, '', '', { context: 3, timeout });
}
