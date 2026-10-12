import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ReviewStore } from '../src/core/review';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-dock-external-')); folders.push(directory);
  const project = path.join(directory, 'project'); await mkdir(project);
  const store = new ReviewStore(path.join(directory, 'reviews'));
  const set = (name: string, text: string) => writeFile(path.join(project, name), text);
  const get = (name: string) => readFile(path.join(project, name), 'utf8');
  await set('source.ts', 'existing user edits\n');
  return { project, store, set, get };
}

describe('External change tracking', () => {
  it('starts automatically once, resumes its baseline and preserves an explicit pause after reload', async () => {
    const f = await fixture();
    expect((await f.store.initializeExternalTracking(f.project, false)).externalTracking).toBeUndefined();
    expect((await f.store.initializeExternalTracking(f.project)).externalTracking).toBe(true);
    await f.set('source.ts', 'while closed\n');
    const reloaded = new ReviewStore(f.store.directory);
    await reloaded.initializeExternalTracking(f.project);
    const captured = await reloaded.scanExternal(f.project);
    expect(captured.files).toHaveLength(1);
    expect((await reloaded.preview({ project: f.project, revision: captured.revision, file: 'source.ts' })).before).toBe('existing user edits\n');
    await reloaded.setExternalTracking(f.project, false);
    const paused = new ReviewStore(f.store.directory);
    expect((await paused.initializeExternalTracking(f.project)).externalTracking).toBeUndefined();
    await f.set('source.ts', 'untracked edit\n');
    expect((await paused.scanExternal(f.project)).revision).toBe((await paused.read(f.project)).revision);
  });
  it('captures external writes before a native chat turn and resumes tracking without duplicate changes', async () => {
    const f = await fixture(); await f.store.initializeExternalTracking(f.project);
    await f.set('source.ts', 'external before chat\n');
    const running = await f.store.begin(f.project, 'chat');
    expect(running).toMatchObject({ externalTracking: true, busy: true });
    expect(running.files).toHaveLength(1);
    await f.set('source.ts', 'native chat edit\n');
    const finished = await f.store.finish(f.project, 'chat');
    expect(finished).toMatchObject({ externalTracking: true, busy: false });
    expect((await f.store.scanExternal(f.project)).revision).toBe(finished.revision);
    await f.store.accept({ project: f.project, revision: finished.revision });
    await f.set('source.ts', 'external after chat\n');
    const next = await f.store.scanExternal(f.project);
    expect((await f.store.preview({ project: f.project, revision: next.revision, file: 'source.ts' })).before).toBe('native chat edit\n');
  });
  it('blocks restoring a checkpoint prepared before tracking began', async () => {
    const f = await fixture();
    await f.store.begin(f.project, 'before');
    const target = await f.store.checkpointBefore(f.project, 'before'); await f.store.finish(f.project, 'before');
    await f.set('source.ts', 'current user edits\n');
    const plan = await f.store.prepareCheckpoint(f.project, target);
    await f.store.setExternalTracking(f.project, true);
    await expect(f.store.prepareCheckpoint(f.project, target)).rejects.toThrow('Stop external');
    await expect(f.store.restoreCheckpoint(f.project, plan)).rejects.toThrow('Stop external');
    expect(await f.get('source.ts')).toBe('current user edits\n');
  });
  it('starts from current user edits and captures additions, deletions and edits without an agent turn', async () => {
    const f = await fixture(); await f.set('deleted.ts', 'keep this\n');
    const started = await f.store.setExternalTracking(f.project, true);
    expect(started).toMatchObject({ externalTracking: true, busy: false, files: [] });
    await f.set('source.ts', 'external edits\n'); await f.set('added.ts', 'new\n'); await unlink(path.join(f.project, 'deleted.ts'));
    const review = await f.store.scanExternal(f.project);
    expect(review.files.map(file => [file.path, file.kind])).toEqual([['added.ts', 'added'], ['deleted.ts', 'deleted'], ['source.ts', 'modified']]);
    expect((await f.store.preview({ project: f.project, revision: review.revision, file: 'source.ts' })).before).toBe('existing user edits\n');
    const reloaded = new ReviewStore(f.store.directory);
    expect(await reloaded.read(f.project)).toMatchObject({ externalTracking: true, revision: review.revision });
    await reloaded.revert({ project: f.project, revision: review.revision });
    expect(await f.get('source.ts')).toBe('existing user edits\n'); expect(await f.get('deleted.ts')).toBe('keep this\n');
    expect((await reloaded.scanExternal(f.project)).files).toEqual([]);
  });
  it('does not recreate accepted changes and preserves new writes after a decision', async () => {
    const f = await fixture(); await f.store.setExternalTracking(f.project, true);
    await f.set('source.ts', 'first\n'); const first = await f.store.scanExternal(f.project);
    await f.store.accept({ project: f.project, revision: first.revision });
    expect((await f.store.scanExternal(f.project)).files).toEqual([]);
    await f.set('source.ts', 'second\n'); const second = await f.store.scanExternal(f.project);
    expect((await f.store.preview({ project: f.project, revision: second.revision, file: 'source.ts' })).before).toBe('first\n');
    await f.set('source.ts', 'third\n');
    await expect(f.store.accept({ project: f.project, revision: second.revision })).rejects.toThrow('changed since capture');
    await expect(f.store.revert({ project: f.project, revision: second.revision })).rejects.toThrow('changed after');
    expect(await f.get('source.ts')).toBe('third\n');
    const refreshed = await f.store.scanExternal(f.project); await f.store.revert({ project: f.project, revision: refreshed.revision });
    expect(await f.get('source.ts')).toBe('first\n'); expect((await f.store.scanExternal(f.project)).files).toEqual([]);
  });
  it('rebases partial hunk decisions without capturing its own revert as a new change', async () => {
    const f = await fixture(); const base = 'a\n' + 'same\n'.repeat(12) + 'z\n';
    await f.set('source.ts', base); await f.store.setExternalTracking(f.project, true);
    await f.set('source.ts', 'A\n' + 'same\n'.repeat(12) + 'Z\n');
    const review = await f.store.scanExternal(f.project), request = { project: f.project, revision: review.revision, file: 'source.ts' };
    const hunks = await f.store.hunks(request); expect(hunks).toHaveLength(2);
    const partial = await f.store.decideHunk({ ...request, hunk: hunks[0]!.id }, false);
    expect((await f.store.scanExternal(f.project)).revision).toBe(partial.revision);
    const remaining = await f.store.hunks({ ...request, revision: partial.revision });
    await f.store.decideHunk({ ...request, revision: partial.revision, hunk: remaining[0]!.id }, true);
    expect(await f.get('source.ts')).toBe('A\n' + 'same\n'.repeat(12) + 'z\n');
    expect((await f.store.scanExternal(f.project)).files).toEqual([]);
  });
  it('flushes final writes on stop, keeps pending review and excludes later edits until restarted', async () => {
    const f = await fixture(); await f.store.setExternalTracking(f.project, true);
    await f.set('source.ts', 'external\n'); const stopped = await f.store.setExternalTracking(f.project, false);
    expect(stopped.externalTracking).toBeUndefined(); expect(stopped.files).toHaveLength(1);
    await f.store.accept({ project: f.project, revision: stopped.revision });
    await f.set('source.ts', 'after stopping\n'); expect((await f.store.scanExternal(f.project)).files).toEqual([]);
    await f.store.setExternalTracking(f.project, true); await f.set('source.ts', 'new capture\n');
    const next = await f.store.scanExternal(f.project);
    expect((await f.store.preview({ project: f.project, revision: next.revision, file: 'source.ts' })).before).toBe('after stopping\n');
  });
});
