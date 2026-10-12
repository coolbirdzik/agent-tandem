import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mergeQuotaObservations, type QuotaObservation } from './quota-estimate';
import { withStorageLock } from './storage-lock';

function observation(value: unknown): value is QuotaObservation {
  if (!value || typeof value !== 'object') return false;
  const row = value as QuotaObservation;
  return ['Codex', 'Claude'].includes(row.provider) && typeof row.accountId === 'string' && !!row.accountId && typeof row.plan === 'string' &&
    ['5h', 'Weekly'].includes(row.label) && [row.from, row.resetsAt, row.to, row.observedTokens, row.usedPercent].every(Number.isFinite) &&
    row.from > 0 && row.from < row.to && row.to < row.resetsAt && Number.isSafeInteger(row.observedTokens) && row.observedTokens > 0 && row.usedPercent > 0 && row.usedPercent <= 100;
}
const clean = (row: QuotaObservation): QuotaObservation => ({
  provider: row.provider, accountId: row.accountId, plan: row.plan, label: row.label,
  from: row.from, resetsAt: row.resetsAt, to: row.to, observedTokens: row.observedTokens, usedPercent: row.usedPercent,
});
/** Shared by all VS Code workspaces/windows; stores meters only, never credentials. */
export class QuotaHistoryStore {
  constructor(readonly directory: string) {}
  private async load(): Promise<QuotaObservation[]> {
    try {
      const data = JSON.parse(await readFile(path.join(this.directory, 'quota-history.json'), 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.observations)) throw new Error('Invalid quota history.');
      return data.observations.filter(observation).map(clean);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async record(incoming: QuotaObservation[] = []): Promise<QuotaObservation[]> {
    return withStorageLock(this.directory, async () => {
      const previous = await this.load(), rows = mergeQuotaObservations(previous, incoming.filter(observation).map(clean));
      if (JSON.stringify(rows) !== JSON.stringify(previous)) {
        const temporary = path.join(this.directory, `quota-history-${randomUUID()}.tmp`);
        try { await writeFile(temporary, JSON.stringify({ version: 1, observations: rows }), { flag: 'wx' }); await rename(temporary, path.join(this.directory, 'quota-history.json')); }
        finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
      }
      return rows;
    });
  }
}
