import type { AccountIdentity } from '../providers/account-status';

export class AccountIdentityMismatchError extends Error {
  constructor(message = 'Saved sign-in belongs to a different account. Sign in again or save it as a separate account.') { super(message); }
}

/** Missing fields may be filled by a later read; conflicting known fields cannot change an account. */
export function accountIdentityMatches(expected?: AccountIdentity, actual?: AccountIdentity): boolean {
  if (!expected?.signedIn) return true;
  if (!actual?.signedIn || expected.method !== actual.method) return false;
  if (expected.email && actual.email && expected.email.trim().toLowerCase() !== actual.email.trim().toLowerCase()) return false;
  if (expected.id && actual.id && expected.id !== actual.id) return false;
  if (expected.organization && actual.organization && expected.organization !== actual.organization) return false;
  return true;
}

export function assertAccountIdentity(expected?: AccountIdentity, actual?: AccountIdentity): void {
  if (expected?.signedIn && !actual?.signedIn) throw new AccountIdentityMismatchError('Saved sign-in has expired or is unavailable. Sign in again.');
  if (!accountIdentityMatches(expected, actual)) throw new AccountIdentityMismatchError();
}
export function sameAccountIdentity(expected?: AccountIdentity, actual?: AccountIdentity): boolean {
  return !!expected?.signedIn && !!actual?.signedIn && accountIdentityMatches(expected, actual)
    && (!!expected.id && expected.id === actual.id || !!expected.email && expected.email.trim().toLowerCase() === actual.email?.trim().toLowerCase());
}

/** Local credential metadata is an ownership cross-check, not JWT authentication. No tokens leave this reader. */
export function codexAuthIdentity(auth: Record<string, any>): AccountIdentity | undefined {
  const decode = (value: unknown): Record<string, any> => {
    if (typeof value !== 'string') return {};
    try {
      const claims = JSON.parse(Buffer.from(value.split('.')[1] ?? '', 'base64url').toString('utf8'));
      return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : {};
    } catch { return {}; }
  };
  const identity = decode(auth.tokens?.id_token), access = decode(auth.tokens?.access_token);
  const info = identity['https://api.openai.com/auth'] ?? access['https://api.openai.com/auth'] ?? {};
  const email = identity.email ?? access.email, id = auth.tokens?.account_id ?? info.chatgpt_account_id;
  if (typeof email !== 'string' && typeof id !== 'string') return;
  return { signedIn: true, method: 'ChatGPT', ...(typeof email === 'string' ? { email } : {}), ...(typeof id === 'string' ? { id } : {}),
    ...(typeof info.chatgpt_plan_type === 'string' ? { plan: info.chatgpt_plan_type } : {}) };
}
