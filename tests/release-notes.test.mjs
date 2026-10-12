import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseInfo } from '../scripts/release-notes.mjs';

const execute = promisify(execFile), roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agenttandem-release-'))); roots.push(cwd);
  const git = async (...args) => (await execute('git', args, { cwd, windowsHide: true })).stdout.trim();
  await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'Release test'); await git('config', 'user.email', 'release@example.test');
  let sequence = 0;
  const commit = async message => {
    await writeFile(path.join(cwd, 'fixture.txt'), String(sequence++)); await git('add', 'fixture.txt'); await git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const info = tag => releaseInfo({ cwd, tag, version: tag.replace(/^v/, ''), mainRef: 'main', repositoryUrl: 'https://github.com/example/agent-tandem' });
  return { cwd, git, commit, info };
}
describe('Git-history releases', () => {
  it('includes initial history and filters CI/version housekeeping', async () => {
    const f = await fixture(); await f.commit('Add native review'); await f.commit('ci: adjust build'); await f.commit('chore: bump version to 1.0.0');
    await f.git('tag', 'v1.0.0'); const result = await f.info('v1.0.0');
    expect(result.previousTag).toBeNull(); expect(result.notes).toContain('Initial release');
    expect(result.notes).toContain('Add native review'); expect(result.notes).not.toContain('adjust build'); expect(result.notes).not.toContain('bump version');
    expect(result.notes).toContain('agent-tandem-1.0.0.vsix');
  });
  it('uses the preceding reachable tag, ignores an unrelated branch tag and retains commit links', async () => {
    const f = await fixture(); await f.commit('Old feature'); await f.git('tag', 'v1.0.0');
    await f.git('checkout', '-q', '-b', 'feature'); await f.commit('Unreleased feature'); await f.git('tag', 'v9.0.0'); await f.git('checkout', '-q', 'main');
    const current = await f.commit('Fix [history]'); await f.git('tag', '-a', 'v1.1.0', '-m', 'Release 1.1');
    const result = await f.info('v1.1.0'); expect(result.previousTag).toBe('v1.0.0'); expect(result.commit).toBe(current);
    expect(result.notes).toContain('Fix \\[history\\]'); expect(result.notes).toContain(`/commit/${current}`);
    expect(result.notes).not.toContain('Old feature'); expect(result.notes).not.toContain('Unreleased feature');
    expect(result.notes).toContain('/compare/v1.0.0...v1.1.0');
  });
  it('rejects a tag outside main even when its version is valid', async () => {
    const f = await fixture(); await f.commit('Main'); await f.git('checkout', '-q', '-b', 'feature'); await f.commit('Private branch'); await f.git('tag', 'v1.0.0');
    await expect(f.info('v1.0.0')).rejects.toThrow('reachable from main');
  });
  it('rejects a stale checkout, malformed tags and a manifest mismatch', async () => {
    const f = await fixture(); await f.commit('First'); await f.git('tag', 'v1.0.0'); await f.commit('Later');
    await expect(f.info('v1.0.0')).rejects.toThrow('checkout');
    await expect(f.info('v1.0.0-beta')).rejects.toThrow('vX.Y.Z');
    await expect(releaseInfo({ cwd: f.cwd, tag: 'v1.0.0', version: '1.0.1' })).rejects.toThrow('package version');
  });
});
