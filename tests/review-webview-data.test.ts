import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReviewStore } from '../src/core/review';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(before: Buffer | string, after: Buffer | string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-webview-')); directories.push(directory);
  const project = path.join(directory, 'project'); await mkdir(project);
  const reviews = new ReviewStore(path.join(directory, 'review'));
  await writeFile(path.join(project, 'source.ts'), before); await reviews.begin(project, 'turn');
  await writeFile(path.join(project, 'source.ts'), after); const captured = await reviews.finish(project, 'turn');
  return { reviews, request: { project, revision: captured.revision, file: 'source.ts' } };
}
describe('Webview snapshot data', () => {
  it('reads immutable UTF-16 snapshots and retains exact review hunk identities', async () => {
    const encode = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const { reviews, request } = await fixture(encode('trước\r\n'), encode('sau\r\n'));
    const file = await reviews.webviewFile(request);
    expect(file.beforeText).toBe('trước\r\n'); expect(file.afterText).toBe('sau\r\n');
    expect(file.hunks).toEqual(await reviews.hunks(request));
    await writeFile(path.join(request.project, request.file), 'newer edit');
    expect((await reviews.webviewFile(request)).afterText).toBe('sau\r\n');
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
