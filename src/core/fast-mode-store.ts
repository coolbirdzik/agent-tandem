import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fastMode } from '../providers/fast-mode';

/** Per-project preference; does not modify the user's shared Codex config. */
export class FastModeStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  private filename(project: string) {
    const resolved = path.resolve(project);
    return path.join(this.directory, `${createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex')}.json`);
  }
  private async load(project: string): Promise<boolean> {
    try { return JSON.parse(await readFile(this.filename(project), 'utf8'))?.enabled === true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.queue.then(operation); this.queue = job.catch(() => undefined); return job;
  }
  read(project: string) { return this.serial(() => this.load(project)); }
  save(project: string, enabled: boolean) { return this.serial(async () => {
    const validated = fastMode(enabled);
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.filename(project)}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ enabled: validated }), { flag: 'wx' }); await rename(temporary, this.filename(project)); }
    finally { await unlink(temporary).catch(() => undefined); }
    return validated;
  }); }
}
