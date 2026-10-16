import { describe, expect, it } from 'vitest';
import { addFreed, storageFreed } from '../src/core/storage-freed';

describe('Storage freed totals', () => {
  it('accumulates removed space, counts and the last run', () => {
    const first = addFreed(undefined, { bytes: 1000, conversations: 2 }, 10);
    const second = addFreed(first, { bytes: 500, files: 3 }, 20);
    expect(second).toEqual({ bytes: 1500, conversations: 2, files: 3, runs: 2, lastAt: 20, lastBytes: 500 });
  });
  it('ignores runs that removed nothing and discards malformed saved values', () => {
    const saved = addFreed(undefined, { bytes: 1000, files: 1 }, 10);
    expect(addFreed(saved, { bytes: 0, conversations: 0, files: 0 }, 99)).toEqual(saved);
    expect(storageFreed({ bytes: -5, conversations: 'x', files: Number.NaN, runs: 2.7 })).toEqual({ bytes: 0, conversations: 0, files: 0, runs: 2 });
    expect(storageFreed('corrupt')).toEqual({ bytes: 0, conversations: 0, files: 0, runs: 0 });
  });
});
