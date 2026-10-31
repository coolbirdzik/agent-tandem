import type { ConversationProvider } from '../providers/conversations';
import type { UsageAccount } from './usage-account';

export interface UsageAssignmentScope { provider: ConversationProvider; conversationId?: string; from?: string; to?: string; responseIds?: string[] }
export interface UsageAssignment extends UsageAssignmentScope { id: string; account: UsageAccount | null }
export interface KnownUsageAccount { account: UsageAccount; nativeAccountIds: string[] }
export function validAssignmentScope(value: UsageAssignmentScope) {
  const date = (day?: string) => day === undefined || (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day);
  return !!value && ['Codex', 'Claude'].includes(value.provider) &&
    (value.conversationId === undefined || (typeof value.conversationId === 'string' && /^[^\x00-\x1f]{1,512}$/.test(value.conversationId) && value.conversationId !== 'unknown')) &&
    date(value.from) && date(value.to) && (!value.from || !value.to || value.from <= value.to) &&
    (value.responseIds === undefined || (!!value.conversationId && Array.isArray(value.responseIds) && value.responseIds.length > 0 && value.responseIds.length <= 10000 &&
      value.responseIds.every(id => typeof id === 'string' && id.startsWith(`${value.provider}:`) && /^[^\x00-\x1f]{1,2048}$/.test(id) && id.length > value.provider.length + 1) && new Set(value.responseIds).size === value.responseIds.length)) &&
    (!!value.conversationId || (!!value.from && !!value.to));
}
export function matchingAssignment(rows: UsageAssignment[], provider: ConversationProvider, conversationId: string | undefined, day: string, responseId?: string) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.provider === provider && (!row.conversationId || row.conversationId === conversationId) && (!row.from || day >= row.from) && (!row.to || day <= row.to) && (!row.responseIds || (!!responseId && row.responseIds.includes(responseId)))) return row;
  }
}
