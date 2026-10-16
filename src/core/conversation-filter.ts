import type { ConversationProvider } from '../providers/conversations';
import type { CleanupConversation } from './conversation-cleanup';

/**
 * Shared by the Storage list and the host, so Delete all matching removes exactly what the filters describe.
 * `after` (inclusive) and `before` (exclusive) bound the last message time, e.g. one calendar year.
 */
export interface ConversationFilter { before: number; after?: number; provider?: ConversationProvider; archived?: boolean; query?: string }
type Row = Pick<CleanupConversation, 'provider' | 'archived' | 'title' | 'project' | 'id' | 'lastMessageAt' | 'updatedAt'>;

export const conversationTime = (row: Pick<CleanupConversation, 'lastMessageAt' | 'updatedAt'>) => row.lastMessageAt ?? row.updatedAt;
export function matchesConversation(row: Row, filter: ConversationFilter) {
  const query = filter.query?.trim().toLocaleLowerCase();
  const time = conversationTime(row);
  return (!filter.provider || row.provider === filter.provider) && time < filter.before && (filter.after === undefined || time >= filter.after)
    && (filter.archived === undefined || row.archived === filter.archived)
    && (!query || `${row.title} ${row.project} ${row.id}`.toLocaleLowerCase().includes(query));
}
export function validCutoff(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value > Date.now()) throw new Error('Choose a valid past cutoff for deletion.');
  return value;
}
export function conversationFilter(value: unknown): ConversationFilter {
  if (!value || typeof value !== 'object') throw new Error('Choose which conversations to delete.');
  const { before, after, provider, archived, query } = value as Record<string, unknown>;
  if (provider !== undefined && provider !== 'Codex' && provider !== 'Claude') throw new Error('Unknown conversation provider.');
  if (archived !== undefined && typeof archived !== 'boolean') throw new Error('Invalid archive filter.');
  if (query !== undefined && typeof query !== 'string') throw new Error('Invalid search filter.');
  const cutoff = validCutoff(before);
  if (after !== undefined && (typeof after !== 'number' || !Number.isFinite(after) || after >= cutoff)) throw new Error('Invalid date range.');
  return { before: cutoff, ...(after !== undefined ? { after } : {}), ...(provider ? { provider } : {}), ...(archived !== undefined ? { archived } : {}), ...(query?.trim() ? { query } : {}) };
}
