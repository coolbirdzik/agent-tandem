import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { emptyCLIRegistry, cliPathKey, type CLIEntry, type CLIRegistry } from '../providers/cli-registry';
import type { ConversationProvider } from '../providers/conversations';

export function nativeCLIPath(file: string) {
  if (!file || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file) || (process.platform === 'win32' && path.extname(file).toLowerCase() !== '.exe')) throw new Error('Choose an absolute native CLI executable path (.exe on Windows).');
  return path.resolve(file);
}
export type CLIRegistration = Omit<CLIEntry, 'id' | 'enabled'>;
export class CLIStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  private get filename() { return path.join(this.directory, 'registry.json'); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.queue.then(operation); this.queue = job.catch(() => undefined); return job;
  }
  private async load(): Promise<CLIRegistry> {
    let data;
    try { data = JSON.parse(await readFile(this.filename, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCLIRegistry(); throw new Error('Could not read the managed CLI list. Restore its registry file before running agents.'); }
    try {
      if (data.version !== 1 || data.initialized !== true || typeof data.revision !== 'string' || !data.revision || !Array.isArray(data.entries) || !data.defaults || ['Codex', 'Claude'].some(provider => typeof data.defaults[provider] !== 'string')) throw new Error();
      const ids = new Set<string>(), paths = new Set<string>();
      for (const entry of data.entries) {
        if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || (entry.provider !== 'Codex' && entry.provider !== 'Claude') || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 80 || typeof entry.version !== 'string' || typeof entry.executable !== 'string' || typeof entry.enabled !== 'boolean') throw new Error();
        const key = `${entry.provider}:${cliPathKey(nativeCLIPath(entry.executable))}`;
        if (paths.has(key)) throw new Error(); ids.add(entry.id); paths.add(key);
      }
    } catch { throw new Error('The managed CLI list is invalid. Restore its registry file before running agents.'); }
    return data as CLIRegistry;
  }
  private async write(value: CLIRegistry) {
    value.revision = randomUUID(); value.initialized = true;
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx' }); await rename(temporary, this.filename); }
    finally { await unlink(temporary).catch(() => undefined); }
    return value;
  }
  read() { return this.serial(() => this.load()); }
  initialize(entries: CLIRegistration[]) { return this.serial(async () => {
    const value = await this.load(); if (value.initialized) return value;
    for (const entry of entries) this.register(value, entry, true);
    return this.write(value);
  }); }
  private register(value: CLIRegistry, entry: CLIRegistration, enabled: boolean) {
    const executable = nativeCLIPath(entry.executable), name = entry.name.trim();
    if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw new Error('Enter a CLI name (up to 80 characters).');
    const existing = value.entries.find(row => row.provider === entry.provider && cliPathKey(row.executable) === cliPathKey(executable));
    if (existing) return existing;
    const row = { ...entry, executable, name, id: randomUUID(), enabled }; value.entries.push(row); return row;
  }
  mutate(revision: string, operation: (value: CLIRegistry) => void) { return this.serial(async () => {
    const value = await this.load();
    if (value.revision !== revision) throw new Error('The CLI list changed. Refresh and try again.');
    operation(value); return this.write(value);
  }); }
  add(revision: string, entry: CLIRegistration) { return this.mutate(revision, value => {
    const existing = value.entries.find(row => row.provider === entry.provider && cliPathKey(row.executable) === cliPathKey(nativeCLIPath(entry.executable)));
    if (existing) throw new Error('This executable is already in the managed list. Edit or enable its existing entry.');
    this.register(value, entry, true);
  }); }
  scan(revision: string, entries: CLIRegistration[]) { return this.mutate(revision, value => {
    for (const entry of entries) {
      const row = this.register(value, entry, false);
      // Keep user names, selections and enabled flags when an install updates in place.
      row.version = entry.version; row.error = entry.error;
    }
  }); }
  edit(revision: string, id: string, entry: CLIRegistration) { return this.mutate(revision, value => {
    const row = value.entries.find(row => row.id === id && row.provider === entry.provider); if (!row) throw new Error('This CLI entry no longer exists.');
    const executable = nativeCLIPath(entry.executable), name = entry.name.trim();
    if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw new Error('Enter a CLI name.');
    if (value.entries.some(other => other.id !== id && other.provider === entry.provider && cliPathKey(other.executable) === cliPathKey(executable))) throw new Error('This executable is already in the managed list.');
    Object.assign(row, entry, { executable, name, error: undefined });
  }); }
  toggle(revision: string, id: string, enabled: boolean) { return this.mutate(revision, value => {
    const row = value.entries.find(row => row.id === id); if (!row) throw new Error('This CLI entry no longer exists.'); row.enabled = enabled;
  }); }
  remove(revision: string, id: string) { return this.mutate(revision, value => {
    if (!value.entries.some(row => row.id === id)) throw new Error('This CLI entry no longer exists.');
    value.entries = value.entries.filter(row => row.id !== id);
    // Keep a removed default unresolved instead of switching to another binary.
  }); }
  setDefault(revision: string, provider: ConversationProvider, id: string) { return this.mutate(revision, value => {
    if (id && !value.entries.some(row => row.id === id && row.provider === provider && row.enabled && !row.error)) throw new Error('Choose an enabled CLI as the default.');
    value.defaults[provider] = id;
  }); }
}
