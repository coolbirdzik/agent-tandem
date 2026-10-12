import { mkdtemp, mkdir, writeFile, rm, unlink, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findExecutable, installedCLIExecutables } from '../src/providers/probe';

const temporary: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(temporary.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
describe.skipIf(process.platform !== 'win32')('Windows provider discovery', () => {
  async function executables() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-dock-provider-')); temporary.push(root);
    const wrapperFolder = path.join(root, 'npm'), nativeFolder = path.join(root, 'native');
    const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const wrapper = path.join(wrapperFolder, `node_modules/@openai/codex/vendor/${architecture}-pc-windows-msvc/codex/codex.exe`);
    const native = path.join(nativeFolder, 'codex.exe');
    await mkdir(path.dirname(wrapper), { recursive: true }); await mkdir(nativeFolder);
    await writeFile(wrapper, ''); await writeFile(native, '');
    await writeFile(path.join(wrapperFolder, 'codex.cmd'), 'node "%~dp0/node_modules/@openai/codex/bin/codex.js" %*');
    vi.stubEnv('PATH', [wrapperFolder, nativeFolder].join(path.delimiter));
    return { native, wrapper, wrapperFolder };
  }
  it('uses the terminal npm CLI earlier on PATH instead of a different desktop/editor binary', async () => {
    const files = await executables(); expect(await findExecutable('codex')).toBe(files.wrapper);
  });
  it('resolves a standalone npm CLI to its own native executable', async () => {
    const files = await executables(); vi.stubEnv('PATH', files.wrapperFolder);
    expect(await findExecutable('codex')).toBe(files.wrapper);
  });
  it('honors an explicit executable even when a native CLI is installed', async () => {
    const files = await executables(); expect(await findExecutable('codex', files.wrapper)).toBe(files.wrapper);
  });
  it('uses the first native CLI if it precedes the npm installation', async () => {
    const files = await executables(); vi.stubEnv('PATH', [path.dirname(files.native), files.wrapperFolder].join(path.delimiter));
    expect(await findExecutable('codex')).toBe(files.native);
  });
  it('ignores orphaned package folders which do not expose a terminal launcher', async () => {
    const files = await executables(); await unlink(path.join(files.wrapperFolder, 'codex.cmd'));
    expect(await findExecutable('codex')).toBe(files.native);
  });
  it('reports an unrecognized terminal wrapper instead of silently using another CLI', async () => {
    const files = await executables(); await writeFile(path.join(files.wrapperFolder, 'codex.ps1'), '& custom-codex');
    await expect(findExecutable('codex')).rejects.toThrow('Cannot resolve');
  });
  it('resolves hoisted npm platform packages using the launcher package context', async () => {
    const files = await executables();
    const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64', packageArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64';
    const root = path.join(files.wrapperFolder, `node_modules/@openai/codex-win32-${packageArchitecture}`);
    await mkdir(path.join(root, `vendor/${architecture}-pc-windows-msvc/codex`), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{}');
    const native = path.join(root, `vendor/${architecture}-pc-windows-msvc/codex/codex.exe`); await writeFile(native, '');
    expect(await findExecutable('codex')).toBe(native);
  });
  it.each(['hoisted', 'nested', 'bundled'])('resolves the current bin layout in a %s npm installation', async layout => {
    const files = await executables();
    const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64', packageArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64';
    const packageRoot = path.join(files.wrapperFolder, 'node_modules/@openai/codex');
    const root = layout === 'bundled' ? packageRoot : path.join(
      layout === 'nested' ? packageRoot : files.wrapperFolder,
      `node_modules/@openai/codex-win32-${packageArchitecture}`);
    await mkdir(root, { recursive: true });
    if (layout !== 'bundled') await writeFile(path.join(root, 'package.json'), '{}');
    const native = path.join(root, `vendor/${architecture}-pc-windows-msvc/bin/codex.exe`);
    await mkdir(path.dirname(native), { recursive: true }); await writeFile(native, '');
    expect(await findExecutable('codex')).toBe(native);
    expect(await installedCLIExecutables('codex')).toContain(native);
  });
  it('reports a genuinely missing npm binary and detects it after repair without switching installations', async () => {
    const files = await executables(); await unlink(files.wrapper);
    await expect(findExecutable('codex')).rejects.toThrow('missing its native executable');
    await writeFile(files.wrapper, '');
    expect(await findExecutable('codex')).toBe(files.wrapper);
  });
  it('follows a changed NVM prefix junction on the next discovery', async () => {
    const files = await executables();
    const prefix = path.join(path.dirname(files.wrapperFolder), 'current');
    await symlink(files.wrapperFolder, prefix, 'junction'); vi.stubEnv('PATH', prefix);
    expect(await findExecutable('codex')).toBe(files.wrapper);
    const next = path.join(path.dirname(files.wrapperFolder), 'next');
    const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const native = path.join(next, `node_modules/@openai/codex/vendor/${architecture}-pc-windows-msvc/bin/codex.exe`);
    await mkdir(path.dirname(native), { recursive: true }); await writeFile(native, '');
    await writeFile(path.join(next, 'codex.cmd'), 'node "%~dp0/node_modules/@openai/codex/bin/codex.js" %*');
    await rm(prefix); await symlink(next, prefix, 'junction');
    expect(await findExecutable('codex')).toBe(native);
  });
  async function desktopFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-dock-desktop-')); temporary.push(root);
    vi.stubEnv('PATH', ''); vi.stubEnv('USERPROFILE', path.join(root, 'user'));
    vi.stubEnv('LOCALAPPDATA', path.join(root, 'local')); vi.stubEnv('CODEX_HOME', '');
    const binary = async (relative: string) => {
      const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, ''); return file;
    };
    return { root, binary };
  }
  it('scans both classic desktop and versioned desktop/daemon installations without changing terminal selection', async () => {
    const f = await desktopFixture();
    const files = await Promise.all([
      f.binary('local/Programs/OpenAI/Codex/bin/codex.exe'),
      f.binary('local/OpenAI/Codex/bin/old-version/codex.exe'),
      f.binary('local/OpenAI/Codex/bin/new-version/codex.exe'),
      f.binary('user/.codex/packages/app-server-daemon/releases/0.161.0-x86_64-pc-windows-msvc/bin/codex.exe'),
      f.binary('user/.vscode/extensions/openai.chatgpt-new/bin/windows-' + (process.arch === 'arm64' ? 'aarch64' : 'x86_64') + '/codex.exe'),
    ]);
    await f.binary('local/OpenAI/Codex/bin/unrelated/nested/codex.exe');
    expect((await installedCLIExecutables('codex')).sort()).toEqual(files.sort());
    await expect(findExecutable('codex')).rejects.toThrow('was not found');
    expect(await installedCLIExecutables('claude')).toEqual([]);
  });
  it('finds a newly installed desktop version on the next scan', async () => {
    const f = await desktopFixture();
    expect(await installedCLIExecutables('codex')).toEqual([]);
    const file = await f.binary('local/OpenAI/Codex/bin/new-version/codex.exe');
    expect(await installedCLIExecutables('codex')).toEqual([file]);
  });
  it('honors CODEX_HOME and avoids duplicate entries for the daemon current junction', async () => {
    const f = await desktopFixture(); vi.stubEnv('CODEX_HOME', path.join(f.root, 'custom-home'));
    const file = await f.binary('custom-home/packages/app-server-daemon/releases/new-version/bin/codex.exe');
    await f.binary('user/.codex/packages/app-server-daemon/releases/ignored-version/bin/codex.exe');
    await symlink(path.dirname(path.dirname(file)), path.join(f.root, 'custom-home/packages/app-server-daemon/current'), 'junction');
    expect(await installedCLIExecutables('codex')).toEqual([file]);
  });
});
