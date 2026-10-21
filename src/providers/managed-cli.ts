import { stat } from 'node:fs/promises';
import type { CLIStore } from '../core/cli-store';
import type { ConversationProvider } from './conversations';
import { allowedCLI, cliPathKey, defaultCLI, type CLIActive, type CLIEntry, type CLIRegistry } from './cli-registry';
import { cliInfo, findExecutable, latestExtensionCodexCLI, type CLIInfo } from './probe';

export type CLISelection =
  | { type: 'automatic' }
  | { type: 'managed'; entry: CLIEntry; source: 'project' | 'default' }
  | { type: 'executable'; executable: string }
  | { type: 'path' };

export interface CLIConfiguration {
  terminal?: boolean;
  id?: string;
  executable?: string;
  codexExtensionPaths?: readonly string[];
}

export interface ResolvedCLI { cli: CLIInfo; entry?: CLIEntry; source: CLIActive['source'] }

function intent(registry: CLIRegistry, provider: ConversationProvider, config: CLIConfiguration): CLISelection {
  if (config.terminal) return { type: 'path' };
  if (config.id) {
    const entry = registry.entries.find(row => row.id === config.id && row.provider === provider);
    if (!entry) throw new Error(`The selected ${provider} CLI was removed. Choose another CLI in Manage CLIs.`);
    return { type: 'managed', entry: allowedCLI(registry, provider, entry.executable), source: 'project' };
  }
  if (config.executable) return { type: 'executable', executable: config.executable };
  const entry = defaultCLI(registry, provider);
  return entry ? { type: 'managed', entry, source: 'default' } : { type: 'automatic' };
}

async function fingerprint(executable: string) {
  const value = await stat(executable);
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}:${value.mode}`;
}

async function cancellable<T>(job: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return job;
  signal.throwIfAborted();
  let stop!: () => void;
  const aborted = new Promise<never>((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); });
  try { return await Promise.race([job, aborted]); }
  finally { signal.removeEventListener('abort', stop); }
}

/** Stable intent is persisted by CLIStore; resolved paths and versions live only here. */
export class ManagedCLIResolver {
  private generations: Record<ConversationProvider, number> = { Codex: 0, Claude: 0 };
  private cache = new Map<string, { resolved: ResolvedCLI; fingerprint: string }>();
  private pending = new Map<string, Promise<ResolvedCLI>>();
  constructor(private store: CLIStore) {}
  invalidate(provider?: ConversationProvider) {
    for (const name of provider ? [provider] : ['Codex', 'Claude'] as const) {
      this.generations[name]++;
      for (const key of this.cache.keys()) if (key.startsWith(`${name}:`)) this.cache.delete(key);
      for (const key of this.pending.keys()) if (key.startsWith(`${name}:`)) this.pending.delete(key);
    }
  }
  invalidateOnFailure(provider: ConversationProvider, error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message = error instanceof Error ? error.message : '';
    // Account/auth/network errors don't mean that the executable stopped working.
    if ((code && ['ENOENT', 'EACCES', 'ENOEXEC', 'ENOTDIR', 'EPERM'].includes(code)) ||
      /^(?:Could not start (?:Codex|Claude)|Codex (?:closed during|exited|(?:account |model )?connection closed)|(?:codex|claude) executable was not found\.)/.test(message)) this.invalidate(provider);
  }

  async resolve(provider: ConversationProvider, config: CLIConfiguration, signal?: AbortSignal): Promise<ResolvedCLI> {
    signal?.throwIfAborted();
    const registry = await this.store.read();
    if (!registry.initialized) throw new Error('Initialize the managed CLI list before resolving a CLI.');
    const selection = intent(registry, provider, config);
    const generation = this.generations[provider];
    const key = `${provider}:${JSON.stringify([generation, registry.revision, selection, config.codexExtensionPaths, process.env.PATH])}`;
    const cached = this.cache.get(key);
    if (cached) {
      try {
        if (await fingerprint(cached.resolved.cli.executable) === cached.fingerprint) {
          signal?.throwIfAborted(); return cached.resolved;
        }
      } catch { signal?.throwIfAborted(); }
      this.cache.delete(key);
    }
    let job = this.pending.get(key);
    if (!job) {
      job = this.discover(provider, registry, selection, config).then(async resolved => {
        const stamp = await fingerprint(resolved.cli.executable);
        if (generation === this.generations[provider]) {
          // Bound memory across workspace/configuration changes.
          if (this.cache.size >= 16) this.cache.clear();
          this.cache.set(key, { resolved, fingerprint: stamp });
        }
        return resolved;
      });
      this.pending.set(key, job);
      void job.finally(() => { if (this.pending.get(key) === job) this.pending.delete(key); }).catch(() => undefined);
    }
    // A cancelled poll must not cancel discovery shared with another operation.
    return cancellable(job, signal);
  }

  private async discover(provider: ConversationProvider, registry: CLIRegistry, selection: CLISelection, config: CLIConfiguration): Promise<ResolvedCLI> {
    const name = provider === 'Codex' ? 'codex' : 'claude';
    const known = (executable: string, required: boolean) => {
      const entry = registry.entries.find(row => row.provider === provider && cliPathKey(row.executable) === cliPathKey(executable));
      return entry || required ? allowedCLI(registry, provider, executable) : undefined;
    };
    if (selection.type !== 'automatic') {
      const executable = await findExecutable(name, selection.type === 'managed' ? selection.entry.executable : selection.type === 'executable' ? selection.executable : '');
      const entry = known(executable, true);
      return { cli: await cliInfo(name, executable), entry, source: selection.type === 'managed' ? selection.source : selection.type === 'path' ? 'path' : 'project' };
    }
    let terminal: string | undefined;
    try { terminal = await findExecutable(name); } catch (error) { if (provider !== 'Codex') throw error; }
    if (terminal) {
      const entry = known(terminal, provider !== 'Codex');
      try {
        const cli = await cliInfo(name, terminal);
        if (provider !== 'Codex' || /^codex-cli\s+/i.test(cli.version)) return { cli, entry, source: provider === 'Codex' ? 'automatic-path' : 'default' };
      } catch (error) { if (provider !== 'Codex') throw error; }
    }
    const cli = await latestExtensionCodexCLI(config.codexExtensionPaths, undefined, executable => { known(executable, false); });
    if (!cli) throw new Error('No usable Codex CLI was found on PATH or in the current editor extension. Install Codex or choose an executable in Manage CLIs.');
    return { cli, entry: known(cli.executable, false), source: 'extension' };
  }
}
