/** Lifetime space reclaimed from Storage, kept in extension global state so it survives reloads. */
export interface StorageFreed { bytes: number; conversations: number; files: number; runs: number; lastAt?: number; lastBytes?: number }
export const emptyFreed: StorageFreed = { bytes: 0, conversations: 0, files: 0, runs: 0 };

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Reads a saved total, discarding anything malformed instead of failing the dashboard. */
export function storageFreed(value: unknown): StorageFreed {
  if (!value || typeof value !== 'object') return { ...emptyFreed };
  const saved = value as Record<string, unknown>, lastAt = count(saved.lastAt);
  return { bytes: count(saved.bytes), conversations: count(saved.conversations), files: count(saved.files), runs: count(saved.runs), ...(lastAt ? { lastAt, lastBytes: count(saved.lastBytes) } : {}) };
}

/** Adds one cleanup run; runs that removed nothing leave the total unchanged. */
export function addFreed(previous: unknown, run: { bytes: number; conversations?: number; files?: number }, at = Date.now()): StorageFreed {
  const total = storageFreed(previous), bytes = count(run.bytes), conversations = count(run.conversations), files = count(run.files);
  if (!bytes && !conversations && !files) return total;
  return { bytes: total.bytes + bytes, conversations: total.conversations + conversations, files: total.files + files, runs: total.runs + 1, lastAt: at, lastBytes: bytes };
}
