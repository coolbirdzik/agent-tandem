import type { AccountIdentity } from '../providers/account-status';
import type { ConversationProvider } from '../providers/conversations';

export interface UsageAccount { id: string; provider: ConversationProvider; email: string; organization?: string; nativeAccountId?: string; method: string }
export const UNKNOWN_ACCOUNT = 'unknown';
/** Native display identity only. Anonymous API keys/backends cannot identify an account. */
export function usageAccount(provider: ConversationProvider, identity?: AccountIdentity): UsageAccount | undefined {
  const email = identity?.email?.trim().toLowerCase();
  if (!identity?.signedIn || !email || identity.method !== (provider === 'Codex' ? 'ChatGPT' : 'Claude account')) return undefined;
  const organization = identity.organization?.trim() || undefined;
  const nativeAccountId = identity.id?.trim() || undefined;
  return { id: JSON.stringify([provider, identity.method, ...(nativeAccountId ? ['id', nativeAccountId] : [email, organization ?? ''])]), provider, email, method: identity.method,
    ...(nativeAccountId ? { nativeAccountId } : {}), ...(organization ? { organization } : {}) };
}
export function usageAccountLabel(account?: UsageAccount): string {
  return account ? `${account.email}${account.organization ? ` · ${account.organization}` : account.nativeAccountId ? ` · ${account.nativeAccountId}` : ''}` : 'Unknown account';
}
