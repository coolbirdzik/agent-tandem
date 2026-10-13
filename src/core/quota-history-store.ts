import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mergeQuotaObservations, observeQuotaMeters, quotaMeterKey, type QuotaObservation, type QuotaBaseline, type QuotaMeter } from './quota-estimate';
import { withStorageLock } from './storage-lock';

function observation(value: unknown): value is QuotaObservation {
  if (!value || typeof value !== 'object') return false;
  const row = value as QuotaObservation;
  return ['Codex', 'Claude'].includes(row.provider) && typeof row.accountId === 'string' && !!row.accountId && typeof row.plan === 'string' &&
    ['5h', 'Weekly'].includes(row.label) && (row.source === undefined || ['API', 'Local'].includes(row.source)) && [row.from, row.resetsAt, row.to, row.observedTokens, row.usedPercent].every(Number.isFinite) &&
    row.from > 0 && row.from < row.to && row.to < row.resetsAt && Number.isSafeInteger(row.observedTokens) && row.observedTokens > 0 && row.usedPercent > 0 && row.usedPercent <= 100;
}
const clean = (row: QuotaObservation): QuotaObservation => ({
  provider: row.provider, accountId: row.accountId, plan: row.plan, label: row.label,
  from: row.from, resetsAt: row.resetsAt, to: row.to, observedTokens: row.observedTokens, usedPercent: row.usedPercent,
  ...(row.source ? { source: row.source } : {}),
});
function meter(value: unknown): value is QuotaMeter {
  if (!value || typeof value !== 'object') return false;
  const row = value as QuotaMeter;
  return ['Codex', 'Claude'].includes(row.provider) && typeof row.accountId === 'string' && !!row.accountId && typeof row.plan === 'string' && ['5h', 'Weekly'].includes(row.label) &&
    [row.from, row.to, row.resetsAt, row.usedPercent].every(Number.isFinite) && row.from > 0 && row.from < row.to && row.to < row.resetsAt &&
    Number.isSafeInteger(row.totalTokens) && row.totalTokens >= 0 && row.usedPercent >= 0 && row.usedPercent <= 100;
}
const cleanMeter = (row: QuotaMeter): QuotaMeter => ({ provider: row.provider, accountId: row.accountId, plan: row.plan, label: row.label,
  from: row.from, resetsAt: row.resetsAt, to: row.to, totalTokens: row.totalTokens, usedPercent: row.usedPercent });
/** Shared by all VS Code workspaces/windows; stores meters only, never credentials. */
export class QuotaHistoryStore {
  baselines: QuotaBaseline[] = [];
  constructor(readonly directory: string) {}
  private async load(): Promise<QuotaObservation[]> {
    try {
      const data = JSON.parse(await readFile(path.join(this.directory, 'quota-history.json'), 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.observations)) throw new Error('Invalid quota history.');
      this.baselines = (Array.isArray(data.baselines) ? data.baselines : []).filter((row: QuotaBaseline) => row && meter(row.start) && meter(row.latest) && quotaMeterKey(row.start) === quotaMeterKey(row.latest) && row.latest.to >= row.start.to && row.latest.totalTokens >= row.start.totalTokens && row.latest.usedPercent >= row.start.usedPercent)
        .map((row: QuotaBaseline) => ({ start: cleanMeter(row.start), latest: cleanMeter(row.latest) }));
      return data.observations.filter(observation).map(clean);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.baselines = []; return []; } throw error; }
  }
  async record(incoming: QuotaObservation[] = [], meters: QuotaMeter[] = []): Promise<QuotaObservation[]> {
    return withStorageLock(this.directory, async () => {
      const previous = await this.load(), priorBaselines = this.baselines;
      const observed = observeQuotaMeters(priorBaselines, meters.filter(meter).map(cleanMeter));
      const rows = mergeQuotaObservations(previous, [...incoming, ...observed.observations].filter(observation).map(clean));
      if (JSON.stringify(rows) !== JSON.stringify(previous) || JSON.stringify(observed.baselines) !== JSON.stringify(priorBaselines)) {
        const temporary = path.join(this.directory, `quota-history-${randomUUID()}.tmp`);
        try { await writeFile(temporary, JSON.stringify({ version: 1, observations: rows, baselines: observed.baselines }), { flag: 'wx' }); await rename(temporary, path.join(this.directory, 'quota-history.json')); }
        finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
      }
      this.baselines = observed.baselines;
      return rows;
    });
  }
}
