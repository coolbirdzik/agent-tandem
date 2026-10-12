import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { CLIStore } from '../src/core/cli-store';
import { allowedCLI, defaultCLI, cliRequest } from '../src/providers/cli-registry';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentdock-cli-registry-'));
  const store = new CLIStore(directory);
  const codex = { provider: 'Codex' as const, name: 'Terminal Codex', executable: path.join(directory, 'codex.exe'), version: 'codex-cli 1.0' };
  const claude = { provider: 'Claude' as const, name: 'Claude native', executable: path.join(directory, 'claude.exe'), version: '1.0 (Claude Code)' };
  const registry = await store.initialize([codex, claude]);
  return { directory, store, codex, claude, registry };
}
describe('managed CLI list', () => {
  it('persists independent provider entries, names, enabled flags and defaults', async () => {
    const f = await fixture(), codexId = f.registry.entries[0]!.id;
    let registry = await f.store.edit(f.registry.revision, codexId, { ...f.codex, name: 'My Codex' });
    registry = await f.store.setDefault(registry.revision, 'Codex', codexId);
    const reopened = await new CLIStore(f.directory).read();
    expect(defaultCLI(reopened, 'Codex')?.name).toBe('My Codex');
    expect(defaultCLI(reopened, 'Claude')).toBeUndefined();
    expect(allowedCLI(reopened, 'Claude', f.claude.executable).enabled).toBe(true);
  });
  it('rejects disabled CLI/default use and never substitutes another enabled installation', async () => {
    const f = await fixture(), id = f.registry.entries[0]!.id;
    let registry = await f.store.setDefault(f.registry.revision, 'Codex', id);
    registry = await f.store.toggle(registry.revision, id, false);
    expect(() => allowedCLI(registry, 'Codex', f.codex.executable)).toThrow('disabled');
    expect(() => defaultCLI(registry, 'Codex')).toThrow('disabled');
    await expect(f.store.setDefault(registry.revision, 'Codex', id)).rejects.toThrow('enabled');
  });
  it('removes only the managed entry, preserves its executable and leaves a removed default blocked', async () => {
    const f = await fixture(), id = f.registry.entries[0]!.id;
    await writeFile(f.codex.executable, 'UNCHANGED');
    let registry = await f.store.setDefault(f.registry.revision, 'Codex', id);
    registry = await f.store.remove(registry.revision, id);
    expect(await readFile(f.codex.executable, 'utf8')).toBe('UNCHANGED');
    expect(() => allowedCLI(registry, 'Codex', f.codex.executable)).toThrow('not in');
    expect(() => defaultCLI(registry, 'Codex')).toThrow('removed');
    registry = await f.store.setDefault(registry.revision, 'Codex', '');
    expect(defaultCLI(registry, 'Codex')).toBeUndefined();
  });
  it('does not re-enable disabled entries on scan and requires enabling newly discovered entries', async () => {
    const f = await fixture(), id = f.registry.entries[0]!.id;
    let registry = await f.store.toggle(f.registry.revision, id, false);
    registry = await f.store.scan(registry.revision, [f.codex, { ...f.codex, name: 'Portable', executable: path.join(f.directory, 'portable.exe') }]);
    expect(registry.entries.filter(entry => entry.provider === 'Codex').map(entry => entry.enabled)).toEqual([false, false]);
    expect((await f.store.initialize([f.codex])).entries.find(entry => entry.id === id)?.enabled).toBe(false);
  });
  it('rejects duplicate paths, wrong provider defaults and stale concurrent writes', async () => {
    const f = await fixture();
    await expect(f.store.add(f.registry.revision, f.codex)).rejects.toThrow('already');
    await expect(f.store.setDefault(f.registry.revision, 'Claude', f.registry.entries[0]!.id)).rejects.toThrow('enabled');
    const results = await Promise.allSettled([f.store.toggle(f.registry.revision, f.registry.entries[0]!.id, false), f.store.remove(f.registry.revision, f.registry.entries[1]!.id)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((await f.store.read()).entries).toHaveLength(2);
  });
  it('refreshes versions and clears repaired errors on scan while preserving names, IDs and choices', async () => {
    const f = await fixture(), id = f.registry.entries[0]!.id;
    let registry = await f.store.edit(f.registry.revision, id, { ...f.codex, name: 'My Codex' });
    registry = await f.store.setDefault(registry.revision, 'Codex', id);
    registry = await f.store.toggle(registry.revision, id, false);
    registry = await f.store.mutate(registry.revision, value => { value.entries[0]!.error = 'Old executable missing'; });
    registry = await f.store.scan(registry.revision, [{ ...f.codex, version: 'codex-cli 2.0' }]);
    expect(registry.entries[0]).toEqual({ ...f.codex, name: 'My Codex', id, enabled: false, version: 'codex-cli 2.0', error: undefined });
    expect(registry.defaults.Codex).toBe(id);
    expect((await new CLIStore(f.directory).read()).entries[0]!.version).toBe('codex-cli 2.0');
  });
  it('fails closed on corrupt preferences instead of recreating an enabled list', async () => {
    const f = await fixture(); await writeFile(path.join(f.directory, 'registry.json'), '{broken');
    await expect(f.store.read()).rejects.toThrow('Could not read');
    await expect(f.store.initialize([f.codex])).rejects.toThrow('Could not read');
  });
  it('validates management messages and native paths', async () => {
    expect(() => cliRequest({ revision: 'r', provider: 'Codex', action: 'toggle', enabled: 'yes' })).toThrow();
    expect(() => cliRequest({ revision: 'r', provider: 'Claude', action: 'execute', executable: 'a' })).toThrow();
    const f = await fixture(); await expect(f.store.add(f.registry.revision, { ...f.codex, executable: 'relative.exe' })).rejects.toThrow('absolute');
  });
});
