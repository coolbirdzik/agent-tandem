import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ReviewStore } from '../src/core/review';
import { reviewHunks, encodeSnapshot, textSnapshot } from '../src/core/review-hunks';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(before: Buffer | string, after: Buffer | string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentdock-hunks-')); dirs.push(dir);
  const project = path.join(dir, 'project'); await mkdir(project);
  const store = new ReviewStore(path.join(dir, 'review')), file = 'source.ts';
  await writeFile(path.join(project, file), before); await store.begin(project, 'turn');
  await writeFile(path.join(project, file), after); await store.finish(project, 'turn');
  const request = async (index: number) => {
    const review = await store.read(project), req = { project, revision: review.revision, file };
    const hunk = (await store.hunks(req))[index]!; return { ...req, hunk: hunk.id };
  };
  return { project, file, store, request, read: () => readFile(path.join(project, file)) };
}

describe('Individual pending changes', () => {
  const before = 'before one\r\nkeep A\r\nkeep B\r\nbefore two\r\nkeep C\r\nkeep D\r\nbefore three';
  const after = before.replace('before one', 'after one').replace('before two', 'after two').replace('before three', 'after three');
  it('accepts one change without writing the workspace, then reverts only another and retains the accepted bytes after reload', async () => {
    const f = await fixture(before, after);
    expect(await f.store.hunks({ project: f.project, revision: (await f.store.read(f.project)).revision, file: f.file })).toHaveLength(3);
    await f.store.decideHunk(await f.request(0), false);
    expect((await f.read()).toString()).toBe(after);
    await f.store.decideHunk(await f.request(0), true);
    expect((await f.read()).toString()).toBe(after.replace('after two', 'before two'));
    const restored = new ReviewStore(f.store.directory), review = await restored.read(f.project);
    const hunks = await restored.hunks({ project: f.project, revision: review.revision, file: f.file });
    expect(hunks).toHaveLength(1);
    await restored.revert({ project: f.project, revision: review.revision });
    expect((await f.read()).toString()).toBe(before.replace('before one', 'after one'));
  });
  it('preserves mixed EOLs and no final newline, and blocks stale requests', async () => {
    const f = await fixture('old\r\nkeep\nend', 'new\r\nkeep\nchanged');
    const old = await f.request(0); await f.store.decideHunk(old, true);
    expect((await f.read()).toString()).toBe('old\r\nkeep\nchanged');
    await expect(f.store.decideHunk(old, false)).rejects.toThrow('updated');
    const invalid = { ...await f.request(0), hunk: 'invented' };
    await expect(f.store.decideHunk(invalid, true)).rejects.toThrow('stale');
    await expect(f.store.decideHunk({ ...await f.request(0), file: '' }, true)).rejects.toThrow('Choose');
  });
  it('keeps later user edits for both accept and revert', async () => {
    const f = await fixture(before, after), request = await f.request(1);
    await writeFile(path.join(f.project, f.file), 'my later edit');
    for (const revert of [false, true]) await expect(f.store.decideHunk(request, revert)).rejects.toThrow('Your edits were kept');
    expect((await f.read()).toString()).toBe('my later edit');
  });
  it('retains the accepted baseline when another agent turn adds more changes', async () => {
    const f = await fixture(before, after);
    await f.store.decideHunk(await f.request(0), false);
    await f.store.begin(f.project, 'next-turn');
    await writeFile(path.join(f.project, f.file), `${after}\nnext turn`);
    const review = await f.store.finish(f.project, 'next-turn');
    await f.store.revert({ project: f.project, revision: review.revision });
    expect((await f.read()).toString()).toBe(before.replace('before one', 'after one'));
  });
  it('handles insertion and deletion without altering other pending changes or deleting existing empty files', async () => {
    const f = await fixture('first\nkeep\nlast\n', 'inserted\nfirst\nkeep\n');
    await f.store.decideHunk(await f.request(0), true);
    expect((await f.read()).toString()).toBe('first\nkeep\n');
    await f.store.decideHunk(await f.request(0), true);
    expect((await f.read()).toString()).toBe('first\nkeep\nlast\n');
    const empty = await fixture('', 'added line\n');
    await empty.store.decideHunk(await empty.request(0), true);
    expect((await empty.read()).length).toBe(0);
  });
  it('handles new and deleted files, including empty ones, as complete changes', async () => {
    for (const text of ['', 'contents\n']) for (const deleted of [false, true]) for (const revert of [false, true]) {
      const f = await fixture('same', 'same');
      if (deleted) await writeFile(path.join(f.project, 'other.ts'), text);
      await f.store.begin(f.project, 'extra');
      if (deleted) await unlink(path.join(f.project, 'other.ts')); else await writeFile(path.join(f.project, 'other.ts'), text);
      const review = await f.store.finish(f.project, 'extra'), request = { project: f.project, revision: review.revision, file: 'other.ts' };
      const hunks = await f.store.hunks(request); expect(hunks).toHaveLength(1);
      await f.store.decideHunk({ ...request, hunk: hunks[0]!.id }, revert);
      expect((await f.store.read(f.project)).files).toEqual([]);
      if (deleted === revert) expect(await readFile(path.join(f.project, 'other.ts'), 'utf8')).toBe(text);
      else await expect(readFile(path.join(f.project, 'other.ts'))).rejects.toThrow();
    }
  });
  it('preserves UTF-16 BOM and encoding during a partial revert', async () => {
    const original = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('before\nkeep\nlast', 'utf16le').swap16()]);
    const modified = encodeSnapshot('after\nkeep\nchanged', original);
    const f = await fixture(original, modified);
    await f.store.decideHunk(await f.request(0), true);
    const bytes = await f.read(); expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xfe, 0xff]));
    expect(textSnapshot(bytes)).toBe('before\nkeep\nchanged');
  });
  it('rejects binary data and identifies repeated-line changes without ambiguous patch application', async () => {
    const f = await fixture(Buffer.from([0, 1]), Buffer.from([0, 2]));
    await expect(f.request(0)).rejects.toThrow('Binary');
    const left = 'same\nsame\nfirst\nsame\nsame\nsecond\nsame\n';
    const right = left.replace('first', 'new first').replace('second', 'new second');
    const hunks = reviewHunks(left, right); expect(hunks).toHaveLength(2);
    const h = hunks[1]!;
    expect(right.slice(0, h.newStart) + left.slice(h.oldStart, h.oldEnd) + right.slice(h.newEnd)).toBe(left.replace('first', 'new first'));
  });
});
