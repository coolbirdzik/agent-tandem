import { spawn } from 'node:child_process';
import { access, readFile, readdir, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { enableLocalProposals } from './local-proposals.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watching = process.argv.includes('--watch');
async function exists(file) { try { await access(file); return true; } catch { return false; } }

async function findCode() {
  if (process.platform !== 'win32') return { executable: process.env.VSCODE_EXECUTABLE_PATH || 'code', prefix: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } };
  const candidates = [
    process.env.VSCODE_EXECUTABLE_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(folder => path.resolve(folder, '..', 'Code.exe')),
  ].filter(Boolean);
  for (const executable of candidates) {
    if (!await exists(executable)) continue;
    const installRoot = path.dirname(executable);
    let cli = path.join(installRoot, 'resources', 'app', 'out', 'cli.js');
    // Recent VS Code installations store resources under a version directory.
    const launcher = path.join(installRoot, 'bin', 'code.cmd');
    if (await exists(launcher)) {
      const text = await readFile(launcher, 'utf8');
      const relative = text.match(/"%~dp0([^"\r\n]*[\\/]resources[\\/]app[\\/]out[\\/]cli\.js)"/i)?.[1];
      if (relative) {
        const resolved = path.resolve(path.dirname(launcher), relative);
        const inside = path.relative(installRoot, resolved);
        if (!inside.startsWith('..') && !path.isAbsolute(inside)) cli = resolved;
      }
    }
    if (!await exists(cli)) {
      for (const entry of await readdir(installRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(installRoot, entry.name, 'resources', 'app', 'out', 'cli.js');
        if (await exists(candidate)) { cli = candidate; break; }
      }
    }
    if (await exists(cli)) return { executable, prefix: [cli], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: undefined } };
  }
  throw new Error('VS Code was not found. Set VSCODE_EXECUTABLE_PATH to the full path to Code.exe.');
}

function run(executable, args, env = process.env, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, shell: false, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '', stderr = '';
    if (capture) {
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`Command failed (exit ${code}).${stderr ? `\n${stderr.trim()}` : ''}`)));
  });
}

async function main() {
  const code = await findCode();
  console.log(`[AgentDock dev] VS Code: ${code.executable}`);
  async function install() {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const extensionId = `${manifest.publisher}.${manifest.name}`;
    const vsix = path.join(root, 'artifacts', `${manifest.name}-${manifest.version}.vsix`);
    await mkdir(path.dirname(vsix), { recursive: true });
    console.log('[AgentDock dev] Building and packaging…');
    // vsce runs vscode:prepublish, which builds both the extension and webview.
    await run(process.execPath, [path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--no-dependencies', '--allow-missing-repository', '--no-rewrite-relative-links', '--skip-license', '--out', vsix]);
    console.log('[AgentDock dev] Installing into the existing VS Code installation…');
    await run(code.executable, [...code.prefix, '--install-extension', vsix, '--force'], code.env);
    const installed = await run(code.executable, [...code.prefix, '--list-extensions', '--show-versions'], code.env, true);
    const expected = `${extensionId}@${manifest.version}`;
    if (!installed.split(/\r?\n/).some(line => line.trim().toLowerCase() === expected.toLowerCase())) throw new Error(`Could not verify the installed extension: ${expected}`);
    console.log(`[AgentDock dev] Installed ${expected}.`);
    if (manifest.enabledApiProposals?.length) {
      const argv = process.env.VSCODE_PORTABLE
        ? path.join(process.env.VSCODE_PORTABLE, 'argv.json')
        : path.join(os.homedir(), /insiders/i.test(code.executable) ? '.vscode-insiders' : '.vscode', 'argv.json');
      const changed = await enableLocalProposals(argv, extensionId);
      console.log(`[AgentDock dev] Floating change toolbar: ${argv}${changed ? ' (enabled for AgentDock; the original file was backed up)' : ' (enabled)'}.`);
      console.log('[AgentDock dev] When enabling the toolbar for the first time, fully close and reopen VS Code. For later updates, use Developer: Reload Window.');
    } else console.log('[AgentDock dev] In VS Code: Developer: Reload Window → AgentDock: Open Conversations.');
  }
  if (!watching) { await install(); return; }

  let dirty = false, busy = false, timer;
  async function rebuild() {
    dirty = true;
    if (busy) return;
    busy = true;
    try {
      while (dirty) {
        dirty = false;
        try { await install(); } catch (error) { console.error(`[AgentDock dev] ${error.message}\nFix the error and save the file to retry.`); }
      }
    } finally { busy = false; }
  }
  const watchers = [];
  for (const folder of ['src', 'media', 'docs']) watchers.push(watch(path.join(root, folder), { recursive: true }, () => {
    clearTimeout(timer); timer = setTimeout(() => void rebuild(), 500);
  }));
  for (const file of ['package.json', 'README.md', 'CHANGELOG.md', '.vscodeignore', 'tsconfig.json', 'scripts/build.mjs']) watchers.push(watch(path.join(root, file), () => {
    clearTimeout(timer); timer = setTimeout(() => void rebuild(), 500);
  }));
  const stop = () => { clearTimeout(timer); for (const watcher of watchers) watcher.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await rebuild();
  console.log('[AgentDock dev] Watching source files. Save a file to rebuild and reinstall; press Ctrl+C to stop.');
}
main().catch(error => { console.error(`[AgentDock dev] ${error.message}`); process.exitCode = 1; });
