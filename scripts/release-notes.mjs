import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const releaseTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const escapeMarkdown = value => value.replace(/[\\`*_{}\[\]<>]/g, '\\$&');

export async function releaseInfo({ cwd, tag, version, mainRef = 'origin/main', repositoryUrl }) {
  if (!releaseTagPattern.test(tag ?? '')) throw new Error('Release tags must use vX.Y.Z (for example v0.1.1).');
  if (tag !== `v${version}`) throw new Error(`Tag ${tag} does not match package version v${version}.`);
  const git = async (...args) => (await execute('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  if (await git('rev-parse', '--is-shallow-repository') === 'true') throw new Error('Release notes require complete git history; checkout with fetch-depth: 0.');
  const commit = await git('rev-parse', '--verify', `${tag}^{commit}`);
  if (commit !== await git('rev-parse', 'HEAD')) throw new Error('The checkout must point to the release tag.');
  try { await git('merge-base', '--is-ancestor', commit, mainRef); }
  catch { throw new Error(`Release tag ${tag} must point to a commit reachable from ${mainRef}.`); }

  let previousTag;
  try {
    const candidate = await git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*', `${commit}^`);
    if (releaseTagPattern.test(candidate)) previousTag = candidate;
  } catch { /* Initial release has no parent or no earlier version tag. */ }
  if (!previousTag) {
    try {
      previousTag = (await git('tag', '--merged', `${commit}^`, '--sort=-version:refname')).split('\n').find(value => releaseTagPattern.test(value));
    } catch { /* Root commit. */ }
  }
  const range = previousTag ? `${previousTag}..${commit}` : commit;
  const commits = (await git('log', '--reverse', '--no-merges', '--format=%H%x00%s', range)).split('\n').filter(Boolean)
    .map(line => { const [hash, subject] = line.split('\0'); return { hash, subject }; })
    .filter(({ subject }) => !/^(ci(\([^)]*\))?!?:|chore(\([^)]*\))?!?: bump version to )/i.test(subject));
  const base = repositoryUrl?.replace(/\.git\/?$/, '').replace(/\/$/, '');
  const changes = commits.map(({ hash, subject }) => `- ${escapeMarkdown(subject)} (${base ? `[${hash.slice(0, 7)}](${base}/commit/${hash})` : hash.slice(0, 7)})`).join('\n');
  const comparison = base && previousTag ? `\n\n[Full changelog](${base}/compare/${previousTag}...${tag})` : '';
  const notes = `# AgentTandem ${version}\n\n${previousTag ? `Changes from \`${previousTag}\` to \`${tag}\`.` : 'Initial release.'}\n\n## What changed\n\n${changes || '- No user-facing commits in this range.'}${comparison}\n\n## Install\n\nDownload \`agent-tandem-${version}.vsix\` and use **Extensions → … → Install from VSIX…** in VS Code. A SHA-256 checksum is included with the download.\n`;
  return { tag, version, commit, previousTag: previousTag ?? null, notes };
}
