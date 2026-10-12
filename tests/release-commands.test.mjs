import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { bumpVersion, pushRelease } from '../scripts/release.mjs';

const execute = promisify(execFile), roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agenttandem-release-command-'))); roots.push(root);
  const cwd = path.join(root, 'work'), remote = path.join(root, 'remote.git');
  const run = async (at, ...args) => (await execute('git', args, { cwd: at, windowsHide: true })).stdout.trim();
  await run(root, 'init', '-q', '--bare', remote);
  await run(root, 'init', '-q', '-b', 'main', cwd);
  const git = (...args) => run(cwd, ...args);
  await git('config', 'user.name', 'Release test'); await git('config', 'user.email', 'release@example.test');
  await git('config', 'commit.gpgsign', 'false'); await git('config', 'tag.gpgsign', 'false');
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'release-fixture', version: '0.1.0', private: true }));
  await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify({ name: 'release-fixture', version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'release-fixture', version: '0.1.0' } } }));
  await git('add', '.'); await git('commit', '-q', '-m', 'Initial');
  await git('remote', 'add', 'origin', remote); await git('push', '-q', '-u', 'origin', 'main');
  return { cwd, remote, root, git, remoteGit: (...args) => run(remote, ...args), run };
}

describe('Maintainer release commands', () => {
  it.each([['patch', '0.1.1'], ['minor', '0.2.0'], ['major', '1.0.0']])('bumps %s, commits matching versions and creates an annotated tag', async (level, version) => {
    const f = await fixture(); await bumpVersion({ cwd: f.cwd, level });
    const manifest = JSON.parse(await readFile(path.join(f.cwd, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(path.join(f.cwd, 'package-lock.json'), 'utf8'));
    expect(manifest.version).toBe(version); expect(lock.version).toBe(version); expect(lock.packages[''].version).toBe(version);
    expect(await f.git('log', '-1', '--format=%s')).toBe(`chore: bump version to ${version}`);
    expect(await f.git('cat-file', '-t', `v${version}`)).toBe('tag');
    expect(await f.git('rev-parse', `v${version}^{commit}`)).toBe(await f.git('rev-parse', 'HEAD'));
    expect(await f.git('status', '--porcelain')).toBe('');
  });
  it('pushes main and the current tag together, skips other tags and supports retries', async () => {
    const f = await fixture(); await f.git('tag', '-a', 'v9.0.0', '-m', 'Unrelated');
    await bumpVersion({ cwd: f.cwd, level: 'patch' });
    expect(await pushRelease({ cwd: f.cwd })).toBe('v0.1.1');
    expect(await f.remoteGit('rev-parse', 'main')).toBe(await f.git('rev-parse', 'HEAD'));
    expect(await f.remoteGit('rev-parse', 'v0.1.1^{commit}')).toBe(await f.git('rev-parse', 'HEAD'));
    expect(await f.remoteGit('tag', '--list')).toBe('v0.1.1');
    expect(await pushRelease({ cwd: f.cwd })).toBe('v0.1.1');
  });
  it('rejects dirty workspaces and feature branches before bump or push', async () => {
    const f = await fixture(); await writeFile(path.join(f.cwd, 'untracked.txt'), 'Pending change');
    await expect(bumpVersion({ cwd: f.cwd, level: 'patch' })).rejects.toThrow('Commit or stash');
    await expect(pushRelease({ cwd: f.cwd })).rejects.toThrow('Commit or stash');
    await rm(path.join(f.cwd, 'untracked.txt')); await f.git('checkout', '-q', '-b', 'feature');
    await expect(bumpVersion({ cwd: f.cwd, level: 'patch' })).rejects.toThrow('Switch to main');
    await expect(pushRelease({ cwd: f.cwd })).rejects.toThrow('Switch to main');
  });
  it('keeps remote main unchanged when an existing remote tag conflicts', async () => {
    const f = await fixture(), original = await f.remoteGit('rev-parse', 'main');
    await f.remoteGit('tag', 'v0.1.1', 'main');
    await bumpVersion({ cwd: f.cwd, level: 'patch' });
    await expect(pushRelease({ cwd: f.cwd })).rejects.toThrow();
    expect(await f.remoteGit('rev-parse', 'main')).toBe(original);
    expect(await f.remoteGit('rev-parse', 'v0.1.1^{commit}')).toBe(original);
  });
  it('rejects a missing tag and commits added after bump', async () => {
    const f = await fixture(); await expect(pushRelease({ cwd: f.cwd })).rejects.toThrow('Missing v0.1.0');
    await bumpVersion({ cwd: f.cwd, level: 'patch' }); await f.git('commit', '--allow-empty', '-q', '-m', 'Later');
    await expect(pushRelease({ cwd: f.cwd })).rejects.toThrow('must point to HEAD');
    expect(await f.remoteGit('tag', '--list')).toBe('');
  });
  it('rejects a diverged main without publishing its tag', async () => {
    const f = await fixture(), other = path.join(f.root, 'other');
    await f.run(f.root, 'clone', '-q', '-b', 'main', f.remote, other);
    await f.run(other, 'config', 'user.name', 'Other'); await f.run(other, 'config', 'user.email', 'other@example.test');
    await f.run(other, 'config', 'commit.gpgsign', 'false');
    await f.run(other, 'commit', '--allow-empty', '-q', '-m', 'Remote advanced'); await f.run(other, 'push', '-q', 'origin', 'main');
    await bumpVersion({ cwd: f.cwd, level: 'patch' });
    await expect(pushRelease({ cwd: f.cwd })).rejects.toThrow('behind or diverged');
    expect(await f.remoteGit('tag', '--list')).toBe('');
  });
});
