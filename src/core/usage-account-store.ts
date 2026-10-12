import { mkdir, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { usageAccount, type UsageAccount } from './usage-account';

/** Account evidence for a native response/turn, never for an entire conversation.
 * Append-only so older attribution survives resume, forks, reload and account switches.
 */
export class UsageAccountStore {
  private rows = new Map<string, UsageAccount | null>();
  private loaded?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}
  private async load() {
    let content: string;
    try { content = await readFile(path.join(this.directory, 'accounts.jsonl'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const line of content.split('\n')) {
      try {
        const row = JSON.parse(line);
        if (!this.validKey(row.key)) continue;
        const a = row.account;
        const account = a && usageAccount(a.provider, { signedIn: true, id: a.nativeAccountId, email: a.email, organization: a.organization, method: a.method });
        if (a !== null && (!account || !['Codex', 'Claude'].includes(a.provider) || !row.key.startsWith(`${a.provider}:`))) continue;
        const previous = this.rows.get(row.key);
        this.rows.set(row.key, previous === null || (previous && previous.id !== account?.id) ? null : account ?? null);
      } catch { /* A truncated/corrupt line carries no account evidence. */ }
    }
  }
  private validKey(key: unknown): key is string { return typeof key === 'string' && /^(Codex|Claude):[^\x00-\x1f]{1,512}$/.test(key); }
  record(key: string, account: UsageAccount): Promise<void> {
    // Rebuild the allowlist rather than persisting arbitrary fields supplied by callers.
    const clean = usageAccount(account.provider, { signedIn: true, id: account.nativeAccountId, email: account.email, organization: account.organization, method: account.method });
    if (!clean || !['Codex', 'Claude'].includes(account.provider)) return Promise.resolve();
    account = clean;
    const job = this.queue.then(async () => {
      await (this.loaded ??= this.load());
      if (!this.validKey(key) || !key.startsWith(`${account.provider}:`)) return;
      const previous = this.rows.get(key);
      if (previous === null || previous?.id === account.id) return;
      // Conflicting evidence stays unknown rather than moving old tokens to a new login.
      const value = previous ? null : account;
      await mkdir(this.directory, { recursive: true });
      await appendFile(path.join(this.directory, 'accounts.jsonl'), JSON.stringify({ key, account: value }) + '\n', 'utf8');
      this.rows.set(key, value);
    });
    this.queue = job.catch(() => undefined); return job;
  }
  async read(): Promise<ReadonlyMap<string, UsageAccount | null>> {
    await this.queue; await (this.loaded ??= this.load()); return new Map(this.rows);
  }
}
