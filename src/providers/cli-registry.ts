import type { ConversationProvider } from './conversations';

export interface CLIEntry { id: string; provider: ConversationProvider; name: string; executable: string; version: string; enabled: boolean; error?: string }
export interface CLIRegistry { version: 1; initialized: boolean; revision: string; entries: CLIEntry[]; defaults: Record<ConversationProvider, string> }
export interface CLIActive { id?: string; source: 'project' | 'default' | 'path'; error?: string }
export interface CLIManagerState { registry: CLIRegistry; active: Partial<Record<ConversationProvider, CLIActive>>; busy: boolean; trusted: boolean; error?: string }
export interface CLIRequest { project?: string; revision: string; provider: ConversationProvider; action: 'add' | 'edit' | 'toggle' | 'remove' | 'default' | 'use' | 'scan' | 'refresh'; id?: string; name?: string; executable?: string; enabled?: boolean }
export const emptyCLIRegistry = (): CLIRegistry => ({ version: 1, initialized: false, revision: 'new', entries: [], defaults: { Codex: '', Claude: '' } });
export function cliRequest(value: unknown): CLIRequest {
  if (!value || typeof value !== 'object') throw new Error('Choose a CLI action.');
  const r = value as CLIRequest;
  if ((r.project !== undefined && typeof r.project !== 'string') || typeof r.revision !== 'string' || !r.revision ||
    (r.provider !== 'Codex' && r.provider !== 'Claude') || !['add', 'edit', 'toggle', 'remove', 'default', 'use', 'scan', 'refresh'].includes(r.action) ||
    (r.id !== undefined && typeof r.id !== 'string') || (r.name !== undefined && (typeof r.name !== 'string' || r.name.length > 80 || /[\x00-\x1f]/.test(r.name))) ||
    (r.executable !== undefined && (typeof r.executable !== 'string' || r.executable.length > 4096 || /[\x00-\x1f]/.test(r.executable))) || (r.enabled !== undefined && typeof r.enabled !== 'boolean')) throw new Error('Invalid CLI management action.');
  return { project: r.project, revision: r.revision, provider: r.provider, action: r.action, id: r.id, name: r.name, executable: r.executable, enabled: r.enabled };
}
export const cliPathKey = (file: string) => /^[a-z]:[\\/]|^\\\\/i.test(file) ? file.replace(/\\/g, '/').toLowerCase() : file;
export function allowedCLI(registry: CLIRegistry, provider: ConversationProvider, executable: string): CLIEntry {
  const entry = registry.entries.find(entry => entry.provider === provider && cliPathKey(entry.executable) === cliPathKey(executable));
  if (!registry.initialized || !entry) throw new Error(`This ${provider} CLI is not in your managed list. Add or enable it in Manage CLIs.`);
  if (!entry.enabled) throw new Error(`${entry.name} is disabled. Enable it or choose another CLI in Manage CLIs.`);
  if (entry.error) throw new Error(`${entry.name} is unavailable: ${entry.error}. Edit or refresh it in Manage CLIs.`);
  return entry;
}
export function defaultCLI(registry: CLIRegistry, provider: ConversationProvider): CLIEntry | undefined {
  const id = registry.defaults[provider]; if (!id) return;
  const entry = registry.entries.find(entry => entry.id === id && entry.provider === provider);
  if (!entry) throw new Error(`The default ${provider} CLI was removed. Choose another default in Manage CLIs.`);
  return allowedCLI(registry, provider, entry.executable);
}
