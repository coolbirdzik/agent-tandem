import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mergeQuotaObservations, observeQuotaMeters, sameQuotaCycle, type QuotaObservation, type QuotaBaseline, type QuotaMeter } from './quota-estimate';
import { withStorageLock } from './storage-lock';
import { observeQuotaCycleStarts, type QuotaCycleStart } from './quota-cycle-start';
import type { QuotaTick } from './quota-pace';

const validCycleFields = (row: QuotaObservation | QuotaMeter) => row.cycleStartedAt === undefined ? row.cycleStartKnown === undefined
  : Number.isFinite(row.cycleStartedAt) && row.cycleStartedAt > 0 && row.cycleStartedAt <= row.to && typeof row.cycleStartKnown === 'boolean';
const cycleFields = (row: QuotaObservation | QuotaMeter) => row.cycleStartedAt === undefined ? {} : { cycleStartedAt: row.cycleStartedAt, cycleStartKnown: row.cycleStartKnown };
const validCycleStart = (row: QuotaCycleStart) => row && ['Codex', 'Claude'].includes(row.provider) && typeof row.accountId === 'string' && !!row.accountId && typeof row.plan === 'string' &&
  ['5h', 'Weekly'].includes(row.label) && [row.from, row.to, row.startUsedPercent, row.usedPercent].every(Number.isFinite) && row.from > 0 && row.from <= row.to &&
  row.startUsedPercent >= 0 && row.startUsedPercent <= 100 && row.usedPercent >= 0 && row.usedPercent <= 100;

function observation(value: unknown): value is QuotaObservation {
  if (!value || typeof value !== 'object') return false;
  const row = value as QuotaObservation;
  return ['Codex', 'Claude'].includes(row.provider) && typeof row.accountId === 'string' && !!row.accountId && typeof row.plan === 'string' &&
    ['5h', 'Weekly'].includes(row.label) && (row.source === undefined || ['API', 'Local', 'Device'].includes(row.source)) && [row.from, row.resetsAt, row.to, row.observedTokens, row.usedPercent].every(Number.isFinite) &&
    row.from > 0 && row.from < row.to && row.to < row.resetsAt && Number.isSafeInteger(row.observedTokens) && row.observedTokens > 0 && row.usedPercent > 0 && row.usedPercent <= 100 &&
    validCycleFields(row) && (row.startUsedPercent === undefined || (Number.isFinite(row.startUsedPercent) && row.startUsedPercent >= 0 && row.startUsedPercent + row.usedPercent <= 100));
}
const clean = (row: QuotaObservation): QuotaObservation => ({
  provider: row.provider, accountId: row.accountId, plan: row.plan, label: row.label,
  from: row.from, resetsAt: row.resetsAt, to: row.to, observedTokens: row.observedTokens, usedPercent: row.usedPercent,
  ...(row.source ? { source: row.source } : {}),
  ...(row.startUsedPercent === undefined ? {} : { startUsedPercent: row.startUsedPercent }),
  ...cycleFields(row),
});
function meter(value: unknown): value is QuotaMeter {
  if (!value || typeof value !== 'object') return false;
  const row = value as QuotaMeter;
  return ['Codex', 'Claude'].includes(row.provider) && typeof row.accountId === 'string' && !!row.accountId && typeof row.plan === 'string' && ['5h', 'Weekly'].includes(row.label) &&
    [row.from, row.to, row.resetsAt, row.usedPercent].every(Number.isFinite) && row.from > 0 && row.from < row.to && row.to < row.resetsAt &&
    Number.isSafeInteger(row.totalTokens) && row.totalTokens >= 0 && row.usedPercent >= 0 && row.usedPercent <= 100 && validCycleFields(row);
}
const cleanMeter = (row: QuotaMeter): QuotaMeter => ({ provider: row.provider, accountId: row.accountId, plan: row.plan, label: row.label,
  from: row.from, resetsAt: row.resetsAt, to: row.to, totalTokens: row.totalTokens, usedPercent: row.usedPercent, ...cycleFields(row) });
/** Shared by all VS Code workspaces/windows; stores meters only, never credentials. */
export class QuotaHistoryStore {
  baselines: QuotaBaseline[] = [];
  cycleStarts: QuotaCycleStart[] = [];
  constructor(readonly directory: string) {}
  /** Atomic JSON reads do not need the capture/write lock during activation. */
  read(): Promise<QuotaObservation[]> { return this.load(); }
  private async load(): Promise<QuotaObservation[]> {
    try {
      const data = JSON.parse(await readFile(path.join(this.directory, 'quota-history.json'), 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.observations)) throw new Error('Invalid quota history.');
      this.cycleStarts = (Array.isArray(data.cycleStarts) ? data.cycleStarts : []).filter(validCycleStart).map((row: QuotaCycleStart) => ({
        provider: row.provider, accountId: row.accountId, plan: row.plan, label: row.label, from: row.from, to: row.to, startUsedPercent: row.startUsedPercent, usedPercent: row.usedPercent,
      }));
      this.baselines = (Array.isArray(data.baselines) ? data.baselines : []).filter((row: QuotaBaseline) => row && meter(row.start) && meter(row.latest) && sameQuotaCycle(row.start, row.latest) && row.latest.to >= row.start.to && row.latest.totalTokens >= row.start.totalTokens && row.latest.usedPercent >= row.start.usedPercent)
        .map((row: QuotaBaseline) => ({ start: cleanMeter(row.start), latest: cleanMeter(row.latest) }));
      return data.observations.filter(observation).map(clean);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.baselines = []; this.cycleStarts = []; return []; } throw error; }
  }
  /** Compute counts against the current persisted start while holding the shared storage lock. */
  capture(ticks: QuotaTick[], sample: (starts: QuotaCycleStart[]) => { observations?: QuotaObservation[]; meters?: QuotaMeter[] }): Promise<QuotaObservation[]> {
    return this.record([], [], ticks, sample);
  }
  async record(incoming: QuotaObservation[] = [], meters: QuotaMeter[] = [], ticks: QuotaTick[] = [], sample?: (starts: QuotaCycleStart[]) => { observations?: QuotaObservation[]; meters?: QuotaMeter[] }): Promise<QuotaObservation[]> {
    return withStorageLock(this.directory, async () => {
      const previous = await this.load(), priorBaselines = this.baselines;
      const cycleStarts = observeQuotaCycleStarts(this.cycleStarts, ticks);
      const captured = sample?.(cycleStarts);
      const observed = observeQuotaMeters(priorBaselines, [...meters, ...(captured?.meters ?? [])].filter(meter).map(cleanMeter));
      const rows = mergeQuotaObservations(previous, [...incoming, ...(captured?.observations ?? []), ...observed.observations].filter(observation).map(clean));
      if (JSON.stringify(rows) !== JSON.stringify(previous) || JSON.stringify(observed.baselines) !== JSON.stringify(priorBaselines) || JSON.stringify(cycleStarts) !== JSON.stringify(this.cycleStarts)) {
        const temporary = path.join(this.directory, `quota-history-${randomUUID()}.tmp`);
        try { await writeFile(temporary, JSON.stringify({ version: 1, observations: rows, baselines: observed.baselines, cycleStarts }), { flag: 'wx' }); await rename(temporary, path.join(this.directory, 'quota-history.json')); }
        finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
      }
      this.baselines = observed.baselines;
      this.cycleStarts = cycleStarts;
      return rows;
    });
  }
}
