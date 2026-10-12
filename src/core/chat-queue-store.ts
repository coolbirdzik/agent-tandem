import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
export class ChatQueueStore {
  private file: string;
  private pending: Promise<void> = Promise.resolve();
  constructor(storage: string, workspace: string) { this.file = path.join(storage, 'queues', `${createHash('sha256').update(workspace).digest('hex')}.json`); }
  async read(): Promise<unknown> {
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return []; throw error; }
  }
  save(snapshot: unknown): Promise<void> {
    const data = JSON.stringify(snapshot);
    const job = this.pending.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try { await writeFile(temp, data, { flag: 'wx' }); await rename(temp, this.file); }
      finally { await unlink(temp).catch(() => undefined); }
    });
    this.pending = job; return job;
  }
}
