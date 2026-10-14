import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { usageAccount, type UsageAccount } from './usage-account';
import { withStorageLock } from './storage-lock';
import { validAssignmentScope, type UsageAssignment, type UsageAssignmentScope } from './usage-attribution';
export { validAssignmentScope, matchingAssignment, type UsageAssignment, type UsageAssignmentScope, type KnownUsageAccount } from './usage-attribution';
/** Reversible user choices are separate from append-only native turn evidence. */
export class UsageAttributionStore {
  constructor(readonly directory: string) {}
  async read(): Promise<UsageAssignment[]> {
    let content: string;
    try { content = await readFile(path.join(this.directory, 'assignments.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const rows: unknown = JSON.parse(content);
    if (!Array.isArray(rows)) throw new Error('History assignments could not be read.');
    return rows.map(row => {
      const a = row?.account;
      const account = a && usageAccount(a.provider, { signedIn: true, id: a.nativeAccountId, email: a.email, organization: a.organization, method: a.method });
      if (!row || typeof row.id !== 'string' || !/^[a-f0-9-]{36}$/.test(row.id) || !validAssignmentScope(row) || (a !== null && (!account || account.provider !== row.provider))) throw new Error('Invalid history assignment.');
      return { id: row.id, provider: row.provider, conversationId: row.conversationId, from: row.from, to: row.to, account: account ?? null };
    });
  }
  private async save(rows: UsageAssignment[]) {
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, 'assignments.json'), temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(rows), { flag: 'wx' }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  async assign(scope: UsageAssignmentScope, account: UsageAccount | null) {
    if (!validAssignmentScope(scope)) throw new Error('Choose a conversation or a valid date range.');
    const clean = account && usageAccount(account.provider, { signedIn: true, id: account.nativeAccountId, email: account.email, organization: account.organization, method: account.method });
    if (account && (!clean || clean.provider !== scope.provider)) throw new Error('Choose an account for this provider.');
    return withStorageLock(this.directory, async () => {
      const row: UsageAssignment = { id: randomUUID(), provider: scope.provider, conversationId: scope.conversationId, from: scope.from, to: scope.to, account: clean ?? null };
      await this.save([...(await this.read()), row]); return row;
    });
  }
  async remove(id: string) {
    return withStorageLock(this.directory, async () => {
      const rows = await this.read();
      if (!rows.some(row => row.id === id)) throw new Error('This history assignment no longer exists.');
      await this.save(rows.filter(row => row.id !== id));
    });
  }
}
