import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, unlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { ReviewStore } from '../src/core/review';
import { reviewGroup } from '../src/core/review-groups';

const execute = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(initialCommit = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-review-commits-')); roots.push(root);
  const project = path.join(root, 'project'); await mkdir(project);
  const git = (...args: string[]) => execute('git', args, { cwd: project, windowsHide: true });
  await git('init', '-q'); await git('config', 'user.name', 'Review test'); await git('config', 'user.email', 'review@test.invalid'); await git('config', 'core.autocrlf', 'false');
  const set = (name: string, content: string | Buffer) => writeFile(path.join(project, name), content);
  const commit = async () => { await git('commit', '-qm', 'review test'); };
  await set('one.ts', 'one\n'); await set('two.ts', 'two\n');
  if (initialCommit) { await git('add', '.'); await commit(); }
  const store = new ReviewStore(path.join(root, 'reviews')); await store.initializeExternalTracking(project);
  return { root, project, store, git, set, commit };
}

describe('Git commits automatically accept pending review', () => {
  it('accepts only committed files, retains uncommitted files, and rejects stale revert requests', async () => {
    const f = await fixture(); await f.set('one.ts', 'committed\n'); await f.set('two.ts', 'pending\n');
    const pending = await f.store.scanExternal(f.project);
    await f.git('add', 'one.ts'); await f.commit();
    const review = await f.store.read(f.project);
    expect(review.files.map(file => file.path)).toEqual(['two.ts']);
    await expect(f.store.revert({ project: f.project, revision: pending.revision, file: 'one.ts' })).rejects.toThrow('updated');
    expect(await readFile(path.join(f.project, 'one.ts'), 'utf8')).toBe('committed\n');
    expect((await f.store.scanExternal(f.project)).files).toEqual(review.files);
    await f.store.revert({ project: f.project, revision: review.revision });
    expect(await readFile(path.join(f.project, 'two.ts'), 'utf8')).toBe('two\n');
  });
  it('rebases partial commits and newer edits in the same file onto the committed bytes', async () => {
    const f = await fixture(); await f.set('one.ts', 'committed first\nsecond\n'); await f.git('add', 'one.ts');
    await f.set('one.ts', 'committed first\nuncommitted second\n'); await f.store.scanExternal(f.project); await f.commit();
    const review = await f.store.scanExternal(f.project), request = { project: f.project, revision: review.revision, file: 'one.ts' };
    expect(await f.store.preview(request)).toMatchObject({ before: 'committed first\nsecond\n', after: 'committed first\nuncommitted second\n' });
    await f.store.revert(request);
    expect(await readFile(path.join(f.project, 'one.ts'), 'utf8')).toBe('committed first\nsecond\n');
    expect((await f.store.scanExternal(f.project)).files).toEqual([]);
  });
  it('handles additions, deletions, binary files, and an initial commit made before capture', async () => {
    const f = await fixture(false); await f.set('new [file].bin', Buffer.from([0, 1, 2])); await f.git('add', '.'); await f.commit();
    expect((await f.store.scanExternal(f.project)).files).toEqual([]);
    await unlink(path.join(f.project, 'one.ts')); await f.set('new [file].bin', Buffer.from([0, 3, 4]));
    await f.set('added.ts', 'added\n'); await f.store.scanExternal(f.project);
    await f.git('add', '-A'); await f.commit();
    expect((await f.store.read(f.project)).files).toEqual([]);
    expect((await new ReviewStore(f.store.directory).scanExternal(f.project)).files).toEqual([]);
  });
  it('ignores staging and unrelated commits and accepts pending commits while tracking is paused', async () => {
    const f = await fixture(); await f.set('one.ts', 'pending\n'); const pending = await f.store.scanExternal(f.project);
    await f.git('add', 'one.ts'); expect((await f.store.read(f.project)).files).toEqual(pending.files);
    await f.git('reset', '-q'); await f.set('two.ts', 'unrelated\n'); await f.git('add', 'two.ts'); await f.commit();
    expect((await f.store.scanExternal(f.project)).files.map(file => file.path)).toEqual(['one.ts']);
    await f.store.setExternalTracking(f.project, false); await f.git('add', 'one.ts'); await f.commit();
    const review = await f.store.read(f.project);
    expect(review.files).toEqual([]); expect(review.externalTracking).toBeUndefined();
  });
  it('reconciles commits made during a running agent turn only after capture finishes', async () => {
    const f = await fixture(); await f.store.begin(f.project, 'turn'); await f.set('one.ts', 'committed in turn\n');
    await f.git('add', 'one.ts'); await f.commit(); await f.set('two.ts', 'still pending\n');
    expect((await f.store.read(f.project)).busy).toBe(true);
    const review = await f.store.finish(f.project, 'turn');
    expect(review.files.map(file => file.path)).toEqual(['two.ts']);
    expect((await f.store.scanExternal(f.project)).files).toEqual(review.files);
  });
  it.each(['\n', '\r\n'])('accepts Git-clean working line endings (%j) and keeps later edits', async newline => {
    const f = await fixture(); await f.git('config', 'core.autocrlf', 'true');
    await f.set('one.ts', `committed${newline}`); await f.git('add', 'one.ts'); await f.store.scanExternal(f.project); await f.commit();
    expect((await f.store.scanExternal(f.project)).files).toEqual([]);
    await f.set('one.ts', `next${newline}`); const review = await f.store.scanExternal(f.project);
    expect(await f.store.preview({ project: f.project, revision: review.revision, file: 'one.ts' })).toMatchObject({ before: `committed${newline}`, after: `next${newline}` });
  });
  it('accepts native agent review without external tracking and keeps commits accepted after reload', async () => {
    const f = await fixture(); await f.store.setExternalTracking(f.project, false);
    await f.store.begin(f.project, 'turn'); await f.set('one.ts', 'agent change\n'); await f.store.finish(f.project, 'turn');
    await f.git('add', 'one.ts'); await f.commit();
    expect((await new ReviewStore(f.store.directory).read(f.project)).files).toEqual([]);
  });
  it('retains only unstaged hunks when a partial commit normalizes LF files on Windows', async () => {
    const f = await fixture(); await f.git('config', 'core.autocrlf', 'true');
    await f.set('one.ts', 'committed\nkeep\n'); await f.git('add', 'one.ts');
    await f.set('one.ts', 'committed\nremaining\n'); await f.store.scanExternal(f.project); await f.commit();
    const review = await f.store.scanExternal(f.project);
    expect(await f.store.preview({ project: f.project, revision: review.revision, file: 'one.ts' })).toMatchObject({ before: 'committed\nkeep\n', after: 'committed\nremaining\n' });
  });
  it.each([['false', ''], ['true', 'one.ts -text\n']])('keeps unstaged line-ending changes with core.autocrlf=%s and attributes=%j', async (autocrlf, attributes) => {
    const f = await fixture(); await f.git('config', 'core.autocrlf', autocrlf);
    if (attributes) { await f.set('.gitattributes', attributes); await f.git('add', '.gitattributes'); }
    await f.set('one.ts', 'committed\nkeep\n'); await f.git('add', 'one.ts');
    await f.set('one.ts', 'committed\r\nkeep\r\n'); await f.store.scanExternal(f.project); await f.commit();
    const review = await f.store.scanExternal(f.project), request = { project: f.project, revision: review.revision, file: 'one.ts' };
    expect(review.files.map(file => file.path)).toEqual(['one.ts']);
    expect(await f.store.preview(request)).toMatchObject({ before: 'committed\nkeep\n', after: 'committed\r\nkeep\r\n' });
    await f.store.revert(request);
    expect(await readFile(path.join(f.project, 'one.ts'), 'utf8')).toBe('committed\nkeep\n');
    expect((await f.git('diff', '--name-only', 'HEAD', '--', 'one.ts')).stdout).toBe('');
  });
  it('accepts a committed file-to-directory replacement and keeps unrelated pending changes', async () => {
    const f = await fixture(); await f.set('one.ts', 'pending\n'); await f.set('two.ts', 'unrelated\n');
    await f.store.scanExternal(f.project);
    await unlink(path.join(f.project, 'one.ts')); await mkdir(path.join(f.project, 'one.ts'));
    await f.set('one.ts/child.ts', 'committed child\n'); await f.git('add', '-A', '--', 'one.ts'); await f.commit();
    expect((await f.store.read(f.project)).files.map(file => file.path)).toEqual(['two.ts']);
    expect((await f.store.scanExternal(f.project)).files.map(file => file.path)).toEqual(['two.ts']);
    await f.set('one.ts/child.ts', 'pending child\n'); const review = await f.store.scanExternal(f.project);
    await f.store.revert({ project: f.project, revision: review.revision, file: 'one.ts/child.ts' });
    expect(await readFile(path.join(f.project, 'one.ts/child.ts'), 'utf8')).toBe('committed child\n');
    const remaining = await f.store.read(f.project); await f.store.accept({ project: f.project, revision: remaining.revision });
    expect((await f.store.scanExternal(f.project)).files).toEqual([]);
  });
  it.each([true, false])('keeps conversation ownership through partial commits with tracking=%s', async tracking => {
    const f = await fixture(); if (!tracking) await f.store.setExternalTracking(f.project, false);
    const conversation = { key: 'Claude:owner', id: 'owner', provider: 'Claude' as const, title: 'Agent changes' };
    await f.store.begin(f.project, 'turn', undefined, conversation);
    await f.set('one.ts', 'committed\nkeep\n'); await f.git('add', 'one.ts');
    await f.set('one.ts', 'committed\nremaining\n'); const pending = await f.store.finish(f.project, 'turn'); await f.commit();
    const rebased = await f.store.read(f.project);
    expect(rebased.files.map(reviewGroup)).toEqual([conversation.key]);
    expect(rebased.files[0]!.captures).toEqual(pending.files[0]!.captures);
    const reloaded = new ReviewStore(f.store.directory), review = await reloaded.scanExternal(f.project);
    expect(review.files.map(reviewGroup)).toEqual([conversation.key]);
    expect(review.files[0]!.captures).toEqual(pending.files[0]!.captures);
    const request = { project: f.project, revision: review.revision, group: conversation.key };
    expect((await reloaded.editorFiles(request)).map(file => file.path)).toEqual(['one.ts']);
    await reloaded.revert(request);
    expect(await readFile(path.join(f.project, 'one.ts'), 'utf8')).toBe('committed\nkeep\n');
  });
  it('keeps newer uncaptured edits separate from the original conversation after a partial commit', async () => {
    const f = await fixture(), conversation = { key: 'Codex:owner', id: 'owner', provider: 'Codex' as const, title: 'Agent changes' };
    await f.store.begin(f.project, 'turn', undefined, conversation);
    await f.set('one.ts', 'committed\nkeep\n'); await f.git('add', 'one.ts');
    await f.set('one.ts', 'committed\nremaining\n'); const pending = await f.store.finish(f.project, 'turn');
    await f.set('one.ts', 'committed\nnewer\n'); await f.commit();
    const review = await f.store.read(f.project), file = review.files[0]!;
    expect(reviewGroup(file)).toBe('shared');
    expect(file.captures?.slice(0, -1)).toEqual(pending.files[0]!.captures);
    expect(file.captures?.at(-1)).toMatchObject({ before: pending.files[0]!.after, after: file.after });
    expect(file.captures?.at(-1)?.conversations).toBeUndefined();
    expect((await f.store.scanExternal(f.project)).files).toEqual(review.files);
  });
  it('handles a project inside a repository without including sibling paths', async () => {
    const f = await fixture(), project = path.join(f.project, 'nested'); await mkdir(project);
    await f.set('nested/child.ts', 'before\n'); await f.git('add', '.'); await f.commit();
    const store = new ReviewStore(path.join(f.root, 'nested-reviews')); await store.initializeExternalTracking(project);
    await f.set('nested/child.ts', 'committed\n'); await store.scanExternal(project);
    await f.set('one.ts', 'sibling\n'); await f.git('add', '.'); await f.commit();
    expect((await store.scanExternal(project)).files).toEqual([]);
    await f.set('nested/child.ts', 'pending\n'); const review = await store.scanExternal(project);
    expect(await store.preview({ project, revision: review.revision, file: 'child.ts' })).toMatchObject({ before: 'committed\n', after: 'pending\n' });
  });
  it('retires Undo for files changed by a commit while retaining unrelated Undo files', async () => {
    const f = await fixture(); await f.set('one.ts', 'revert one\n'); await f.set('two.ts', 'revert two\n');
    const pending = await f.store.scanExternal(f.project);
    await f.store.revert({ project: f.project, revision: pending.revision });
    await f.set('one.ts', 'committed instead\n'); await f.git('add', 'one.ts'); await f.commit();
    const review = await f.store.read(f.project);
    expect(review.undo?.files).toEqual(['two.ts']);
    expect(review.files).toEqual([]);
  });
});
