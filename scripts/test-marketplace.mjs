import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const report = JSON.parse(await readFile('artifacts/marketplace-build.json', 'utf8'));
const manifest = JSON.parse(await readFile(path.join(report.stage, 'package.json'), 'utf8'));
if (manifest.enabledApiProposals || manifest.enableProposedApi || manifest.contributes.menus['editor/content'] || manifest.contributes.menus['multiDiffEditor/content']) {
  throw new Error('Marketplace staging still contains proposed API contributions.');
}
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/test-extension.mjs'], {
    cwd: process.cwd(), stdio: 'inherit', windowsHide: true,
    env: { ...process.env, AGENT_DOCK_EXTENSION_PATH: report.stage },
  });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Marketplace host tests failed (${code}).`)));
});
