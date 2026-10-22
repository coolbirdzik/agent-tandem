import { profileIdentityKey, type AccountProfile } from './account-profiles';
import type { ProviderAccountStatus } from '../providers/account-status';
import { accountIdentityMatches } from './account-identity';

/** Never attach another account's plan or quota to a saved profile label. */
export function accountProfileStatus(profile: AccountProfile & { status?: ProviderAccountStatus }, status = profile.status): ProviderAccountStatus | undefined {
  return status && !accountIdentityMatches(profile.identity, status.account)
    ? { status: 'error', account: profile.identity, error: status.account?.signedIn ? 'Account identity mismatch. Refresh or sign in again.' : 'Saved sign-in has expired or is unavailable. Sign in again.' } : status;
}

/** Saved copies of the same identity share one display row, backed by the best quota snapshot. */
export function uniqueAccountProfiles<T extends AccountProfile & { status?: ProviderAccountStatus; active?: boolean }>(profiles: readonly T[]): T[] {
  const seen = new Set<string>();
  return [...profiles].sort((a, b) => Number(!!b.active) - Number(!!a.active)
    || Number(!!b.status?.quota) - Number(!!a.status?.quota)
    || Number(!b.status?.quotaCached) - Number(!a.status?.quotaCached)
    || (b.status?.updatedAt ?? 0) - (a.status?.updatedAt ?? 0))
    .filter(row => {
      const id = profileIdentityKey(row.provider, row.identity || row.status?.account) || row.id;
      if (seen.has(id)) return false;
      seen.add(id); return true;
    });
}
