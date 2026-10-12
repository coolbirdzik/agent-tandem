import type { ConversationProvider } from './conversations';
import { modelId, type ModelCatalog } from './models';

export interface EffortChoice { id: string; label: string; description?: string }
export type SelectedEfforts = Record<ConversationProvider, Record<string, string>>;
export interface EffortSelection { project: string; provider: ConversationProvider; model: string; effort: string }
export const defaultEfforts = (): SelectedEfforts => ({ Codex: {}, Claude: {} });
/** Empty inherits the native CLI settings. Levels themselves come from its catalog. */
export function effortId(value: unknown): string {
  if (typeof value !== 'string' || (value !== '' && !/^[a-z][a-z0-9_-]{0,31}$/.test(value))) throw new Error('Choose a valid reasoning effort.');
  return value;
}
export function effortLabel(value: string) {
  return ({ xhigh: 'Extra high', none: 'None', minimal: 'Minimal' } as Record<string, string>)[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
}
export function effortSelection(value: unknown): EffortSelection {
  if (!value || typeof value !== 'object') throw new Error('Choose reasoning effort.');
  const r = value as EffortSelection;
  if (typeof r.project !== 'string' || (r.provider !== 'Codex' && r.provider !== 'Claude')) throw new Error('Choose reasoning effort for this project.');
  return { project: r.project, provider: r.provider, model: modelId(r.model), effort: effortId(r.effort) };
}
export function validateEffort(effort: string, model: string, catalog?: ModelCatalog) {
  effortId(effort);
  if (effort && (catalog?.status !== 'ready' || !model || !catalog.choices.find(row => row.id === model)?.reasoningEfforts?.some(row => row.id === effort))) throw new Error('This reasoning effort is unavailable for the selected model. Choose Auto or refresh models.');
  return effort;
}
