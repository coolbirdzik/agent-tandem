import type { AccountProvider } from './account-providers';
export interface AccountSwitchLog { at: number; level: 'info' | 'success' | 'error'; message: string }
export interface AccountSwitchOperation {
  id: string; profileId: string; provider?: AccountProvider; label?: string;
  status: 'running' | 'success' | 'error'; startedAt: number; finishedAt?: number;
  error?: string; notice?: string;
  outcome: 'notChanged' | 'unknown' | 'restored' | 'switched' | 'recoveryRequired';
  logs: AccountSwitchLog[];
}
export type RollbackProgress = (status: 'running' | 'success' | 'error') => void;
