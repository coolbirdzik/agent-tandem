import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { releaseInfo } from './release-notes.mjs';

const source = JSON.parse(await readFile('package.json', 'utf8'));
const info = await releaseInfo({ cwd: process.cwd(), tag: process.env.GITHUB_REF_NAME, version: source.version,
  repositoryUrl: process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : undefined });
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/release-notes.md', info.notes);
await writeFile('artifacts/release-history.json', `${JSON.stringify(info, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `tag=${info.tag}\n`);
console.log(`Release ${info.tag}: ${info.previousTag ?? 'initial history'} → ${info.commit}`);
