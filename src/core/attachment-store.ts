import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chatAttachments, type ChatAttachment } from './attachments';
export interface PreparedAttachment extends ChatAttachment { path: string }
/** Uploaded bytes are immutable and live outside review snapshots and user projects. */
export class AttachmentStore {
  readonly directory: string;
  constructor(storage: string) { this.directory = path.join(storage, 'attachments'); }
  async prepare(items: ChatAttachment[] = []): Promise<PreparedAttachment[]> {
    const valid = chatAttachments(items); if (!valid.length) return [];
    await mkdir(this.directory, { recursive: true });
    return Promise.all(valid.map(async item => {
      const bytes = Buffer.from(item.data, 'base64'), hash = createHash('sha256').update(bytes).digest('hex');
      const name = item.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100).replace(/^\.+/, '') || 'attachment';
      const file = path.join(this.directory, `${hash}-${name}`);
      try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      return { ...item, path: file };
    }));
  }
}
