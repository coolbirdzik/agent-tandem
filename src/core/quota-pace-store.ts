import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withStorageLock } from './storage-lock';
import type { QuotaTick } from './quota-pace';
const tickKey = (row: QuotaTick) => JSON.stringify([row.provider, row.accountId, row.plan, row.windowId, row.resetsAt]);
function valid(row: any): row is QuotaTick {
  return row && ['Codex', 'Claude'].includes(row.provider) && ['accountId', 'plan', 'windowId', 'label'].every(key => typeof row[key] === 'string') &&
    [row.at, row.resetsAt, row.usedPercent].every(Number.isFinite) && row.at > 0 && row.at < row.resetsAt && row.usedPercent >= 0 && row.usedPercent <= 100;
}
export class QuotaPaceStore {
  constructor(readonly root: string) {}
  async record(incoming: QuotaTick[] = [], now = Date.now()): Promise<QuotaTick[]> {
    return withStorageLock(this.root, async () => {
      const file = path.join(this.root, 'quota-pace.json'); let previous: QuotaTick[] = [];
      try { const data = JSON.parse(await readFile(file, 'utf8')); if (!Array.isArray(data)) throw new Error('Invalid quota pace history.'); previous = data.filter(valid); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const rows = new Map<string, QuotaTick>();
      for (const row of [...previous, ...incoming]) if (valid(row) && row.at <= now && row.at >= now - 28 * 86400000) {
        const clean: QuotaTick = { provider: row.provider, accountId: row.accountId, plan: row.plan, windowId: row.windowId, label: row.label, resetsAt: row.resetsAt, at: row.at, usedPercent: row.usedPercent };
        rows.set(`${tickKey(row)}:${row.at}`, clean);
      }
      const result = [...rows.values()].sort((a, b) => a.at - b.at).slice(-40000);
      if (JSON.stringify(result) !== JSON.stringify(previous)) {
        const temp = `${file}.${randomUUID()}.tmp`;
        try { await writeFile(temp, JSON.stringify(result), { flag: 'wx' }); await rename(temp, file); } finally { await unlink(temp).catch(() => undefined); }
      }
      return result;
    });
  }
}
