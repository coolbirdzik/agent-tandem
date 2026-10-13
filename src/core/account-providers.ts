export const ACCOUNT_PROVIDERS = ['Codex', 'Claude', 'Cursor', 'Antigravity'] as const;
export type AccountProvider = typeof ACCOUNT_PROVIDERS[number];
export type DesktopAccountProvider = 'Cursor' | 'Antigravity';
export const isChatAccount = (provider: AccountProvider): provider is 'Codex' | 'Claude' => provider === 'Codex' || provider === 'Claude';
export const isAccountProvider = (value: unknown): value is AccountProvider => ACCOUNT_PROVIDERS.includes(value as AccountProvider);
export const accountProviderName = (provider: AccountProvider) => provider === 'Claude' ? 'Claude Code' : provider;
export const accountProviderDetail = (provider: AccountProvider) => isChatAccount(provider) ? 'Native CLI · quota & usage' : 'Desktop IDE · native sign-in';
