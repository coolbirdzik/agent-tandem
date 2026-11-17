import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, utimes } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { ReviewStore } from '../src/core/review';
import { StorageManager } from '../src/core/storage';
import { gitRefOf, gitRefOfFile, readGitRefs } from '../src/core/git-refs';

const execute = promisify(execFile);
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

/** A repository whose committed text is LF while the working copy is CRLF, as `core.autocrlf` checks it out on Windows. */
async function fixture() {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-git-backed-')); folders.push(folder);
  const root = path.join(folder, 'data'), project = path.join(folder, 'project'); await mkdir(project);
  const git = (...args: string[]) => execute('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: project, windowsHide: true });
  await git('init', '-q');
  await writeFile(path.join(project, 'lf.ts'), 'one\ntwo\n');
  await writeFile(path.join(project, 'crlf.ts'), 'alpha\nbeta\n');
  await writeFile(path.join(project, 'image.bin'), Buffer.from([0, 1, 2, 10, 13, 10, 255]));
  await git('add', '.'); await git('commit', '-q', '-m', 'initial');
  await writeFile(path.join(project, 'crlf.ts'), 'alpha\r\nbeta\r\n');
  await writeFile(path.join(project, 'untracked.ts'), 'not in git\n');
  const blobs = async () => (await readdir(path.join(root, 'reviews', 'history', 'blobs')).catch(() => [] as string[])).filter(name => /^[a-f0-9]{64}$/.test(name));
  const manifest = async (id: string) => JSON.parse(await readFile(path.join(root, 'reviews', 'history', 'snapshots', `${id}.json`), 'utf8'));
  const external = async () => (JSON.parse(await readFile(path.join(root, 'reviews', (await readdir(path.join(root, 'reviews'))).find(name => name.endsWith('.json'))!), 'utf8'))).external as string;
  return { folder, root, project, git, blobs, manifest, external };
}

describe('Git-backed snapshots', () => {
  it('recognizes raw and CRLF checkouts of an object byte for byte', async () => {
    const lf = Buffer.from('a\nb\n');
    const id = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    expect(gitRefOf(lf, id(lf))).toBe(id(lf));
    expect(gitRefOf(Buffer.from('a\r\nb\r\n'), id(lf))).toBe(`${id(lf)}:crlf`);
    // A lone LF or different text cannot be rebuilt from the object.
    expect(gitRefOf(Buffer.from('a\r\nb\n'), id(lf))).toBeUndefined();
    expect(gitRefOf(Buffer.from('a\r\nc\r\n'), id(lf))).toBeUndefined();
    expect(gitRefOf(Buffer.alloc(0), id(Buffer.alloc(0)))).toBeUndefined();
    // Streaming agrees across chunk boundaries that split a CRLF pair.
    const folder = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-git-ref-')); folders.push(folder);
    const big = Buffer.from('line\r\n'.repeat(400000)), file = path.join(folder, 'big.txt');
    await writeFile(file, big);
    const object = Buffer.from('line\n'.repeat(400000));
    expect((await gitRefOfFile(file, id(object))).ref).toBe(`${id(object)}:crlf`);
  });

  it('tracks a workspace without copying content Git already holds, and rebuilds it exactly when it changes', async () => {
    const f = await fixture(), store = new ReviewStore(path.join(f.root, 'reviews'));
    await store.initializeExternalTracking(f.project);
    const baseline = await f.manifest(await f.external());
    expect(Object.keys(baseline.files).sort()).toEqual(['crlf.ts', 'image.bin', 'lf.ts', 'untracked.ts']);
    expect(Object.values(baseline.git.refs).sort()).toEqual(expect.arrayContaining([expect.stringMatching(/:crlf$/), expect.stringMatching(/^[a-f0-9]{40}$/)]));
    // Only the file Git does not have was copied.
    expect(await f.blobs()).toEqual([baseline.files['untracked.ts']]);

    await writeFile(path.join(f.project, 'crlf.ts'), 'alpha\r\nchanged\r\n');
    await writeFile(path.join(f.project, 'image.bin'), Buffer.from([9, 9]));
    const review = await store.scanExternal(f.project);
    expect(review.files.map(file => file.path)).toEqual(['crlf.ts', 'image.bin']);
    // The scan stored only its difference from the baseline.
    const delta = await f.manifest(await f.external());
    expect(delta.base).toBe(baseline.id); expect(Object.keys(delta.files).sort()).toEqual(['crlf.ts', 'image.bin']);
    // Pending review owns real copies, so it never depends on the repository again.
    const blobs = await f.blobs();
    for (const file of review.files) { expect(blobs).toContain(file.before); expect(blobs).toContain(file.after); }
    const reopened = new ReviewStore(path.join(f.root, 'reviews'));
    expect((await reopened.history.readBlob(review.files[0]!.before!)).toString('latin1')).toBe('alpha\r\nbeta\r\n');
    expect([...await reopened.history.readBlob(review.files[1]!.before!)]).toEqual([0, 1, 2, 10, 13, 10, 255]);
    await reopened.revert({ project: f.project, revision: review.revision });
    expect(await readFile(path.join(f.project, 'crlf.ts'), 'latin1')).toBe('alpha\r\nbeta\r\n');
    expect([...await readFile(path.join(f.project, 'image.bin'))]).toEqual([0, 1, 2, 10, 13, 10, 255]);

    // Storage cleanup understands the Git-backed baseline and its difference manifests.
    const manager = new StorageManager(f.root), state = await manager.inspect();
    expect(state.cleanupBlocked).toBeUndefined();
    expect(state.histories?.find(history => history.kind === 'tracking')).toBeTruthy();
  });

  it('restores a checkpoint from Git-backed content after reopening', async () => {
    const f = await fixture(), store = new ReviewStore(path.join(f.root, 'reviews'));
    await store.begin(f.project, 'turn');
    const before = await store.checkpointBefore(f.project, 'turn');
    await writeFile(path.join(f.project, 'lf.ts'), 'agent edit\n');
    await store.finish(f.project, 'turn');
    await store.accept({ project: f.project, revision: (await store.read(f.project)).revision });
    const reopened = new ReviewStore(path.join(f.root, 'reviews'));
    const plan = await reopened.prepareCheckpoint(f.project, before);
    expect(plan.files.map(file => file.path)).toEqual(['lf.ts']);
    await reopened.restoreCheckpoint(f.project, plan);
    expect(await readFile(path.join(f.project, 'lf.ts'), 'latin1')).toBe('one\ntwo\n');
  });

  it('replaces a baseline that copied every file with Git references once, leaving the copies to cleanup', async () => {
    const f = await fixture();
    // Tracking started before Git-backed snapshots existed: every file was copied.
    await new ReviewStore(path.join(f.root, 'reviews'), () => false).initializeExternalTracking(f.project);
    const old = await f.external(), copies = await f.blobs();
    expect(copies).toHaveLength(4); expect((await f.manifest(old)).git).toBeUndefined();
    const store = new ReviewStore(path.join(f.root, 'reviews'));
    const review = await store.scanExternal(f.project);
    expect(review.files).toEqual([]);
    const migrated = await f.manifest(await f.external());
    expect(migrated.id).not.toBe(old); expect(Object.keys(migrated.git.refs)).toHaveLength(3);
    // Once old enough, automatic cleanup removes the old baseline and the three copies Git can rebuild.
    const walk = async (directory: string): Promise<void> => { for (const entry of await readdir(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) await walk(full); else await utimes(full, new Date(0), new Date(0)); } };
    await walk(f.root);
    const cleaned = await new StorageManager(f.root).autoCleanReview();
    expect(cleaned.failures).toEqual([]); expect(cleaned.removed).toBe(4);
    expect(await f.blobs()).toEqual([migrated.files['untracked.ts']]);
    // Changes after the migration still compare with the original bytes.
    await writeFile(path.join(f.project, 'crlf.ts'), 'alpha\r\ngamma\r\n');
    const next = await store.scanExternal(f.project);
    expect((await store.preview({ project: f.project, revision: next.revision, file: 'crlf.ts' })).before).toBe('alpha\r\nbeta\r\n');
  });

  it('reads many objects with one Git process and reports missing ones without inventing bytes', async () => {
    const f = await fixture();
    await writeFile(path.join(f.folder, 'empty'), '');
    const oid = (await f.git('rev-parse', 'HEAD:lf.ts')).stdout.trim(), empty = (await f.git('hash-object', '-w', path.join(f.folder, 'empty'))).stdout.trim();
    const parts = new Map<number, Buffer[]>(), found: [number, boolean][] = [];
    await readGitRefs(f.project, [oid, '1'.repeat(40), `${oid}:crlf`, empty], async (index, chunk) => { parts.set(index, [...parts.get(index) ?? [], chunk]); }, async (index, ok) => { found.push([index, ok]); });
    expect(found).toEqual([[0, true], [1, false], [2, true], [3, true]]);
    expect(Buffer.concat(parts.get(0)!).toString()).toBe('one\ntwo\n');
    expect(Buffer.concat(parts.get(2)!).toString()).toBe('one\r\ntwo\r\n');
    expect(parts.has(1)).toBe(false); expect(parts.has(3)).toBe(false);
  });

  it('keeps tracking when Git lost an object, leaving only that file out of review', async () => {
    const f = await fixture(), store = new ReviewStore(path.join(f.root, 'reviews'));
    await store.initializeExternalTracking(f.project);
    // Simulate history rewriting plus garbage collection removing the committed blob.
    const oid = (await f.git('rev-parse', 'HEAD:crlf.ts')).stdout.trim();
    await rm(path.join(f.project, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), { force: true });
    await writeFile(path.join(f.project, 'crlf.ts'), 'alpha\r\nchanged\r\n');
    await writeFile(path.join(f.project, 'lf.ts'), 'one\nthree\n');
    const review = await new ReviewStore(path.join(f.root, 'reviews')).scanExternal(f.project);
    expect(review.files.map(file => file.path)).toEqual(['lf.ts']);
    expect(review.notice).toContain('Git no longer has its earlier content (crlf.ts)');
    expect((await new StorageManager(f.root).inspect()).cleanupBlocked).toBeUndefined();
  });
});
