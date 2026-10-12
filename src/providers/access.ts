import type { ConversationProvider } from './conversations';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export type AccessMode = 'default' | 'read-only' | 'accept-edits' | 'plan' | 'dont-ask' | 'auto' | 'full-access';
export interface AccessChoice { mode: AccessMode; label: string; description: string }
export interface AccessSelection { project: string; provider: ConversationProvider; mode: AccessMode }
export type AccessModes = Record<ConversationProvider, AccessMode>;
export const defaultAccessModes = (): AccessModes => ({ Codex: 'default', Claude: 'default' });
export const accessChoices: Record<ConversationProvider, AccessChoice[]> = {
  Codex: [
    { mode: 'default', label: 'Agent', description: 'Work in the project sandbox; ask when extra access is needed.' },
    { mode: 'read-only', label: 'Read only', description: 'Read and inspect in a read-only sandbox; deny operations needing extra access.' },
    { mode: 'full-access', label: 'Full access', description: 'Access files and network outside the project sandbox, without tool approval prompts.' },
  ],
  Claude: [
    { mode: 'default', label: 'Ask', description: 'Ask for tool permissions unless a saved rule already allows them.' },
    { mode: 'accept-edits', label: 'Auto edits', description: 'Automatically approve file edits; other actions follow permission rules.' },
    { mode: 'plan', label: 'Plan', description: 'Explore and plan; file edits are not automatically approved.' },
    { mode: 'auto', label: 'Auto', description: 'Let Claude classify tool approvals where supported by your CLI and account.' },
    { mode: 'dont-ask', label: "Don't ask", description: 'Deny actions that need approval; allow actions covered by existing permissions.' },
    { mode: 'full-access', label: 'Full access', description: 'Run tools and access files/network outside the project without ordinary approval prompts; native provider rules still apply.' },
  ],
};
export function accessMode(value: unknown, provider: ConversationProvider): AccessMode {
  if (value === undefined) return 'default';
  if (!accessChoices[provider].some(choice => choice.mode === value)) throw new Error(`Choose a supported ${provider} access mode.`);
  return value as AccessMode;
}
export function accessSelection(value: unknown): AccessSelection {
  if (!value || typeof value !== 'object') throw new Error('Choose an access mode.');
  const selection = value as AccessSelection;
  if (typeof selection.project !== 'string' || (selection.provider !== 'Codex' && selection.provider !== 'Claude') || selection.mode === undefined) throw new Error('Choose an access mode for this project.');
  return { project: selection.project, provider: selection.provider, mode: accessMode(selection.mode, selection.provider) };
}
export function codexAccess(mode?: AccessMode) {
  const validated = accessMode(mode, 'Codex');
  return { approvalPolicy: validated === 'default' ? 'on-request' : 'never', sandbox: validated === 'full-access' ? 'danger-full-access' : validated === 'read-only' ? 'read-only' : 'workspace-write' };
}
export function claudeAccess(mode?: AccessMode): { permissionMode: PermissionMode; allowDangerouslySkipPermissions: boolean } {
  const mapping: Partial<Record<AccessMode, PermissionMode>> = { default: 'default', 'accept-edits': 'acceptEdits', plan: 'plan', auto: 'auto', 'dont-ask': 'dontAsk', 'full-access': 'bypassPermissions' };
  const validated = accessMode(mode, 'Claude');
  return { permissionMode: mapping[validated]!, allowDangerouslySkipPermissions: validated === 'full-access' };
}
