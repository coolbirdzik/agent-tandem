export interface FastModeSelection { project: string; provider: 'Codex'; enabled: boolean }

export function fastMode(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid Codex Fast mode.');
  return value;
}

export function fastModeSelection(value: unknown): FastModeSelection {
  if (!value || typeof value !== 'object') throw new Error('Choose Codex Fast mode.');
  const selection = value as FastModeSelection;
  if (typeof selection.project !== 'string' || selection.provider !== 'Codex') throw new Error('Choose Codex Fast mode.');
  return { project: selection.project, provider: 'Codex', enabled: fastMode(selection.enabled) };
}
