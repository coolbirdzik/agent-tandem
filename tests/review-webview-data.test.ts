import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReviewStore } from '../src/core/review';
import { reviewContext } from '../src/core/review-webview';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(before: Buffer | string | undefined, after: Buffer | string | undefined, file = 'source.ts') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-webview-')); directories.push(directory);
  const project = path.join(directory, 'project'); await mkdir(project);
  const reviews = new ReviewStore(path.join(directory, 'review'));
  if (before !== undefined) await writeFile(path.join(project, file), before); await reviews.begin(project, 'turn');
  if (after !== undefined) await writeFile(path.join(project, file), after); else await unlink(path.join(project, file));
  const captured = await reviews.finish(project, 'turn');
  return { reviews, request: { project, revision: captured.revision, file } };
}
describe('Webview snapshot data', () => {
  it('lists only the selected conversation files and never attributes mixed captures to one agent', () => {
    const conversation = { key: 'Codex:agent', id: 'agent', provider: 'Codex' as const, title: 'Update artwork' };
    const owned = { path: 'a.ts', kind: 'modified' as const, binary: false, captures: [{ from: 1, to: 2, conversations: [conversation] }] };
    const unassigned = { path: 'manual.ts', kind: 'added' as const, binary: false };
    const mixed = { ...owned, path: 'mixed.ts', captures: [...owned.captures, { from: 2, to: 3 }] };
    const files = [owned, { ...owned, path: 'b.ts' }, unassigned, mixed];
    expect(reviewContext(files, owned)).toMatchObject({ group: conversation.key, conversation, files: [{ path: 'a.ts' }, { path: 'b.ts' }] });
    expect(reviewContext(files, mixed)).toMatchObject({ group: 'shared', conversation: undefined, files: [{ path: 'mixed.ts' }] });
    expect(reviewContext(files, unassigned)).toMatchObject({ group: 'unassigned', conversation: undefined });
  });
  it('previews saved image bytes independently of current workspace contents, including text SVG', async () => {
    for (const [name, before, after] of [['photo.PNG', Buffer.from([0, 1]), Buffer.from([0, 2])], ['icon.svg', '<svg>old</svg>', '<svg>new</svg>']] as const) {
      const { reviews, request } = await fixture(before, after, name);
      await writeFile(path.join(request.project, name), 'newer edit');
      const file = await reviews.webviewFile(request);
      expect(file.images?.before.src?.split(',')[1]).toBe(Buffer.from(before).toString('base64'));
      expect(file.images?.after.src?.split(',')[1]).toBe(Buffer.from(after).toString('base64'));
      expect(file.hunks).toEqual([]); expect(file.beforeText).toBeUndefined();
    }
  });
  it('distinguishes missing image snapshots from existing empty images', async () => {
    for (const [before, after, missing] of [[undefined, Buffer.from([0, 1]), 'before'], [Buffer.from([0, 1]), undefined, 'after']] as const) {
      const { reviews, request } = await fixture(before, after, 'photo.png');
      expect((await reviews.webviewFile(request)).images?.[missing]).toEqual({ missing: true, size: 0 });
    }
    const { reviews, request } = await fixture(Buffer.alloc(0), Buffer.from([0, 1]), 'empty.png');
    expect((await reviews.webviewFile(request)).images?.before).toEqual({ size: 0, src: 'data:image/png;base64,' });
  });
  it('keeps the other image visible when one side exceeds the image payload limit', async () => {
    const { reviews, request } = await fixture(Buffer.from([0, 1]), Buffer.alloc(16 * 1024 * 1024 + 1), 'large.png');
    const file = await reviews.webviewFile(request);
    expect(file.images?.before.src).toBeDefined();
    expect(file.images?.after.src).toBeUndefined(); expect(file.images?.after.notice).toContain('too large');
  });
  it('reads immutable UTF-16 snapshots and retains exact review hunk identities', async () => {
    const encode = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const { reviews, request } = await fixture(encode('trước\r\n'), encode('sau\r\n'));
    const file = await reviews.webviewFile(request);
    expect(file.beforeText).toBe('trước\r\n'); expect(file.afterText).toBe('sau\r\n');
    expect(file.hunks).toEqual(await reviews.hunks(request));
    await writeFile(path.join(request.project, request.file), 'newer edit');
    expect((await reviews.webviewFile(request)).afterText).toBe('sau\r\n');
  });
  it('saves review edits with the original encoding and permissions, then reviews the new hunks', async () => {
    const encode = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const { reviews, request } = await fixture(encode('before\r\n'), encode('agent\r\n'));
    const target = path.join(request.project, request.file);
    if (process.platform !== 'win32') await chmod(target, 0o751);
    const edited = await reviews.edit(request, 'edited\r\n', () => undefined);
    expect(await readFile(target)).toEqual(encode('edited\r\n'));
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o751);
    const next = { ...request, revision: edited.revision };
    const file = await reviews.webviewFile(next);
    expect(file).toMatchObject({ editable: true, beforeText: 'before\r\n', afterText: 'edited\r\n' });
    await reviews.decideHunk({ ...next, hunk: file.hunks[0]!.id }, true);
    expect(await readFile(target)).toEqual(encode('before\r\n'));
  });
  it('keeps a newer disk edit and drops pending review when a saved draft matches the baseline', async () => {
    const { reviews, request } = await fixture('old', 'agent');
    const target = path.join(request.project, request.file);
    await writeFile(target, 'newer');
    await expect(reviews.edit(request, 'draft', () => undefined)).rejects.toThrow('changed on disk');
    expect(await readFile(target, 'utf8')).toBe('newer');
    await writeFile(target, 'agent');
    await expect(reviews.edit(request, 'draft', () => { throw new Error('unsaved edits'); })).rejects.toThrow('unsaved edits');
    expect(await readFile(target, 'utf8')).toBe('agent');
    expect((await reviews.edit(request, 'old', () => undefined)).files).toEqual([]);
    expect(await readFile(target, 'utf8')).toBe('old');
  });
  it('rejects stale revisions and requests outside the conversation group', async () => {
    const { reviews, request } = await fixture('old', 'new');
    await expect(reviews.webviewFile({ ...request, revision: 'old' })).rejects.toThrow('updated');
    await expect(reviews.webviewFile({ ...request, group: 'Codex:another-session' })).rejects.toThrow('already been reviewed');
  });
  it('keeps binary and large files reviewable without sending their bytes into the Webview', async () => {
    for (const [before, after] of [[Buffer.from([0, 1]), Buffer.from([0, 2])], ['old', 'x'.repeat(4 * 1024 * 1024 + 1)]] as const) {
      const { reviews, request } = await fixture(before, after);
      const file = await reviews.webviewFile(request);
      expect(file.notice).toMatch(/Binary|Large/); expect(file.hunks).toEqual([]);
      expect(file.afterText).toBeUndefined(); expect(file.afterSize).toBe(Buffer.byteLength(after));
    }
  });
});
