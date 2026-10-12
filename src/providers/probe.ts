import { spawn, execFile } from 'node:child_process';
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProviderStatus } from '../core/types';

const execute = promisify(execFile);
async function exists(file: string) { try { await access(file); return true; } catch { return false; } }
async function npmCodex(folder: string): Promise<string | undefined> {
  const shim = ['codex.ps1', 'codex.cmd', 'codex'].map(file => path.join(folder, file));
  const launcher = (await Promise.all(shim.map(async file => await exists(file) ? file : undefined))).find(Boolean);
  if (!launcher) return;
  const text = await readFile(launcher, 'utf8');
  if (!/node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js/.test(text)) throw new Error(`Cannot resolve the Codex launcher at ${launcher}. Choose its native executable in Diagnostics.`);
  const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const packageArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  // Resolve the current NVM/package-manager link on each discovery, just as
  // Node does when starting the launcher. Its target can change after an update.
  const packagePath = path.join(folder, 'node_modules/@openai/codex');
  const packageRoot = await realpath(packagePath).catch(() => packagePath);
  const locations: string[] = [];
  const nativeLocations = (root: string) => ['bin', 'codex'].map(directory =>
    path.join(root, `vendor/${architecture}-pc-windows-msvc`, directory, 'codex.exe'));
  try {
    // Use the same Node resolution as the npm CLI, including hoisted packages.
    const entrypoint = path.join(packageRoot, 'bin/codex.js');
    const require = createRequire(await realpath(entrypoint).catch(() => entrypoint));
    const platformPackage = require.resolve(`@openai/codex-win32-${packageArchitecture}/package.json`);
    locations.push(...nativeLocations(path.dirname(platformPackage)));
  } catch { /* Older npm releases keep their native executable in vendor/. */ }
  locations.push(...nativeLocations(packageRoot));
  for (const file of locations) if (await exists(file)) return file;
  throw new Error(`The Codex CLI at ${launcher} is missing its native executable. Repair that installation or choose another CLI in Manage CLIs.`);
}
export interface CLIInfo { executable: string; version: string }
export async function cliInfo(name: 'codex' | 'claude', configured = '', signal?: AbortSignal): Promise<CLIInfo> {
  const executable = await findExecutable(name, configured);
  signal?.throwIfAborted();
  return { executable, version: (await execute(executable, ['--version'], { timeout: 10_000, windowsHide: true, signal })).stdout.trim() };
}
export async function findExecutable(name: 'codex' | 'claude', configured = ''): Promise<string> {
  if (configured) {
    if (!path.isAbsolute(configured) || (process.platform === 'win32' && path.extname(configured).toLowerCase() !== '.exe')) throw new Error('Configure an absolute path to a native executable (.exe on Windows).');
    if (!(await exists(configured))) throw new Error(`${name} executable was not found.`);
    return configured;
  }
  const folders = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (name === 'claude' && process.env.USERPROFILE) folders.push(path.join(process.env.USERPROFILE, '.local', 'bin'));
  for (const folder of folders) {
    // Honor the terminal's PATH order. Never replace its npm CLI with a
    // different binary belonging to the desktop app or editor extension.
    if (name === 'codex' && process.platform === 'win32') {
      const npm = await npmCodex(folder);
      if (npm) return npm;
    }
    const native = path.join(folder, process.platform === 'win32' ? `${name}.exe` : name);
    if (await exists(native)) return native;
  }
  throw new Error(`${name} was not found. Install it or configure its executable path.`);
}

/** Read only the immediate version folders of a known installation root. */
async function versionedExecutables(root: string, relative: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = entries.filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name, relative));
  return (await Promise.all(candidates.map(async file => await exists(file) ? file : undefined))).filter((file): file is string => !!file);
}

