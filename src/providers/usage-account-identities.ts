import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AccountProfiles } from '../core/account-profiles';
import { claudeMetadata, nativeHome } from '../core/account-profiles';
import { claudeHistoryOwner, usageAccount } from '../core/usage-account';
import type { KnownUsageAccount } from '../core/usage-attribution-store';
import type { ProviderAccountStatus } from './account-status';

/** Native auth/metadata is read locally to match history owners; credentials never leave this function. */
export async function knownUsageAccounts(profiles: AccountProfiles, current: Partial<Record<'Codex' | 'Claude', ProviderAccountStatus>> = {}): Promise<KnownUsageAccount[]> {
  const entries = (await profiles.read()).profiles.filter(row => row.provider === 'Codex' || row.provider === 'Claude').map(row => ({ provider: row.provider as 'Codex' | 'Claude', identity: row.identity, home: profiles.home(row.id) }));
  for (const provider of ['Codex', 'Claude'] as const) entries.push({ provider, identity: current[provider]?.account, home: nativeHome(provider) });
  const result: KnownUsageAccount[] = [];
  for (const entry of entries) {
    let claudeOwner: Record<string, unknown> | undefined;
    if (entry.provider === 'Claude') {
      try { claudeOwner = JSON.parse(await readFile(claudeMetadata(entry.home), 'utf8')).oauthAccount; } catch { /* Metadata is optional. */ }
    }
    const account = usageAccount(entry.provider, entry.identity ?? (typeof claudeOwner?.emailAddress === 'string' ? {
      signedIn: true, method: 'Claude account', email: claudeOwner.emailAddress,
      ...(typeof claudeOwner.organizationUuid === 'string' ? { organization: claudeOwner.organizationUuid } : {}),
    } : undefined));
    if (!account) continue;
    const nativeAccountIds = account.nativeAccountId ? [account.nativeAccountId] : [];
    if (entry.provider === 'Codex') {
      try {
        const auth = JSON.parse(await readFile(path.join(entry.home, 'auth.json'), 'utf8'));
        const encoded = typeof auth.tokens?.id_token === 'string' ? auth.tokens.id_token.split('.')[1] : undefined;
        const claims = encoded ? JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) : undefined;
        // A rotated or replaced auth file must not alias another saved identity.
        if (typeof claims?.email === 'string' && claims.email.trim().toLowerCase() === account.email && typeof auth.tokens?.account_id === 'string' && auth.tokens.account_id.trim()) nativeAccountIds.push(auth.tokens.account_id.trim());
      } catch { /* Native identity can still match its reported workspace ID. */ }
    } else if (typeof claudeOwner?.emailAddress === 'string' && claudeOwner.emailAddress.trim().toLowerCase() === account.email &&
      (!account.organization || account.organization === claudeOwner.organizationUuid)) {
      const owner = claudeHistoryOwner(claudeOwner.accountUuid, claudeOwner.organizationUuid);
      if (owner) nativeAccountIds.push(owner);
    }
    result.push({ account, nativeAccountIds: [...new Set(nativeAccountIds)] });
  }
  return result;
}
