import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { modelId } from '../providers/models';
import { effortId, defaultEfforts, type SelectedEfforts } from '../providers/effort';
import type { ConversationProvider } from '../providers/conversations';

export class EffortStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  private filename(project: string) {
    const resolved = path.resolve(project);
    return path.join(this.directory, `${createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex')}.json`);
  }
  private async load(project: string): Promise<SelectedEfforts> {
    const result = defaultEfforts();
    let value;
    try { value = JSON.parse(await readFile(this.filename(project), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return result; throw error; }
    for (const provider of ['Codex', 'Claude'] as const) {
      const rows = value?.[provider];
      if (!rows || typeof rows !== 'object' || Array.isArray(rows)) continue;
      result[provider] = Object.fromEntries(Object.entries(rows).flatMap(([model, effort]) => {
        try { return [[modelId(model), effortId(effort)]]; } catch { return []; }
      }));
    }
    return result;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.queue.then(operation); this.queue = job.catch(() => undefined); return job;
  }
  read(project: string) { return this.serial(() => this.load(project)); }
  save(project: string, provider: ConversationProvider, model: string, effort: string) { return this.serial(async () => {
    const validated = effortId(effort), key = modelId(model), value = await this.load(project);
    value[provider] = { ...value[provider], [key]: validated };
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.filename(project)}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx' }); await rename(temporary, this.filename(project)); }
    finally { await unlink(temporary).catch(() => undefined); }
    return value;
  }); }
}