/** Choices are explicit; alternate installations never affect terminal detection. */
export async function installedCLIExecutables(name: 'codex' | 'claude'): Promise<string[]> {
  const files = new Set<string>();
  try { files.add(await findExecutable(name)); } catch { /* A manual choice can repair discovery. */ }
  for (const folder of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (name === 'codex' && process.platform === 'win32') {
      try { const npm = await npmCodex(folder); if (npm) files.add(npm); } catch { /* Other installed CLIs remain manageable. */ }
    }
    const native = path.join(folder, process.platform === 'win32' ? `${name}.exe` : name);
    if (await exists(native)) files.add(native);
  }
  if (process.platform === 'win32' && process.env.USERPROFILE) {
    const local = path.join(process.env.USERPROFILE, '.local/bin', `${name}.exe`);
    if (await exists(local)) files.add(local);
    if (name === 'codex') {
      if (process.env.LOCALAPPDATA) {
        for (const root of ['Programs/OpenAI/Codex/bin', 'OpenAI/Codex/bin']) {
          const desktopRoot = path.join(process.env.LOCALAPPDATA, root);
          const desktop = path.join(desktopRoot, 'codex.exe');
          if (await exists(desktop)) files.add(desktop);
          for (const file of await versionedExecutables(desktopRoot, 'codex.exe')) files.add(file);
        }
      }
      const editorRoot = path.join(process.env.USERPROFILE, '.vscode/extensions');
      const extensions = await readdir(editorRoot).catch(() => []);
      for (const extension of extensions.filter(entry => entry.startsWith('openai.chatgpt-'))) {
        const native = path.join(editorRoot, extension, 'bin', process.arch === 'arm64' ? 'windows-aarch64' : 'windows-x86_64', 'codex.exe');
        if (await exists(native)) files.add(native);
      }
    }
  }
  if (name === 'codex' && process.platform === 'win32') {
    const home = process.env.CODEX_HOME || (process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.codex'));
    if (home) {
      const daemon = path.join(home, 'packages/app-server-daemon');
      for (const file of await versionedExecutables(path.join(daemon, 'releases'), 'bin/codex.exe')) files.add(file);
      const current = path.join(daemon, 'current/bin/codex.exe');
      if (await exists(current)) files.add(current);
    }
  }
  // A current junction or an npm prefix alias can point to the same binary.
  const unique = new Map<string, string>();
  for (const file of files) {
    const resolved = await realpath(file).catch(() => path.resolve(file));
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!unique.has(key)) unique.set(key, file);
  }
  return [...unique.values()];
}

export async function installedCLIs(name: 'codex' | 'claude'): Promise<CLIInfo[]> {
  const files = await installedCLIExecutables(name);
  const results = await Promise.allSettled(files.map(file => cliInfo(name, file)));
  return results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
}

/** Read-only integration spike: no thread/turn or inference is started. */
export async function probeCodex(configured = ''): Promise<ProviderStatus> {
  const { executable, version } = await cliInfo('codex', configured);
  const child = spawn(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  // Drain stderr without storing tokens, environment values, or account data.
  child.stderr.on('data', () => undefined);
  let nextId = 0;
  let failure: Error | undefined;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const fail = (error: Error) => {
    failure = error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  child.on('error', () => fail(new Error('Could not start Codex app-server.')));
  child.on('exit', () => fail(new Error('Codex app-server exited before completing the check.')));
  child.stdin.on('error', () => fail(new Error('Codex app-server input closed.')));
  lines.on('line', line => {
    let message: { id?: number; result?: unknown; error?: unknown; method?: string };
    try { message = JSON.parse(line); } catch { fail(new Error('Codex returned an invalid protocol message.')); return; }
    const request = message.id !== undefined ? pending.get(message.id) : undefined;
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id!);
    if (message.error) request.reject(new Error('Codex rejected a protocol request.'));
    else request.resolve(message.result);
  });
  const call = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await call('initialize', { clientInfo: { name: 'agent_tandem', title: 'AgentTandem', version: '0.1.0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const models = await call('model/list', {}) as { data?: unknown[] };
    return { provider: 'Codex', available: true, executable, version, protocol: 'stdio JSON-RPC',
      detail: `App-server handshake and model/list succeeded (${Array.isArray(models.data) ? models.data.length : 0} catalog entries). No inference or file writes were requested.` };
  } finally {
    lines.close(); fail(new Error('Check finished.'));
    const closed = new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once('close', () => resolve());
    });
    child.stdin.end(); child.kill();
    await Promise.race([closed, new Promise<void>(resolve => { const timer = setTimeout(resolve, 2000); timer.unref(); })]);
  }
}

export async function probeClaude(configured = ''): Promise<ProviderStatus> {
  const { executable, version } = await cliInfo('claude', configured);
  return { provider: 'Claude', available: true, executable, version,
    detail: 'CLI is available. Chat uses your Claude Code sign-in or configured API credentials. This check does not run inference.' };
}

export async function probeProviders(codex = '', claude = ''): Promise<ProviderStatus[]> {
  const results = await Promise.allSettled([probeCodex(codex), probeClaude(claude)]);
  return results.map((result, index) => result.status === 'fulfilled' ? result.value : {
    provider: index === 0 ? 'Codex' : 'Claude', available: false,
    detail: result.reason instanceof Error ? result.reason.message : 'Provider check failed.',
  });
}
