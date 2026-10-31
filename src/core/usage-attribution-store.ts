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
    // Exact response corrections take priority over broad dates/conversations.
    // Keep them in a separate file so older extensions cannot silently drop the
    // response scope and reassign the entire conversation to its last account.
    const [general, responses] = await Promise.all([this.readAssignments(false), this.readAssignments(true)]);
    return [...general, ...responses];
  }
  private async readAssignments(responses: boolean): Promise<UsageAssignment[]> {
    let content: string;
    try { content = await readFile(path.join(this.directory, responses ? 'response-assignments.json' : 'assignments.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const rows: unknown = JSON.parse(content);
    if (!Array.isArray(rows)) throw new Error('History assignments could not be read.');
    return rows.map(row => {
      const a = row?.account;
      const account = a && usageAccount(a.provider, { signedIn: true, id: a.nativeAccountId, email: a.email, organization: a.organization, method: a.method });
      if (!row || typeof row.id !== 'string' || !/^[a-f0-9-]{36}$/.test(row.id) || !validAssignmentScope(row) || responses !== (row.responseIds !== undefined) || (a !== null && (!account || account.provider !== row.provider))) throw new Error('Invalid history assignment.');
      return { id: row.id, provider: row.provider, conversationId: row.conversationId, from: row.from, to: row.to, account: account ?? null,
        ...(row.responseIds ? { responseIds: [...row.responseIds] } : {}) };
    });
  }
  private async save(rows: UsageAssignment[], responses: boolean) {
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, responses ? 'response-assignments.json' : 'assignments.json'), temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(rows), { flag: 'wx' }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  async assign(scope: UsageAssignmentScope, account: UsageAccount | null) {
    if (!validAssignmentScope(scope)) throw new Error('Choose a conversation or a valid date range.');
    const clean = account && usageAccount(account.provider, { signedIn: true, id: account.nativeAccountId, email: account.email, organization: account.organization, method: account.method });
    if (account && (!clean || clean.provider !== scope.provider)) throw new Error('Choose an account for this provider.');
    return withStorageLock(this.directory, async () => {
      const row: UsageAssignment = { id: randomUUID(), provider: scope.provider, conversationId: scope.conversationId, from: scope.from, to: scope.to, account: clean ?? null,
        ...(scope.responseIds ? { responseIds: [...scope.responseIds] } : {}) };
      const responses = !!row.responseIds;
      await this.save([...(await this.read()).filter(entry => !!entry.responseIds === responses), row], responses); return row;
    });
  }
  async remove(id: string) {
    return withStorageLock(this.directory, async () => {
      const rows = await this.read();
      const selected = rows.find(row => row.id === id);
      if (!selected) throw new Error('This history assignment no longer exists.');
      const responses = !!selected.responseIds;
      await this.save(rows.filter(row => row.id !== id && !!row.responseIds === responses), responses);
    });
  }
}
