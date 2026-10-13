import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { marketplaceManifest } from './marketplace-manifest.mjs';
import { releaseInfo } from './release-notes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}.`);
  return args[index + 1];
};
try {
  const source = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const publisher = value('--publisher') || process.env.MARKETPLACE_PUBLISHER || source.publisher;
  const repositoryUrl = value('--repository-url') || process.env.MARKETPLACE_REPOSITORY_URL ||
    (process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : source.repository?.url);
  const preview = args.includes('--preview');
  if (!preview && publisher === 'agent-tandem-local') throw new Error('Set MARKETPLACE_PUBLISHER or pass --publisher with your Marketplace ID. Use --preview for a local validation package.');
  const manifest = marketplaceManifest(source, { publisher, repositoryUrl });
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
  const contentBranch = value('--branch') ||
    (['branch', 'tag'].includes(process.env.GITHUB_REF_TYPE) ? process.env.GITHUB_REF_NAME : undefined) || 'main';
  if (tag && tag !== `v${manifest.version}`) throw new Error(`Tag ${tag} does not match package version v${manifest.version}.`);
  const release = tag ? await releaseInfo({ cwd: root, tag, version: manifest.version, repositoryUrl }) : undefined;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Build failed (${code}).`)));
  });
  const artifacts = path.join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const stage = await mkdtemp(path.join(artifacts, 'marketplace-stage-'));
  for (const file of ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'LICENSE.txt', '.vscodeignore', 'media', 'docs']) {
    await cp(path.join(root, file), path.join(stage, file), { recursive: true });
  }
  // Only ship runtime bundles and their notices, never test bundles or source maps.
  await mkdir(path.join(stage, 'dist'));
  for (const file of ['extension.js', 'webview.js', 'review-webview.js', 'image-diff.js', 'review-webview.css', 'review-editor-worker.js', 'monaco-LICENSE.txt', 'monaco-ThirdPartyNotices.txt', 'settings.js', 'claude-history.mjs', 'claude-sdk-LICENSE.md', 'diff-LICENSE.txt', 'ignore-LICENSE.txt', 'jsonc-parser-LICENSE.md', 'codicons-LICENSE.txt', 'marked-LICENSE.md', 'dompurify-LICENSE.txt']) {
    await cp(path.join(root, 'dist', file), path.join(stage, 'dist', file));
  }
  if (release) {
    await writeFile(path.join(artifacts, 'release-notes.md'), release.notes);
    await writeFile(path.join(stage, 'CHANGELOG.md'), `${release.notes}\n---\n\n${await readFile(path.join(root, 'CHANGELOG.md'), 'utf8')}`);
    await writeFile(path.join(stage, 'dist/release.json'), `${JSON.stringify({ tag: release.tag, commit: release.commit, previousTag: release.previousTag }, null, 2)}\n`);
  }
  await writeFile(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const packagePath = path.join(artifacts, `${manifest.name}-${manifest.version}${preview ? '-preview' : ''}.vsix`);
  const { createVSIX } = createRequire(import.meta.url)('@vscode/vsce');
  await createVSIX({ cwd: stage, packagePath, dependencies: false, allowMissingRepository: !repositoryUrl,
    ...(repositoryUrl ? {} : { rewriteRelativeLinks: false }), githubBranch: contentBranch });
  const bytes = await readFile(packagePath);
  await writeFile(`${packagePath}.sha256`, `${createHash('sha256').update(bytes).digest('hex')}  ${path.basename(packagePath)}\n`);
  await writeFile(path.join(artifacts, 'marketplace-build.json'), `${JSON.stringify({ publisher, version: manifest.version, preview, packagePath, stage, repositoryUrl: repositoryUrl ?? null,
    ...(release ? { release: { tag: release.tag, commit: release.commit, previousTag: release.previousTag } } : {}) }, null, 2)}\n`);
  if (!repositoryUrl) console.warn('No repository URL configured. Marketplace images/links need a public repository; pass --repository-url when preparing your upload.');
  console.log(`MARKETPLACE_VSIX ${packagePath}`);
} catch (error) {
  console.error(`[AgentTandem package] ${error.message}`);
  process.exitCode = 1;
}
