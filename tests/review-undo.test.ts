import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, unlink, readdir, utimes, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ReviewStore } from '../src/core/review';
import { StorageManager } from '../src/core/storage';
import { reviewGroup } from '../src/core/review-groups';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-undo-')); dirs.push(root);
  const project = path.join(root, 'project'); await mkdir(project);
  const store = new ReviewStore(path.join(root, 'reviews'));
  const set = (name: string, text: string | Buffer) => writeFile(path.join(project, name), text);
  const get = (name: string) => readFile(path.join(project, name));
  await set('a.ts', 'before a\nkeep\nlast\n'); await set('b.ts', 'before b\n');
  const changed = async () => {
    await store.begin(project, 'turn'); await set('a.ts', 'after a\nkeep\nlast\n'); await set('b.ts', 'after b\n'); return store.finish(project, 'turn');
  };
  return { root, project, store, set, get, changed };
}

describe('Undo Revert', () => {
  it('restores one conversation across reload, including added/deleted, binary and UTF-16 files, while tracking stays on', async () => {
    const f = await fixture();
    const old = Buffer.concat([Buffer.from([255, 254]), Buffer.from('old\r\n', 'utf16le')]);
    const next = Buffer.concat([Buffer.from([255, 254]), Buffer.from('new\r\n', 'utf16le')]);
    await f.set('utf16.txt', old); await f.set('removed.txt', 'removed'); await f.set('binary.bin', Buffer.from([0, 1, 2]));
    await f.store.setExternalTracking(f.project, true);
    const source = { key: 'Claude:c1', id: 'c1', title: 'Change files', provider: 'Claude' as const };
    await f.store.begin(f.project, 'claude', undefined, source);
    await f.set('a.ts', 'after a\n'); await f.set('utf16.txt', next); await f.set('added.txt', 'added');
    await unlink(path.join(f.project, 'removed.txt')); await f.set('binary.bin', Buffer.from([0, 5, 6]));
    await f.store.finish(f.project, 'claude');
    await f.store.begin(f.project, 'codex', undefined, { ...source, key: 'Codex:c2', id: 'c2', provider: 'Codex' });
    await f.set('b.ts', 'after b\n'); const review = await f.store.finish(f.project, 'codex');
    const reverted = await f.store.revert({ project: f.project, revision: review.revision, group: source.key });
    expect(reverted.files.map(file => file.path)).toEqual(['b.ts']); expect(reverted.undo!.files).toHaveLength(5);
    expect(await f.get('utf16.txt')).toEqual(old); await expect(f.get('added.txt')).rejects.toThrow();
    const store = new ReviewStore(f.store.directory);
    const scanned = await store.scanExternal(f.project); expect(scanned.files.map(file => file.path)).toEqual(['b.ts']);
    const restored = await store.undoRevert(f.project, scanned.undo!.id);
    expect(restored.undo).toBeUndefined(); expect(restored.externalTracking).toBe(true);
    expect(restored.files.filter(file => reviewGroup(file) === source.key)).toHaveLength(5);
    expect(await f.get('utf16.txt')).toEqual(next); expect((await f.get('added.txt')).toString()).toBe('added');
    await expect(f.get('removed.txt')).rejects.toThrow(); expect(await f.get('binary.bin')).toEqual(Buffer.from([0, 5, 6]));
    expect((await f.get('b.ts')).toString()).toBe('after b\n');
    expect((await store.scanExternal(f.project)).files).toEqual(restored.files);
  });
  it('undoes a rejected hunk without losing an accepted hunk or mixed line endings', async () => {
    const f = await fixture(); const before = 'old one\r\nkeep\nold two\r\nkeep\nold three';
    const after = before.replaceAll('old', 'new'); await f.set('a.ts', before);
    await f.store.begin(f.project, 'turn'); await f.set('a.ts', after); let review = await f.store.finish(f.project, 'turn');
    const request = () => ({ project: f.project, revision: review.revision, file: 'a.ts' });
    review = await f.store.decideHunk({ ...request(), hunk: (await f.store.hunks(request()))[0]!.id }, false);
    review = await f.store.decideHunk({ ...request(), hunk: (await f.store.hunks(request()))[0]!.id }, true);
    expect((await f.get('a.ts')).toString()).toBe(after.replace('new two', 'old two'));
    review = await f.store.undoRevert(f.project, review.undo!.id);
    expect((await f.get('a.ts')).toString()).toBe(after); expect(await f.store.hunks(request())).toHaveLength(2);
    await f.store.revert(request()); expect((await f.get('a.ts')).toString()).toBe(before.replace('old one', 'new one'));
  });
  it('preflights the whole Undo scope and keeps later user edits and all other files', async () => {
    const f = await fixture(), review = await f.changed();
    const reverted = await f.store.revert({ project: f.project, revision: review.revision });
    await f.set('b.ts', 'later manual work');
    await expect(f.store.undoRevert(f.project, reverted.undo!.id)).rejects.toThrow('Your edits were kept');
    expect((await f.get('a.ts')).toString()).toBe('before a\nkeep\nlast\n'); expect((await f.get('b.ts')).toString()).toBe('later manual work');
  });
  it('allows unrelated reviews but refuses Undo after accepting the remaining hunks of its file', async () => {
    const f = await fixture(); await f.store.begin(f.project, 'turn'); await f.set('a.ts', 'after a\nkeep\nchanged last\n'); await f.set('b.ts', 'after b\n');
    let review = await f.store.finish(f.project, 'turn'); const req = { project: f.project, revision: review.revision, file: 'a.ts' };
    review = await f.store.decideHunk({ ...req, hunk: (await f.store.hunks(req))[0]!.id }, true);
    const id = review.undo!.id;
    review = await f.store.accept({ project: f.project, revision: review.revision, file: 'b.ts' });
    expect(review.undo!.id).toBe(id);
    await f.store.accept({ project: f.project, revision: review.revision, file: 'a.ts' });
    await expect(f.store.undoRevert(f.project, id)).rejects.toThrow('reviewed after Revert');
  });
  it('recovers a crash after bytes were reverted but before metadata was published, retaining only applied Undo files', async () => {
    const f = await fixture(), review = await f.changed();
    const target = f.store as unknown as { save(value: unknown): Promise<void> };
    const save = target.save.bind(target); let calls = 0;
    vi.spyOn(target, 'save').mockImplementation(async value => { if (++calls > 1) throw new Error('simulated crash'); await save(value); });
    await expect(f.store.revert({ project: f.project, revision: review.revision })).rejects.toThrow('simulated crash');
    const store = new ReviewStore(f.store.directory), recovered = await store.read(f.project);
    expect(recovered.files.map(file => file.path)).toEqual(['b.ts']); expect(recovered.undo!.files).toEqual(['a.ts']);
    await store.undoRevert(f.project, recovered.undo!.id);
    expect((await f.get('a.ts')).toString()).toBe('after a\nkeep\nlast\n'); expect((await f.get('b.ts')).toString()).toBe('after b\n');
  });
  it('recovers a partially published Undo without repeating writes or losing its other pending files', async () => {
    const f = await fixture(), review = await f.changed();
    const reverted = await f.store.revert({ project: f.project, revision: review.revision });
    const target = f.store as unknown as { save(value: unknown): Promise<void> };
    const save = target.save.bind(target); let calls = 0;
    vi.spyOn(target, 'save').mockImplementation(async value => { if (++calls > 1) throw new Error('simulated crash'); await save(value); });
    await expect(f.store.undoRevert(f.project, reverted.undo!.id)).rejects.toThrow('simulated crash');
    const store = new ReviewStore(f.store.directory), recovered = await store.read(f.project);
    expect(recovered.files.map(file => file.path)).toEqual(['a.ts']); expect(recovered.undo!.files).toEqual(['b.ts']);
    const restored = await store.undoRevert(f.project, recovered.undo!.id); expect(restored.files).toHaveLength(2); expect(restored.undo).toBeUndefined();
  });
  it('pins Undo blobs and provenance during cleanup even after snapshots become old', async () => {
    const f = await fixture(), review = await f.changed();
    const reverted = await f.store.revert({ project: f.project, revision: review.revision });
    const old = new Date(Date.now() - 48 * 3600000);
    for (const folder of ['blobs', 'snapshots']) for (const name of await readdir(path.join(f.store.history.directory, folder))) await utimes(path.join(f.store.history.directory, folder, name), old, old);
    const manager = new StorageManager(f.root), plan = await manager.preview();
    for (const file of review.files) for (const hash of [file.before, file.after]) expect(plan.files.some(item => item.relative.endsWith(`/blobs/${hash}`))).toBe(false);
    await manager.cleanup(plan);
    const restored = await new ReviewStore(f.store.directory).undoRevert(f.project, reverted.undo!.id); expect(restored.files).toHaveLength(2);
  });
});
