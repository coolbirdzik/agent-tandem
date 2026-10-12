import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm, symlink, link, open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ReviewStore } from '../src/core/review';
const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-review-')); directories.push(parent);
  const project = path.join(parent, 'project'), storage = path.join(parent, 'reviews'); await mkdir(project);
  const store = new ReviewStore(storage);
  await writeFile(path.join(project, 'source.ts'), 'user work\r\n');
  const set = (name: string, text: string | Buffer) => writeFile(path.join(project, name), text);
  const get = (name: string) => readFile(path.join(project, name));
  const change = async (text = 'agent work\r\n') => { await store.begin(project, 'r1'); await set('source.ts', text); return store.finish(project, 'r1'); };
  return { parent, project, storage, store, set, get, change };
}
describe('Applied changes pending review', () => {
  it('captures a workspace over 20,000 files with and without Git and retains review/revert', async () => {
    const f = await fixture(); const folder = path.join(f.project, 'sources'); await mkdir(folder);
    let next = 0;
    await Promise.all(Array.from({ length: 16 }, async () => { while (next < 20_001) { const index = next++; await writeFile(path.join(folder, `${index}.txt`), 'same unchanged content\n'); } }));
    for (const withGit of [false, true]) {
      if (withGit) await execute('git', ['init', '-q'], { cwd: f.project, windowsHide: true });
      await f.store.begin(f.project, `large-${withGit}`);
      await f.set('source.ts', 'changed'); await f.set('new.ts', 'added'); await unlink(path.join(folder, '0.txt'));
      const review = await f.store.finish(f.project, `large-${withGit}`);
      expect(review.files.map(file => [file.path, file.kind])).toEqual([['new.ts', 'added'], ['source.ts', 'modified'], ['sources/0.txt', 'deleted']]);
      await f.store.revert({ project: f.project, revision: review.revision });
      expect((await f.get('source.ts')).toString()).toBe('user work\r\n');
      expect((await readFile(path.join(folder, '0.txt'), 'utf8'))).toBe('same unchanged content\n');
      expect((await f.store.read(f.project)).files).toEqual([]);
    }
  }, 120_000);
  it('does not cap total project bytes', async () => {
    const f = await fixture(); const store = new ReviewStore(f.storage);
    await f.set('one.txt', 'a'.repeat(24)); await f.set('two.txt', 'b'.repeat(24));
    await store.begin(f.project, 'r1'); await f.set('source.ts', 'agent'); const review = await store.finish(f.project, 'r1');
    expect(review.files.map(file => file.path)).toEqual(['source.ts']);
    await store.revert({ project: f.project, revision: review.revision }); expect((await f.get('source.ts')).toString()).toBe('user work\r\n');
  });
  it('captures, previews, persists, accepts and reverts src/core over 100 MiB without reading blobs into memory', async () => {
    const f = await fixture(); await mkdir(path.join(f.project, 'src'));
    const core = path.join(f.project, 'src/core'), size = 105 * 1024 * 1024;
    const handle = await open(core, 'w');
    try { await handle.truncate(size); await handle.write(Buffer.from('original'), 0, 8, 0); } finally { await handle.close(); }
    const checksum = async () => { const digest = createHash('sha256'); for await (const chunk of createReadStream(core)) digest.update(chunk); return digest.digest('hex'); };
    const originalHash = await checksum();
    const readBlob = vi.spyOn(f.store.history, 'readBlob');
    const putFileBlob = vi.spyOn(f.store.history, 'putFileBlob');
    await f.store.begin(f.project, 'read-only-core'); await f.store.finish(f.project, 'read-only-core');
    expect(putFileBlob).toHaveBeenCalledTimes(1); // Unchanged large files are hashed, not copied again.
    await f.store.begin(f.project, 'big-core');
    const changed = await open(core, 'r+'); try { await changed.write(Buffer.from('changed!'), 0, 8, size - 8); } finally { await changed.close(); }
    const review = await f.store.finish(f.project, 'big-core');
    expect(review.files).toHaveLength(1); expect(review.files[0]).toMatchObject({ path: 'src/core', kind: 'modified', binary: true });
    expect(review.files[0]?.before).toBe(originalHash);
    expect(await f.store.preview({ project: f.project, revision: review.revision, file: 'src/core' })).toMatchObject({ before: `${size} bytes`, after: `${size} bytes`, notice: 'Binary file · saved snapshots' });
    expect(readBlob).not.toHaveBeenCalledWith(originalHash);
    expect(readBlob).not.toHaveBeenCalledWith(review.files[0]?.after);
    const reopened = new ReviewStore(f.storage);
    expect((await reopened.read(f.project)).files).toEqual(review.files);
    await reopened.revert({ project: f.project, revision: review.revision });
    expect((await stat(core)).size).toBe(size); expect(await checksum()).toBe(originalHash);
    // Deleting and adding the large file also retain full bytes for Revert.
    await f.store.begin(f.project, 'delete-core'); await unlink(core);
    const deleted = await f.store.finish(f.project, 'delete-core');
    expect(deleted.files[0]?.kind).toBe('deleted'); await f.store.revert({ project: f.project, revision: deleted.revision });
    expect(await checksum()).toBe(originalHash);
    await unlink(core); await f.store.begin(f.project, 'add-core');
    const added = await open(core, 'w'); try { await added.truncate(size); } finally { await added.close(); }
    const addition = await f.store.finish(f.project, 'add-core'); expect(addition.files[0]?.kind).toBe('added');
    await f.store.accept({ project: f.project, revision: addition.revision });
    expect((await stat(core)).size).toBe(size); expect((await f.store.read(f.project)).files).toEqual([]);
  }, 60_000);
  it('can stop baseline capture without starting an active review', async () => {
    const f = await fixture(); const abort = new AbortController(); abort.abort();
    await expect(f.store.begin(f.project, 'r1', abort.signal)).rejects.toThrow();
    expect((await f.store.read(f.project)).busy).toBe(false);
  });
  it('captures modified, added, deleted and binary files with line counts and saved diff', async () => {
    const f = await fixture(); await f.set('deleted.ts', 'old'); await f.store.begin(f.project, 'r1');
    await f.set('source.ts', 'agent work\r\nnew line\r\n'); await f.set('new.ts', 'new'); await f.set('data.bin', Buffer.from([0, 255])); await unlink(path.join(f.project, 'deleted.ts'));
    const review = await f.store.finish(f.project, 'r1');
    expect(review.files.map(file => [file.path, file.kind])).toEqual([['data.bin', 'added'], ['deleted.ts', 'deleted'], ['new.ts', 'added'], ['source.ts', 'modified']]);
    expect(review.files.at(-1)).toMatchObject({ additions: 2, deletions: 1 });
    expect(review.files[0]?.binary).toBe(true);
    const preview = await f.store.preview({ project: f.project, revision: review.revision, file: 'source.ts' });
    expect(preview.patch).toContain('+agent work'); expect(preview.before).toBe('user work\r\n');
    expect((await f.get('source.ts')).toString()).toBe('agent work\r\nnew line\r\n');
  });
  it('keeps pending changes after reopening storage and isolates projects', async () => {
    const f = await fixture(); const review = await f.change();
    expect(await new ReviewStore(f.storage).read(f.project)).toEqual(review);
    const other = path.join(f.parent, 'other'); await mkdir(other);
    expect((await f.store.read(other)).files).toEqual([]);
  });
  it('gathers multiple turns without accepting previous changes', async () => {
    const f = await fixture(); const first = await f.change();
    await f.store.begin(f.project, 'r2'); await f.set('source.ts', 'agent work again'); await f.set('second.ts', 'second');
    const next = await f.store.finish(f.project, 'r2');
    expect(next.files).toHaveLength(2); expect(next.files.find(file => file.path === 'source.ts')?.before).toBe(first.files[0]?.before);
    await f.store.revert({ project: f.project, revision: next.revision });
    expect((await f.get('source.ts')).toString()).toBe('user work\r\n'); await expect(f.get('second.ts')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('Accept clears review without writing the already applied code, including later user edits', async () => {
    const f = await fixture(); const review = await f.change(); await f.set('source.ts', 'agent + user');
    expect((await f.store.accept({ project: f.project, revision: review.revision })).files).toEqual([]);
    expect((await f.get('source.ts')).toString()).toBe('agent + user');
    expect((await new ReviewStore(f.storage).read(f.project)).files).toEqual([]);
  });
  it('accepts one file and uses its current contents as the next turn baseline', async () => {
    const f = await fixture(); await f.store.begin(f.project, 'r1'); await f.set('source.ts', 'one'); await f.set('new.ts', 'new');
    const first = await f.store.finish(f.project, 'r1');
    const accepted = await f.store.accept({ project: f.project, revision: first.revision, file: 'source.ts' });
    expect(accepted.files.map(file => file.path)).toEqual(['new.ts']);
    await f.store.begin(f.project, 'r2'); await f.set('source.ts', 'two'); const next = await f.store.finish(f.project, 'r2');
    await f.store.revert({ project: f.project, revision: next.revision, file: 'source.ts' });
    expect((await f.get('source.ts')).toString()).toBe('one'); expect((await f.store.read(f.project)).files).toHaveLength(1);
  });
  it('reverts added/deleted files and preserves original binary/BOM/CRLF bytes and unrelated files', async () => {
    const f = await fixture(); const original = Buffer.from('\ufeffUser changes\r\n'); await f.set('source.ts', original); await f.set('deleted.bin', Buffer.from([0, 255]));
    await f.store.begin(f.project, 'r1'); await f.set('source.ts', 'changed'); await f.set('new.ts', 'new'); await unlink(path.join(f.project, 'deleted.bin'));
    const review = await f.store.finish(f.project, 'r1'); await f.set('unrelated.ts', 'user');
    expect((await f.store.revert({ project: f.project, revision: review.revision })).files).toEqual([]);
    expect(await f.get('source.ts')).toEqual(original); expect(await f.get('deleted.bin')).toEqual(Buffer.from([0, 255]));
    expect((await f.get('unrelated.ts')).toString()).toBe('user'); await expect(f.get('new.ts')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preflights all files and keeps every change pending when later edits conflict', async () => {
    const f = await fixture(); await f.store.begin(f.project, 'r1'); await f.set('source.ts', 'agent'); await f.set('new.ts', 'new');
    const review = await f.store.finish(f.project, 'r1'); await f.set('source.ts', 'my later work');
    await expect(f.store.revert({ project: f.project, revision: review.revision })).rejects.toThrow('it changed after the agent');
    expect((await f.get('new.ts')).toString()).toBe('new'); expect((await f.get('source.ts')).toString()).toBe('my later work');
    expect((await f.store.read(f.project)).files).toHaveLength(2);
  });
  it('preserves edits made while the original blob is being copied for revert', async () => {
    const f = await fixture(); const review = await f.change();
    const copyBlob = f.store.history.copyBlob.bind(f.store.history);
    vi.spyOn(f.store.history, 'copyBlob').mockImplementation(async (hash, target) => {
      await copyBlob(hash, target); await f.set('source.ts', 'user edited during copy');
    });
    await expect(f.store.revert({ project: f.project, revision: review.revision })).rejects.toThrow('changed during review');
    expect((await f.get('source.ts')).toString()).toBe('user edited during copy');
    expect((await f.store.read(f.project)).files).toHaveLength(1);
  });
  it('rejects stale decisions and decisions while an agent is active', async () => {
    const f = await fixture(); const first = await f.change(); await f.store.begin(f.project, 'r2');
    await expect(f.store.accept({ project: f.project, revision: first.revision })).rejects.toThrow('Wait for the agent');
    await f.set('source.ts', 'two'); const second = await f.store.finish(f.project, 'r2');
    await expect(f.store.revert({ project: f.project, revision: first.revision })).rejects.toThrow('updated');
    await expect(f.store.accept({ project: f.project, revision: second.revision, file: '../other' })).rejects.toThrow('already been reviewed');
  });
  it('rejects a new turn if a pending file changed outside the agent and allows Accept afterwards', async () => {
    const f = await fixture(); const review = await f.change(); await f.set('source.ts', 'user work after agent');
    await expect(f.store.begin(f.project, 'r2')).rejects.toThrow('changed outside the agent');
    expect((await f.store.read(f.project)).busy).toBe(false);
    await f.store.accept({ project: f.project, revision: review.revision }); await f.store.begin(f.project, 'r2');
    await f.set('source.ts', 'agent again'); const next = await f.store.finish(f.project, 'r2'); await f.store.revert({ project: f.project, revision: next.revision });
    expect((await f.get('source.ts')).toString()).toBe('user work after agent');
  });
  it('retains pending files over read-only turns and removes net-zero edits', async () => {
    const f = await fixture(); const first = await f.change(); await f.store.begin(f.project, 'r2');
    expect((await f.store.finish(f.project, 'r2')).files).toEqual(first.files);
    await f.store.begin(f.project, 'r3'); await f.set('source.ts', 'user work\r\n');
    expect((await f.store.finish(f.project, 'r3')).files).toEqual([]);
  });
  it('recovers an unfinished turn after restart including partial agent edits', async () => {
    const f = await fixture(); await f.store.begin(f.project, 'r1'); await f.set('source.ts', 'partial');
    const recovered = await new ReviewStore(f.storage).finish(f.project, undefined, true);
    expect(recovered.busy).toBe(false); expect(recovered.notice).toContain('interrupted'); expect(recovered.files).toHaveLength(1);
    await f.store.revert({ project: f.project, revision: recovered.revision }); expect((await f.get('source.ts')).toString()).toBe('user work\r\n');
  });
  it('finishes a revert after bytes were restored but the saved decision was interrupted', async () => {
    const f = await fixture(); const review = await f.change(); await f.set('source.ts', 'user work\r\n');
    expect((await new ReviewStore(f.storage).revert({ project: f.project, revision: review.revision })).files).toEqual([]);
    expect((await f.get('source.ts')).toString()).toBe('user work\r\n');
  });
  it('honors nested ignore rules for descendants without hiding the parent project', async () => {
    const f = await fixture(); await mkdir(path.join(f.project, 'sub/nested'), { recursive: true });
    await f.set('sub/.gitignore', '*.log\n'); await f.set('sub/nested/build.log', 'log'); await f.set('root.log', 'root');
    await f.store.begin(f.project, 'r1'); await f.set('sub/nested/build.log', 'changed'); await f.set('root.log', 'changed');
    expect((await f.store.finish(f.project, 'r1')).files.map(file => file.path)).toEqual(['root.log']);
  });
  it('respects .gitignore without Git and continues tracking files hidden by a later ignore rule', async () => {
    const f = await fixture(); await f.set('.gitignore', 'ignored/\n*.log\n'); await mkdir(path.join(f.project, 'ignored')); await f.set('ignored/cache', 'cache'); await f.set('run.log', 'log');
    await f.store.begin(f.project, 'r1'); await f.set('source.ts', 'agent'); await f.set('.gitignore', 'ignored/\n*.log\nsource.ts\n'); await f.set('run.log', 'new log');
    const review = await f.store.finish(f.project, 'r1'); expect(review.files.map(file => file.path)).toEqual(['.gitignore', 'source.ts']);
  });
  it('uses git tracked/untracked files while excluding ignored build output', async () => {
    const f = await fixture(); await execute('git', ['init', '-q'], { cwd: f.project, windowsHide: true });
    await f.set('.gitignore', 'dist/\n'); await execute('git', ['add', '.'], { cwd: f.project, windowsHide: true });
    await mkdir(path.join(f.project, 'dist')); await f.set('dist/build.js', 'build');
    await f.store.begin(f.project, 'r1'); await f.set('source.ts', 'agent'); await f.set('new.ts', 'new'); await f.set('dist/build.js', 'new build');
    expect((await f.store.finish(f.project, 'r1')).files.map(file => file.path)).toEqual(['new.ts', 'source.ts']);
  });
  it('refuses linked targets on revert and preserves the outside file', async () => {
    const f = await fixture(); await mkdir(path.join(f.project, 'folder')); await f.set('folder/test.ts', 'before');
    await f.store.begin(f.project, 'r1'); await f.set('folder/test.ts', 'after'); const review = await f.store.finish(f.project, 'r1');
    const outside = path.join(f.parent, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'test.ts'), 'outside');
    await rm(path.join(f.project, 'folder'), { recursive: true }); await symlink(outside, path.join(f.project, 'folder'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.store.revert({ project: f.project, revision: review.revision })).rejects.toThrow('Linked file');
    expect((await readFile(path.join(outside, 'test.ts'))).toString()).toBe('outside');
  });
  it('refuses hardlinks before creating an active turn', async () => {
    const f = await fixture(); await link(path.join(f.project, 'source.ts'), path.join(f.parent, 'linked'));
    await expect(f.store.begin(f.project, 'r1')).rejects.toThrow('Linked file'); expect((await f.store.read(f.project)).busy).toBe(false);
    await unlink(path.join(f.parent, 'linked'));
  });
});
