import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIStore } from '../src/core/cli-store';
import { ManagedCLIResolver } from '../src/providers/managed-cli';

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('automatic Codex selection', () => {
  let root: string, store: CLIStore, resolver: ManagedCLIResolver;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-auto-cli-'));
    vi.stubEnv('HOME', root); vi.stubEnv('PATH', '');
    store = new CLIStore(path.join(root, 'registry')); await store.initialize([]);
    resolver = new ManagedCLIResolver(store);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  async function executable(file: string, version = 'codex-cli 1.0.0') {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `#!/bin/sh\necho call >> '${root}/calls'\necho '${version}'\n`, { mode: 0o755 });
    return file;
  }
  async function calls() { return (await readFile(path.join(root, 'calls'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length; }
  async function extension(version: string, base = path.join(root, '.vscode', 'extensions')) {
    const installation = path.join(base, `openai.chatgpt-${version}`);
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const platform = process.platform === 'darwin' ? 'macos' : 'linux';
    const file = await executable(path.join(installation, 'bin', `${platform}-${arch}`, 'codex'));
    await writeFile(path.join(installation, 'package.json'), JSON.stringify({ version }));
    return { installation, file };
  }
  async function register(file: string) {
    const registry = await store.read();
    const updated = await store.add(registry.revision, { provider: 'Codex', name: 'Pinned', executable: file, version: 'codex-cli 1.0.0' });
    return updated.entries.find(row => row.executable === file)!;
  }
  it('uses a transient result without writing the managed registry', async () => {
    await extension('1.9.0'); const newest = await extension('1.10.0');
    const before = await store.read(), result = await resolver.resolve('Codex', {});
    expect(result.source).toBe('extension'); expect(result.cli.executable).toBe(newest.file);
    expect(result.entry).toBeUndefined(); expect(await store.read()).toEqual(before);
  });
  it('reuses the validated result across repeated account polls without rediscovery or --version', async () => {
    const old = await extension('1.9.0');
    await resolver.resolve('Codex', {}); expect(await calls()).toBe(1);
    await extension('1.10.0');
    for (let i = 0; i < 5; i++) expect((await resolver.resolve('Codex', {})).cli.executable).toBe(old.file);
    expect(await calls()).toBe(1);
    resolver.invalidate();
    expect((await resolver.resolve('Codex', {})).cli.executable).not.toBe(old.file);
    expect(await calls()).toBe(2);
  });
  it('recovers automatically when a cached executable disappears', async () => {
    const old = await extension('1.9.0'); await resolver.resolve('Codex', {});
    await rm(old.installation, { recursive: true }); const updated = await extension('1.10.0');
    expect((await resolver.resolve('Codex', {})).cli.executable).toBe(updated.file);
    expect((await store.read()).entries).toHaveLength(0);
    expect((await new ManagedCLIResolver(store).resolve('Codex', {})).cli.executable).toBe(updated.file);
  });
  it('keeps the cache across unrelated Claude failures and account/network errors', async () => {
    await extension('1.0.0'); await resolver.resolve('Codex', {});
    resolver.invalidate('Claude');
    resolver.invalidateOnFailure('Codex', new Error('Codex could not read this account data.'));
    resolver.invalidateOnFailure('Codex', new Error('Account refresh timed out.'));
    await resolver.resolve('Codex', {}); expect(await calls()).toBe(1);
    resolver.invalidateOnFailure('Codex', new Error('Could not start Codex account refresh.'));
    await resolver.resolve('Codex', {}); expect(await calls()).toBe(2);
  });
  it('revalidates a binary replaced in place', async () => {
    const installed = await extension('1.9.0'); await resolver.resolve('Codex', {});
    await executable(installed.file, 'codex-cli 2.0.0-updated');
    expect((await resolver.resolve('Codex', {})).cli.version).toBe('codex-cli 2.0.0-updated');
    expect(await calls()).toBe(2);
  });
  it('prefers the current host extension over a newer sibling or another editor installation', async () => {
    const current = await extension('1.9.0', path.join(root, 'remote', 'extensions'));
    await extension('1.10.0', path.dirname(current.installation)); await extension('99.0.0');
    expect((await resolver.resolve('Codex', { codexExtensionPaths: [current.installation] })).cli.executable).toBe(current.file);
    expect(await calls()).toBe(1);
  });
  it('scans only current-host siblings when the reported installation disappears', async () => {
    const old = await extension('1.9.0', path.join(root, 'remote', 'extensions'));
    const updated = await extension('1.10.0', path.dirname(old.installation)); await extension('99.0.0');
    await rm(old.installation, { recursive: true });
    expect((await resolver.resolve('Codex', { codexExtensionPaths: [old.installation] })).cli.executable).toBe(updated.file);
  });
  it.each([
    ['1.9.0', '1.10.0'],
    ['1.10.0-beta.9', '1.10.0-beta.10'],
    ['1.10.0-beta.10', '1.10.0'],
    ['1.10.0', '1.11.0-alpha.17.2'],
  ])('orders fallback extension versions using semver: %s before %s', async (older, newer) => {
    await extension(older); const newest = await extension(newer);
    expect((await resolver.resolve('Codex', {})).cli.executable).toBe(newest.file);
  });
  it('uses the manifest version even when the installation folder has an arbitrary name', async () => {
    const installed = await extension('1.0.0'); await extension('2.0.0');
    await writeFile(path.join(installed.installation, 'package.json'), JSON.stringify({ version: '3.0.0' }));
    expect((await resolver.resolve('Codex', {})).cli.executable).toBe(installed.file);
  });
  it('prefers and validates terminal Codex, and notices PATH changes', async () => {
    await extension('9.0.0'); const file = await executable(path.join(root, 'terminal', 'codex'));
    vi.stubEnv('PATH', path.dirname(file));
    const result = await resolver.resolve('Codex', {});
    expect(result.cli.executable).toBe(file); expect(result.source).toBe('automatic-path');
    expect(result.cli.version).toBe('codex-cli 1.0.0');
    await resolver.resolve('Codex', {}); expect(await calls()).toBe(1);
    vi.stubEnv('PATH', ''); expect((await resolver.resolve('Codex', {})).source).toBe('extension');
    expect((await store.read()).entries).toHaveLength(0);
  });
  it('falls back when PATH contains an invalid or broken Codex', async () => {
    const installed = await extension('1.0.0');
    const file = await executable(path.join(root, 'terminal', 'codex'), 'Some other program');
    vi.stubEnv('PATH', path.dirname(file));
    expect((await resolver.resolve('Codex', {})).cli.executable).toBe(installed.file);
    await writeFile(file, '#!/bin/sh\nexit 1\n'); resolver.invalidate();
    expect((await resolver.resolve('Codex', {})).cli.executable).toBe(installed.file);
  });
  it('keeps explicit terminal mode strict', async () => {
    await extension('1.10.0');
    await expect(resolver.resolve('Codex', { terminal: true })).rejects.toThrow('codex was not found');
  });
  it('honors disabling a terminal CLI even after it has been cached', async () => {
    await extension('1.10.0'); const file = await executable(path.join(root, 'terminal', 'codex'));
    const entry = await register(file); vi.stubEnv('PATH', path.dirname(file));
    await resolver.resolve('Codex', {});
    const registry = await store.read(); await store.toggle(registry.revision, entry.id, false);
    await expect(resolver.resolve('Codex', {})).rejects.toThrow('disabled');
  });
  it('coalesces concurrent discovery without writing managed records', async () => {
    await extension('1.10.0');
    const results = await Promise.all([resolver.resolve('Codex', {}), resolver.resolve('Codex', {})]);
    expect(results[0]!.cli).toEqual(results[1]!.cli); expect(await calls()).toBe(1);
    expect((await store.read()).entries).toHaveLength(0);
  });
  it('preserves a pinned machine default and reports its missing executable', async () => {
    const old = await extension('1.9.0'), selected = await register(old.file);
    const registry = await store.read(); await store.setDefault(registry.revision, 'Codex', selected.id);
    await extension('1.10.0');
    expect((await resolver.resolve('Codex', {})).entry?.id).toBe(selected.id);
    await rm(old.installation, { recursive: true });
    await expect(resolver.resolve('Codex', {})).rejects.toThrow('executable was not found');
  });
  it('honors project IDs and never substitutes a missing pinned or removed default', async () => {
    const old = await extension('1.9.0'), selected = await register(old.file); await extension('1.10.0');
    expect((await resolver.resolve('Codex', { id: selected.id, executable: '/stale-setting' })).entry?.id).toBe(selected.id);
    await rm(old.installation, { recursive: true });
    await expect(resolver.resolve('Codex', { id: selected.id })).rejects.toThrow('executable was not found');
    await expect(resolver.resolve('Codex', { executable: path.join(root, 'missing') })).rejects.toThrow('executable was not found');
    let registry = await store.read(); registry = await store.setDefault(registry.revision, 'Codex', selected.id);
    await store.remove(registry.revision, selected.id);
    await expect(resolver.resolve('Codex', {})).rejects.toThrow('default Codex CLI was removed');
    await expect(resolver.resolve('Codex', { id: selected.id })).rejects.toThrow('selected Codex CLI was removed');
  });
  it.each([false, true])('blocks disabled extension execution before probing (current host: %s)', async currentHost => {
    const latest = await extension('1.10.0'); await extension('1.9.0'); const registry = await store.read();
    await store.scan(registry.revision, [{ provider: 'Codex', name: 'Scanned', executable: latest.file, version: '1.0' }]);
    await expect(resolver.resolve('Codex', { codexExtensionPaths: currentHost ? [latest.installation] : [] })).rejects.toThrow('disabled');
    expect(await calls()).toBe(0);
    expect((await store.read()).entries[0]!.enabled).toBe(false);
  });
  it('tries an older usable bundle when the newest fallback binary fails', async () => {
    const old = await extension('1.9.0'), newest = await extension('1.10.0');
    await writeFile(newest.file, '#!/bin/sh\nexit 1\n');
    expect((await resolver.resolve('Codex', {})).cli.executable).toBe(old.file);
  });
  it('reports missing Codex and leaves Claude discovery unchanged', async () => {
    await expect(resolver.resolve('Codex', {})).rejects.toThrow('No usable Codex CLI');
    await extension('1.10.0');
    await expect(resolver.resolve('Claude', {})).rejects.toThrow('claude was not found');
  });
  it('does not resolve or mutate anything when cancelled before the operation', async () => {
    await extension('1.10.0'); const abort = new AbortController(); abort.abort();
    await expect(resolver.resolve('Codex', {}, abort.signal)).rejects.toThrow();
    expect(await calls()).toBe(0); expect((await store.read()).entries).toHaveLength(0);
  });
});
