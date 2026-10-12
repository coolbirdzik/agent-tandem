import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseTagPattern } from './release-notes.mjs';

const execute = promisify(execFile);
const gitAt = cwd => async (...args) => (await execute('git', args, { cwd, windowsHide: true })).stdout.trim();

async function checkWorkspace(cwd) {
  const git = gitAt(cwd);
  if (await git('branch', '--show-current') !== 'main') throw new Error('Switch to main before bumping or releasing.');
  if (await git('status', '--porcelain')) throw new Error('Commit or stash your changes before bumping or releasing.');
  return git;
}

export async function bumpVersion({ cwd, level, npmCli = process.env.npm_execpath }) {
  if (!['patch', 'minor', 'major'].includes(level)) throw new Error('Choose patch, minor or major.');
  await checkWorkspace(cwd);
  if (!npmCli) throw new Error('Run npm run bump:patch, bump:minor or bump:major.');
  const result = await execute(process.execPath, [npmCli, 'version', level, '--tag-version-prefix=v', '--git-tag-version=true', '-m', 'chore: bump version to %s'], { cwd, windowsHide: true });
  return result.stdout.trim();
}

export async function pushRelease({ cwd }) {
  const git = await checkWorkspace(cwd);
  const manifest = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(cwd, 'package-lock.json'), 'utf8'));
  const tag = `v${manifest.version}`;
  if (!releaseTagPattern.test(tag)) throw new Error('The package version must use X.Y.Z.');
  if (lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version) throw new Error('package.json and package-lock.json versions must match.');
  let taggedCommit;
  try { taggedCommit = await git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`); }
  catch { throw new Error(`Missing ${tag}. Run npm run bump:patch, bump:minor or bump:major first.`); }
  if (taggedCommit !== await git('rev-parse', 'HEAD')) throw new Error(`${tag} must point to HEAD. Do not add commits between bump and release.`);
  await git('fetch', '--no-tags', 'origin', 'main');
  try { await git('merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'); }
  catch { throw new Error('Local main is behind or diverged from origin/main. Synchronize main before releasing.'); }
  // Push only this version tag, with main, in one transaction. Never force or push unrelated tags.
  await git('push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}:refs/tags/${tag}`);
  return tag;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, level] = process.argv.slice(2);
    if (command === 'bump') console.log(`${await bumpVersion({ cwd: process.cwd(), level })}\nVersion commit and tag created. Run npm run release to push them.`);
    else if (command === 'push') console.log(`Pushed main and ${await pushRelease({ cwd: process.cwd() })}. GitHub Actions will test, build the VSIX and create the release.`);
    else throw new Error('Use npm run bump:patch, bump:minor, bump:major or release.');
  } catch (error) {
    console.error(error.stderr?.trim() || error.message);
    process.exitCode = 1;
  }
}
