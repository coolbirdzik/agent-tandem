import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
export interface UISelection { project?: string; conversation?: string }
/** Durable per-workspace preferences, also flushed in short-lived Extension Hosts. */
export class UISelectionStore {
  private pending: Promise<void> = Promise.resolve();
  private file: string;
  constructor(storage: string, workspace: string) {
    this.file = path.join(storage, 'preferences', `${createHash('sha256').update(workspace).digest('hex')}.json`);
  }
  async read(): Promise<UISelection> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      return { project: typeof value.project === 'string' ? value.project : undefined, conversation: typeof value.conversation === 'string' ? value.conversation : undefined };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return {}; throw error; }
  }
  save(selection: UISelection): Promise<void> {
    const content = JSON.stringify(selection);
    const work = this.pending.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, content); await rename(temp, this.file);
    });
    this.pending = work; return work;
  }
}
