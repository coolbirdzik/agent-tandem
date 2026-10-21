import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, 'artifacts', `${manifest.name}-${manifest.version}.vsix`);
await mkdir(path.dirname(output), { recursive: true });
// vsce runs vscode:prepublish, which builds the extension before packaging.
const child = spawn(process.execPath, [path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce'),
  'package', '--no-dependencies', '--allow-missing-repository', '--no-rewrite-relative-links', '--skip-license', '--out', output],
{ cwd: root, stdio: 'inherit', windowsHide: true });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
