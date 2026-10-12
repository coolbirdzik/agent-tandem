import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, utimes, rm, lstat, symlink, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { StorageManager } from '../src/core/storage';
import { ReviewStore } from '../src/core/review';
import { HistoryStore } from '../src/core/history';
import { CheckpointStore } from '../src/core/checkpoints';
import { withStorageLock } from '../src/core/storage-lock';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture() {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'agent-dock-storage-')); folders.push(folder);
  const root = path.join(folder, 'data'), project = path.join(folder, 'project'); await mkdir(project); await writeFile(path.join(project, 'source.ts'), 'user baseline\n');
  const reviews = new ReviewStore(path.join(root, 'reviews')), checkpoints = new CheckpointStore(path.join(root, 'checkpoints')), manager = new StorageManager(root);
  const orphan = async (history = reviews.history, text = 'unused') => {
    const id = randomUUID(), blob = await history.putBlob(Buffer.from(text)), file = path.join(history.directory, 'snapshots', `${id}.json`);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify({ id, files: { 'unused.ts': blob } }));
    return { id, blob, file };
  };
  const age = async () => {
    const walk = async (directory: string) => { for (const entry of await readdir(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) await walk(full); else await utimes(full, new Date(0), new Date(0)); } };
    await walk(root);
  };
  return { folder, root, project, reviews, checkpoints, manager, orphan, age };
}
describe('Snapshot storage management', () => {
  it('groups history by project and conversation, deletes selected checkpoints and keeps shared and unselected snapshots', async () => {
    const f = await fixture(); await f.reviews.begin(f.project, 'setup'); await f.reviews.finish(f.project, 'setup');
    const shared = await f.orphan(f.reviews.history, 'shared'), exclusive = await f.orphan(f.reviews.history, 'exclusive'), unselected = await f.orphan(f.reviews.history, 'unselected');
    const first = await f.checkpoints.record(f.project, 'Codex:first', ['first'], shared.id);
    const second = await f.checkpoints.record(f.project, 'Codex:first', ['first', 'second'], exclusive.id);
    const kept = await f.checkpoints.record(f.project, 'Claude:keep', ['keep'], shared.id);
    await f.checkpoints.saveUndo(f.project, shared.id); await f.age();
    const histories = (await f.manager.inspect()).histories!;
    expect(histories).toHaveLength(3); expect(histories.every(group => group.project === f.project)).toBe(true);
    const selected = histories.find(group => group.label === 'Codex:first')!; expect(selected.count).toBe(2);
    const plan = await f.manager.previewHistoryDeletion([selected.id]);
    expect(plan.files.map(file => file.relative).sort()).toEqual([`reviews/history/snapshots/${exclusive.id}.json`, `reviews/history/blobs/${exclusive.blob}`].sort());
    expect(plan.bytes).toBeGreaterThan(0);
    const result = await f.manager.deleteHistory(plan);
    expect(result).toMatchObject({ checkpointsRemoved: 2, removed: 2, bytes: plan.bytes, skipped: 0, failures: [] });
    await expect(f.checkpoints.get(f.project, first)).rejects.toThrow('no longer available'); await expect(f.checkpoints.get(f.project, second)).rejects.toThrow('no longer available');
    expect(await f.checkpoints.get(f.project, kept)).toBeTruthy(); expect(await f.checkpoints.undo(f.project)).toBeTruthy();
    expect(await f.reviews.history.snapshot(shared.id)).toBeTruthy(); expect(await f.reviews.history.snapshot(unselected.id)).toBeTruthy();
    expect(await readFile(path.join(f.project, 'source.ts'), 'utf8')).toBe('user baseline\n');
  });
  it('allows deleting restore backups explicitly and keeps pending Review revert working', async () => {
    const f = await fixture(); await f.reviews.begin(f.project, 'turn'); const before = await f.reviews.checkpointBefore(f.project, 'turn');
    await writeFile(path.join(f.project, 'source.ts'), 'agent changes\n'); const review = await f.reviews.finish(f.project, 'turn');
    await f.checkpoints.record(f.project, 'Codex:turn', ['message'], before); await f.checkpoints.saveUndo(f.project, before);
    const histories = (await f.manager.inspect()).histories!;
    const result = await f.manager.deleteHistory(await f.manager.previewHistoryDeletion(histories.map(group => group.id)));
    expect(result.checkpointsRemoved).toBe(2); expect(await f.checkpoints.undo(f.project)).toBeUndefined();
    await f.reviews.revert({ project: f.project, revision: review.revision });
    expect(await readFile(path.join(f.project, 'source.ts'), 'utf8')).toBe('user baseline\n');
    expect((await f.manager.inspect()).cleanupBlocked).toBeUndefined();
  });
  it('keeps blobs shared with an old orphan outside the explicit deletion selection', async () => {
    const f = await fixture(), first = await f.orphan(f.reviews.history, 'same'), other = await f.orphan(f.reviews.history, 'same');
    await f.checkpoints.record(f.project, 'Codex:first', ['first'], first.id); await f.age();
    const group = (await f.manager.inspect()).histories![0]!;
    const plan = await f.manager.previewHistoryDeletion([group.id]);
    expect(plan.files.map(file => file.relative)).toEqual([`reviews/history/snapshots/${first.id}.json`]);
    await f.manager.deleteHistory(plan); expect(await f.reviews.history.snapshot(other.id)).toBeTruthy(); expect(await f.reviews.history.readBlob(other.blob)).toBeTruthy();
  });
  it('rejects stale history previews and active captures before removing records', async () => {
    const f = await fixture(), saved = await f.orphan(); const id = await f.checkpoints.record(f.project, 'Codex:first', ['first'], saved.id);
    const selected = (await f.manager.inspect()).histories![0]!;
    const plan = await f.manager.previewHistoryDeletion([selected.id]);
    await f.checkpoints.record(f.project, 'Claude:new', ['new'], saved.id);
    await expect(f.manager.deleteHistory(plan)).rejects.toThrow('Saved history changed'); expect(await f.checkpoints.get(f.project, id)).toBeTruthy();
    const refreshed = await f.manager.previewHistoryDeletion([selected.id]);
    await f.reviews.begin(f.project, 'active');
    await expect(f.manager.previewHistoryDeletion([selected.id])).rejects.toThrow('Wait for the agent');
    await expect(f.manager.deleteHistory(refreshed)).rejects.toThrow('Wait for the agent'); expect(await f.checkpoints.get(f.project, id)).toBeTruthy();
  });
  it('revalidates newly protected blobs and changed manifests after history preview', async () => {
    const f = await fixture(), savedPoint = await f.orphan(f.reviews.history, 'newly protected');
    await f.checkpoints.record(f.project, 'Codex:first', ['first'], savedPoint.id);
    const group = (await f.manager.inspect()).histories![0]!;
    const plan = await f.manager.previewHistoryDeletion([group.id]);
    await writeFile(path.join(f.project, 'source.ts'), 'newly protected'); await f.reviews.initializeExternalTracking(f.project);
    const result = await f.manager.deleteHistory(plan);
    expect(result.checkpointsRemoved).toBe(1); expect(result.skipped).toBeGreaterThan(0); expect((await f.manager.inspect()).cleanupBlocked).toBeUndefined();
    const saved = await f.orphan(f.reviews.history, 'changed manifest'); await f.checkpoints.record(f.project, 'Codex:other', ['other'], saved.id);
    const other = (await f.manager.inspect()).histories![0]!;
    const changed = await f.manager.previewHistoryDeletion([other.id]);
    await writeFile(saved.file, JSON.stringify({ id: saved.id, files: { 'renamed.ts': saved.blob } }));
    const kept = await f.manager.deleteHistory(changed);
    expect(kept).toMatchObject({ checkpointsRemoved: 1, removed: 0, skipped: 2, failures: [] });
    expect(await f.reviews.history.readBlob(saved.blob)).toBeTruthy(); expect((await f.manager.inspect()).cleanupBlocked).toBeUndefined();
  });
  it('cleans old unreferenced snapshots while preserving tracking, pending revert, checkpoints, Undo and demo history', async () => {
    const f = await fixture(); await f.reviews.begin(f.project, 'chat'); const checkpoint = await f.reviews.checkpointBefore(f.project, 'chat'); await f.reviews.finish(f.project, 'chat');
    await f.checkpoints.record(f.project, 'Codex:conversation', ['message'], checkpoint); await f.checkpoints.saveUndo(f.project, checkpoint);
    await f.reviews.initializeExternalTracking(f.project); await writeFile(path.join(f.project, 'source.ts'), 'external edits\n'); const pending = await f.reviews.scanExternal(f.project);
    const demo = new HistoryStore(f.root), saved = await demo.capture(f.project);
    await demo.saveSession({ id: randomUUID(), baseline: saved.id, version: 1, source: 'demo', title: 'Demo', createdAt: new Date().toISOString(), status: 'completed', steps: [] });
    await mkdir(path.join(f.root, 'usage')); await writeFile(path.join(f.root, 'usage/ledger.jsonl'), 'usage evidence');
    await mkdir(path.join(f.root, 'attachments')); await writeFile(path.join(f.root, 'attachments/user.png'), 'attachment');
    const unused = await f.orphan(); await f.age();
    const plan = await f.manager.preview(); expect(plan.files.length).toBeGreaterThanOrEqual(2); expect(plan.files.some(file => file.relative.endsWith(`${unused.id}.json`))).toBe(true);
    expect((await f.manager.inspect()).categories?.map(row => row.label)).toContain('Chat attachments');
    expect(await f.manager.cleanup(plan)).toMatchObject({ removed: plan.files.length, skipped: 0, failures: [] });
    await expect(lstat(unused.file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(f.root, 'usage/ledger.jsonl'), 'utf8')).toBe('usage evidence');
    await f.reviews.revert({ project: f.project, revision: pending.revision }); expect(await readFile(path.join(f.project, 'source.ts'), 'utf8')).toBe('user baseline\n');
    expect((await f.reviews.scanExternal(f.project)).files).toEqual([]);
    await f.reviews.setExternalTracking(f.project, false);
    await writeFile(path.join(f.project, 'source.ts'), 'manual later\n');
    const restored = await f.reviews.restoreCheckpoint(f.project, await f.reviews.prepareCheckpoint(f.project, checkpoint), snapshot => f.checkpoints.saveUndo(f.project, snapshot).then(() => undefined));
    expect(restored.busy).toBe(false); expect(await demo.snapshot(saved.id)).toBeTruthy();
  });
  it('protects active capture and recent snapshots, including shared blobs from old unused manifests', async () => {
    const f = await fixture(); await f.reviews.begin(f.project, 'active'); const active = await f.reviews.checkpointBefore(f.project, 'active');
    const shared = (await f.reviews.history.snapshot(active)).files['source.ts']!;
    const id = randomUUID(); await mkdir(path.join(f.reviews.history.directory, 'snapshots'), { recursive: true });
    const oldManifest = path.join(f.reviews.history.directory, 'snapshots', `${id}.json`);
    await writeFile(oldManifest, JSON.stringify({ id, files: { 'old.ts': shared } })); await f.age();
    const recent = await f.orphan(f.reviews.history, 'recent');
    const plan = await f.manager.preview(); expect(plan.files.map(file => file.relative)).toEqual([`reviews/history/snapshots/${id}.json`]);
    await f.manager.cleanup(plan); expect(await f.reviews.history.readBlob(shared)).toBeTruthy(); expect(await f.reviews.history.snapshot(recent.id)).toBeTruthy();
    await f.reviews.finish(f.project, 'active');
  });
  it('revalidates preview targets and keeps newly referenced or modified files', async () => {
    const f = await fixture(), first = await f.orphan(), second = await f.orphan(f.reviews.history, 'second'); await f.age();
    const plan = await f.manager.preview();
    await f.checkpoints.record(f.project, 'Codex:message', ['save'], first.id);
    await writeFile(second.file, JSON.stringify({ id: second.id, files: { 'same.ts': second.blob } }));
    const result = await f.manager.cleanup(plan); expect(result).toMatchObject({ removed: 0, skipped: 4 });
    expect(await f.reviews.history.snapshot(first.id)).toBeTruthy(); expect(await f.reviews.history.snapshot(second.id)).toBeTruthy();
  });
  it('blocks cleanup with corrupt or missing protected metadata', async () => {
    const f = await fixture(); await f.orphan(); await f.age(); await mkdir(path.join(f.root, 'checkpoints'), { recursive: true });
    const record = path.join(f.root, 'checkpoints', `${'a'.repeat(64)}.json`); await writeFile(record, '{broken');
    expect((await f.manager.inspect()).cleanupBlocked).toContain('unreadable metadata'); await expect(f.manager.preview()).rejects.toThrow('unreadable metadata');
    await writeFile(record, JSON.stringify([{ id: randomUUID(), snapshot: randomUUID() }])); await expect(f.manager.preview()).rejects.toThrow('referenced snapshot is missing');
  });
  it('rejects linked storage folders and serializes cleanup with other snapshot operations', async () => {
    const f = await fixture(); await f.orphan(); await f.age(); const plan = await f.manager.preview();
    let release!: () => void, entered!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const first = withStorageLock(f.root, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await entry; let cleaned = false;
    const second = f.manager.cleanup(plan).then(() => { cleaned = true; });
    await new Promise(resolve => setTimeout(resolve, 70)); expect(cleaned).toBe(false); release(); await first; await second;
    const outside = path.join(f.folder, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'keep.txt'), 'keep');
    await symlink(outside, path.join(f.root, 'linked'), 'junction');
    await expect(f.manager.preview()).rejects.toThrow('Linked storage'); expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });
});
