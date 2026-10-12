import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ContextUsage } from '../providers/context-usage';

interface SavedUsage { key: string; usage: ContextUsage; observedAt: number; revision?: string }
export class ContextStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  private filename(project: string) {
    const resolved = path.resolve(project);
    return path.join(this.directory, `${createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex')}.json`);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.queue.then(operation); this.queue = job.catch(() => undefined); return job;
  }
  private async load(project: string): Promise<SavedUsage[]> {
    let rows;
    try { rows = JSON.parse(await readFile(this.filename(project), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return []; throw error; }
    if (!Array.isArray(rows)) return [];
    return rows.slice(-200).flatMap(row => {
      if (!row || typeof row.key !== 'string' || !/^(Codex|Claude):[^\x00-\x1f]{1,256}$/.test(row.key) || !Number.isFinite(row.observedAt) || !row.usage || typeof row.usage !== 'object') return [];
      const usage: ContextUsage = {};
      for (const key of ['usedTokens', 'windowTokens', 'cachedTokens', 'updatedAt', 'cacheTtlMs', 'cacheExpiresAt'] as const) {
        const count = row.usage[key]; if (typeof count === 'number' && Number.isFinite(count) && count >= 0) usage[key] = count;
      }
      for (const key of ['model', 'selectedModel'] as const) if (typeof row.usage[key] === 'string' && row.usage[key].length <= 256) usage[key] = row.usage[key];
      return usage.usedTokens === undefined ? [] : [{ key: row.key, usage, observedAt: row.observedAt, ...(typeof row.revision === 'string' ? { revision: row.revision } : {}) }];
    });
  }
  read(project: string, key: string, revision: string, updatedAt: number) { return this.serial(async () => {
    const saved = (await this.load(project)).find(row => row.key === key);
    return saved && (saved.revision === revision || (!saved.revision && updatedAt <= saved.observedAt)) ? saved.usage : undefined;
  }); }
  save(project: string, key: string, usage: ContextUsage, revision?: string) { return this.serial(async () => {
    const rows = (await this.load(project)).filter(row => row.key !== key);
    rows.push({ key, usage, revision, observedAt: Date.now() });
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.filename(project)}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(rows.slice(-200)), { flag: 'wx' }); await rename(temporary, this.filename(project)); }
    finally { await unlink(temporary).catch(() => undefined); }
  }); }
}
