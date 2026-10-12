import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CheckpointStore } from '../src/core/checkpoints';
import { ReviewStore } from '../src/core/review';
import type { ConversationContent, ConversationProvider } from '../src/providers/conversations';
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-dock-checkpoints-')); directories.push(root);
  const project = path.join(root, 'project'); await mkdir(project);
  const reviews = new ReviewStore(path.join(root, 'reviews')), checkpoints = new CheckpointStore(path.join(root, 'checkpoints'));
  const set = (name: string, bytes: string | Buffer) => writeFile(path.join(project, name), bytes);
  const get = (name: string) => readFile(path.join(project, name));
  await set('source.ts', '\ufeffuser work\r\n');
  const capture = async (requestId = 'r1') => { await reviews.begin(project, requestId); return reviews.checkpointBefore(project, requestId); };
  return { root, project, reviews, checkpoints, set, get, capture };
}
function content(provider: ConversationProvider, texts: string[], key = `${provider}:native`) : ConversationContent {
  return { conversation: { key, id: 'native', provider, title: 'Test', cwd: '/project', updatedAt: 1, revision: 'native:1' }, messages: texts.map((text, i) => ({ id: `native-user-${i}`, role: 'user', text })) };
}
describe('Per-message checkpoints', () => {
  it.each(['Codex', 'Claude'] as const)('maps %s native message IDs after reopen, distinguishing repeated prompts and stale prefixes', async provider => {
    const f = await fixture(), first = await f.capture();
    const id1 = await f.checkpoints.record(f.project, `${provider}:draft`, ['Repeat'], first);
    await f.set('source.ts', 'first turn'); await f.reviews.finish(f.project, 'r1');
    const second = await f.capture('r2');
    const id2 = await f.checkpoints.record(f.project, `${provider}:draft`, ['Repeat', 'Repeat'], second);
    await f.reviews.finish(f.project, 'r2');
    await f.checkpoints.bind(f.project, `${provider}:draft`, `${provider}:native`);
    const reopened = new CheckpointStore(f.checkpoints.directory);
    expect(await reopened.list(f.project, content(provider, ['Repeat', 'Repeat']))).toEqual([
      expect.objectContaining({ id: id1, messageId: 'native-user-0' }), expect.objectContaining({ id: id2, messageId: 'native-user-1' }),
    ]);
    expect((await reopened.get(f.project, id2)).snapshot).toBe(second);
    expect(await reopened.list(f.project, content(provider, ['Edited', 'Repeat']))).toEqual([]);
    expect(await reopened.list(f.project, content(provider, ['Repeat'], `${provider}:other`))).toEqual([]);
    expect(await reopened.list(path.join(f.root, 'other'), content(provider, ['Repeat']))).toEqual([]);
  });
  it('inherits only matching earlier checkpoints when editing into a new branch', async () => {
    const f = await fixture(), snapshot = randomUUID();
    await f.checkpoints.record(f.project, 'Codex:old', ['one'], snapshot);
    await f.checkpoints.record(f.project, 'Codex:old', ['one', 'two'], snapshot);
    await f.checkpoints.record(f.project, 'Codex:draft', ['one', 'replacement'], snapshot, 'Codex:old');
    await f.checkpoints.bind(f.project, 'Codex:draft', 'Codex:new');
    expect((await f.checkpoints.list(f.project, content('Codex', ['one', 'replacement'], 'Codex:new'))).map(entry => entry.messageId)).toEqual(['native-user-0', 'native-user-1']);
    expect(await f.checkpoints.list(f.project, content('Codex', ['one', 'two'], 'Codex:old'))).toHaveLength(2);
  });
  it('restores the exact before-send bytes across turns and Accept, previews first, and can undo after reopening', async () => {
    const f = await fixture();
    const binary = Buffer.from([0, 255, 32, 10]); await f.set('deleted.bin', binary);
    const large = Buffer.alloc(1024 * 1024 + 1, 0); await f.set('large.bin', large);
    const before = await f.capture(); const id = await f.checkpoints.record(f.project, 'Codex:native', ['first'], before);
    await f.set('source.ts', 'turn one'); await unlink(path.join(f.project, 'deleted.bin')); await f.set('added.ts', 'new');
    const first = await f.reviews.finish(f.project, 'r1'); await f.reviews.accept({ project: f.project, revision: first.revision });
    await f.capture('r2'); await f.set('source.ts', 'turn two'); await f.set('large.bin', 'changed');
    const second = await f.reviews.finish(f.project, 'r2'); await f.reviews.accept({ project: f.project, revision: second.revision });
    await f.set('manual.ts', 'later manual work');
    const reopened = new ReviewStore(f.reviews.directory), checkpoint = await f.checkpoints.get(f.project, id);
    const plan = await reopened.prepareCheckpoint(f.project, checkpoint.snapshot);
    expect(plan.files.map(file => [file.path, file.kind])).toEqual([['added.ts', 'deleted'], ['deleted.bin', 'added'], ['large.bin', 'modified'], ['manual.ts', 'deleted'], ['source.ts', 'modified']]);
    expect((await f.get('source.ts')).toString()).toBe('turn two');
    const readBlob = vi.spyOn(reopened.history, 'readBlob');
    await reopened.restoreCheckpoint(f.project, plan, async snapshot => { await f.checkpoints.saveUndo(f.project, snapshot); });
    expect((await f.get('source.ts')).toString()).toBe('\ufeffuser work\r\n');
    expect(await f.get('deleted.bin')).toEqual(binary); expect(await f.get('large.bin')).toEqual(large);
    await expect(f.get('added.ts')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(readBlob).not.toHaveBeenCalledWith((await reopened.history.snapshot(before)).files['large.bin']);
    const undo = await new CheckpointStore(f.checkpoints.directory).undo(f.project);
    const undoSnapshot = (await f.checkpoints.get(f.project, undo!.id)).snapshot;
    await reopened.restoreCheckpoint(f.project, await reopened.prepareCheckpoint(f.project, undoSnapshot));
    expect((await f.get('source.ts')).toString()).toBe('turn two'); expect((await f.get('manual.ts')).toString()).toBe('later manual work');
    expect((await reopened.read(f.project)).files).toEqual([]);
  }, 20_000);
  it.each(['modified', 'added', 'deleted'])('rejects a %s file after preview before any write or replacing Undo', async kind => {
    const f = await fixture(), target = await f.capture(); await f.set('source.ts', 'agent'); await f.set('a.ts', 'agent'); await f.reviews.finish(f.project, 'r1');
    const plan = await f.reviews.prepareCheckpoint(f.project, target), backup = vi.fn();
    if (kind === 'modified') await f.set('source.ts', 'new user work');
    if (kind === 'added') await f.set('new.ts', 'new user file');
    if (kind === 'deleted') await unlink(path.join(f.project, 'source.ts'));
    await expect(f.reviews.restoreCheckpoint(f.project, plan, backup)).rejects.toThrow('changed after the preview');
    expect((await f.get('a.ts')).toString()).toBe('agent'); expect(backup).not.toHaveBeenCalled();
  });
  it('reconciles pending review against its original baseline and keeps ignored output', async () => {
    const f = await fixture(); await f.set('.gitignore', '*.log\n'); await f.set('cache.log', 'old cache');
    await f.capture(); await f.set('source.ts', 'turn one'); const first = await f.reviews.finish(f.project, 'r1');
    const target = await f.capture('r2'); await f.set('source.ts', 'turn two'); await f.set('new.ts', 'new'); await f.set('cache.log', 'new cache'); await f.reviews.finish(f.project, 'r2');
    const restored = await f.reviews.restoreCheckpoint(f.project, await f.reviews.prepareCheckpoint(f.project, target));
    expect(restored.files.map(file => [file.path, file.before, file.after])).toEqual(first.files.map(file => [file.path, file.before, file.after]));
    expect((await f.get('cache.log')).toString()).toBe('new cache');
    await f.reviews.begin(f.project, 'r3'); await f.reviews.finish(f.project, 'r3');
  });
  it('preflights corrupt blobs and linked targets before touching any other file', async () => {
    const f = await fixture(); await f.set('z.ts', 'original z'); const target = await f.capture();
    await f.set('source.ts', 'changed'); await f.set('z.ts', 'changed z'); await f.reviews.finish(f.project, 'r1');
    const plan = await f.reviews.prepareCheckpoint(f.project, target);
    const snapshot = await f.reviews.history.snapshot(target);
    await writeFile(path.join(f.reviews.history.directory, 'blobs', snapshot.files['z.ts']!), 'corrupt');
    await expect(f.reviews.restoreCheckpoint(f.project, plan)).rejects.toThrow(/corrupt|hash/i);
    expect((await f.get('source.ts')).toString()).toBe('changed');
    await writeFile(path.join(f.reviews.history.directory, 'blobs', snapshot.files['z.ts']!), 'original z');
    const outside = path.join(f.root, 'outside.ts'); await writeFile(outside, 'outside'); await unlink(path.join(f.project, 'z.ts'));
    await symlink(outside, path.join(f.project, 'z.ts'), 'file');
    await expect(f.reviews.restoreCheckpoint(f.project, plan)).rejects.toThrow('Linked file');
    expect((await f.get('source.ts')).toString()).toBe('changed'); expect(await readFile(outside, 'utf8')).toBe('outside');
  });
  it('protects edits during copying and journals partial restore for review/reload', async () => {
    const f = await fixture(), target = await f.capture(); await f.set('source.ts', 'agent'); await f.set('a.ts', 'added'); await f.reviews.finish(f.project, 'r1');
    const plan = await f.reviews.prepareCheckpoint(f.project, target), original = f.reviews.history.copyBlob.bind(f.reviews.history);
    vi.spyOn(f.reviews.history, 'copyBlob').mockImplementation(async (hash, temporary) => { await original(hash, temporary); await f.set('source.ts', 'user edit during copy'); });
    await expect(f.reviews.restoreCheckpoint(f.project, plan)).rejects.toThrow('changed during restore');
    expect((await f.get('source.ts')).toString()).toBe('user edit during copy');
    const reopened = await new ReviewStore(f.reviews.directory).read(f.project);
    expect(reopened.busy).toBe(false); expect(reopened.files.map(file => file.path)).toEqual(['source.ts']);
    await expect(f.get('a.ts')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects active turns and stale review decisions; a matching checkpoint is a no-op', async () => {
    const f = await fixture(), target = await f.capture();
    await expect(f.reviews.prepareCheckpoint(f.project, target)).rejects.toThrow('Wait for the agent');
    await f.set('source.ts', 'agent'); const review = await f.reviews.finish(f.project, 'r1');
    const plan = await f.reviews.prepareCheckpoint(f.project, target); await f.reviews.accept({ project: f.project, revision: review.revision });
    await expect(f.reviews.restoreCheckpoint(f.project, plan)).rejects.toThrow('reviewed after this preview');
    const fresh = await f.reviews.prepareCheckpoint(f.project, target); await f.reviews.restoreCheckpoint(f.project, fresh);
    const matching = await f.reviews.prepareCheckpoint(f.project, target), backup = vi.fn();
    expect(matching.files).toEqual([]); await f.reviews.restoreCheckpoint(f.project, matching, backup); expect(backup).not.toHaveBeenCalled();
  });
});
