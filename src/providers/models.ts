import type { ConversationProvider } from './conversations';

export interface ModelChoice { id: string; label: string; description?: string; reasoningEfforts?: import('./effort').EffortChoice[]; defaultReasoningEffort?: string }
export interface ModelCatalog { status: 'loading' | 'ready' | 'error'; choices: ModelChoice[]; error?: string; cli?: { executable: string; version: string } }
export type SelectedModels = Record<ConversationProvider, string>;
export interface ModelSelection { project: string; provider: ConversationProvider; model: string }
export const defaultModels = (): SelectedModels => ({ Codex: '', Claude: '' });
/** Empty means inherit the native provider's configured/default model. */
export function modelId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('Choose a valid model.');
  return value;
}
export function modelSelection(value: unknown): ModelSelection {
  if (!value || typeof value !== 'object') throw new Error('Choose a model.');
  const r = value as ModelSelection;
  if (typeof r.project !== 'string' || (r.provider !== 'Codex' && r.provider !== 'Claude')) throw new Error('Choose a model for this project.');
  return { project: r.project, provider: r.provider, model: modelId(r.model) };
}
export function validateModel(model: string, catalog?: ModelCatalog) {
  modelId(model);
  if (model && (catalog?.status !== 'ready' || !catalog.choices.some(choice => choice.id === model))) throw new Error('This model is unavailable. Refresh models or choose Provider default.');
  return model;
}
export function validateModelCLI(model: string, catalog: ModelCatalog | undefined, cli: NonNullable<ModelCatalog['cli']>) {
  if (!model) return;
  const normalize = (file: string) => /^[a-z]:[\\/]/i.test(file) ? file.replace(/\\/g, '/').toLowerCase() : file;
  if (!catalog?.cli || normalize(catalog.cli.executable) !== normalize(cli.executable) || catalog.cli.version !== cli.version) throw new Error('The CLI changed since models were loaded. Refresh models and choose again.');
}
