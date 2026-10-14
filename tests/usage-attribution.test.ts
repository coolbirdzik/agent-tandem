import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UsageAttributionStore } from '../src/core/usage-attribution-store';
import { usageAccount } from '../src/core/usage-account';
import { UsageAccountStore } from '../src/core/usage-account-store';
import { UsageHistory } from '../src/providers/usage-history';
import { usageBreakdown } from '../src/core/usage-dashboard';
import { knownUsageAccounts } from '../src/providers/usage-account-identities';
import { AccountProfiles } from '../src/core/account-profiles';
import { quotaEstimates } from '../src/core/quota-estimate';

const one = usageAccount('Codex', { signedIn: true, email: 'one@test.invalid', id: 'workspace-one', method: 'ChatGPT' })!;
const two = usageAccount('Codex', { signedIn: true, email: 'two@test.invalid', id: 'workspace-two', method: 'ChatGPT' })!;
const stamp = '2026-10-14T08:00:00Z';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-attribution-')); roots.push(root);
  const homes = { codex: path.join(root, 'codex'), claude: path.join(root, 'claude') }, cache = path.join(root, 'cache');
  const store = new UsageAttributionStore(path.join(root, 'usage')), ledger = new UsageAccountStore(store.directory);
  const options = { store, knownAccounts: async () => [{ account: one, nativeAccountIds: ['creator-one'] }, { account: two, nativeAccountIds: ['creator-two'] }] };
  const write = async (name: string, creator: string, response = name, date = stamp) => {
    const file = path.join(homes.codex, 'sessions', `${name}.jsonl`); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, [
      { type: 'session_meta', payload: { id: name, creator_account_id: creator } },
      { type: 'turn_context', payload: { turn_id: `turn-${response}`, model: 'model' } },
      { timestamp: date, type: 'token_usage_record', payload: { response_id: response, usage: { input_tokens: 100, output_tokens: 10 } } },
    ].map(row => JSON.stringify(row)).join('\n'));
    return file;
  };
  return { root, homes, cache, store, ledger, options, write, history: new UsageHistory(homes, ledger, cache, options) };
}
describe('Restoring historical account attribution', () => {
  it('reapplies inferred and reversible manual choices on disk/memory cache while native turns take priority', async () => {
    const f = await fixture(); await f.write('first', 'creator-one'); await f.write('second', 'creator-one');
    await f.ledger.record('Codex:turn:turn-second', two);
    const first = await f.history.read();
    expect(first.days.find(row => row.account?.id === one.id)?.accountSource).toBe('inferred');
    expect(first.days.find(row => row.account?.id === two.id)?.accountSource).toBeUndefined();
    const assignment = await f.store.assign({ provider: 'Codex', from: '2026-10-14', to: '2026-10-14' }, two);
    const reload = new UsageHistory(f.homes, f.ledger, f.cache, f.options);
    const manual = await reload.read(); expect(reload.readStats?.diskHits).toBe(2);
    expect(usageBreakdown(manual.days, { grouping: 'day', accountId: two.id }).totals.total).toBe(220);
    expect(manual.days.some(row => row.accountSource === 'manual')).toBe(true);
    expect(manual.days.some(row => !row.accountSource)).toBe(true);
    await f.store.remove(assignment.id);
    expect((await reload.read()).days).toEqual(first.days); expect(reload.readStats?.memoryHits).toBe(2);
  });
  it('lets users suppress inference and edit overlapping choices without touching history or counts', async () => {
    const f = await fixture(), file = await f.write('first', 'creator-one'); const original = await readFile(file, 'utf8');
    const assigned = await f.store.assign({ provider: 'Codex', conversationId: 'first' }, two);
    const unknown = await f.store.assign({ provider: 'Codex', conversationId: 'first' }, null);
    const data = await f.history.read(); expect(data.days[0]?.account).toBeUndefined(); expect(data.days[0]?.accountSource).toBe('manual');
    await new UsageAttributionStore(f.store.directory).remove(unknown.id);
    expect((await f.history.read()).days[0]?.account?.id).toBe(two.id);
    await f.store.remove(assigned.id);
    expect((await f.history.read()).days[0]).toMatchObject({ total: 110, account: one, accountSource: 'inferred' });
    expect(await readFile(file, 'utf8')).toBe(original);
  });
  it('matches provider, session and inclusive dates without capturing unrelated history', async () => {
    const f = await fixture(); await f.write('first', 'missing'); await f.write('second', 'missing'); await f.write('old', 'missing', 'old', '2026-10-12T08:00:00Z');
    await f.store.assign({ provider: 'Codex', conversationId: 'first', from: '2026-10-14', to: '2026-10-14' }, one);
    let data = await f.history.read(); expect(usageBreakdown(data.days, { grouping: 'day', accountId: one.id }).totals.total).toBe(110);
    await f.store.assign({ provider: 'Claude', from: '2026-10-14', to: '2026-10-14' }, null);
    data = await f.history.read(); expect(usageBreakdown(data.days, { grouping: 'day', accountId: 'unknown' }).totals.total).toBe(220);
  });
  it('keeps ambiguous creator IDs and contradictory fork metadata unknown and deduplicates usage', async () => {
    const f = await fixture(); await f.write('first', 'creator-one', 'same'); await f.write('fork', 'creator-two', 'same'); await f.write('missing', 'missing');
    const data = await f.history.read(); expect(data.days.every(row => !row.account)).toBe(true); expect(data.duplicates).toBe(1);
    expect(usageBreakdown(data.days, { grouping: 'day' }).totals.total).toBe(220);
    const ambiguous = new UsageHistory(f.homes, f.ledger, f.cache, { store: f.store, knownAccounts: async () => [{ account: one, nativeAccountIds: ['missing'] }, { account: two, nativeAccountIds: ['missing'] }] });
    expect((await ambiguous.read()).days.every(row => !row.account)).toBe(true);
  });
  it('serializes separate store instances, validates scope and refuses corrupt persisted assignments', async () => {
    const f = await fixture(), second = new UsageAttributionStore(f.store.directory);
    await Promise.all([f.store.assign({ provider: 'Codex', conversationId: 'first' }, one), second.assign({ provider: 'Codex', conversationId: 'second' }, two)]);
    expect(await f.store.read()).toHaveLength(2);
    await expect(f.store.assign({ provider: 'Claude', conversationId: 'first' }, one)).rejects.toThrow('provider');
    for (const scope of [{ provider: 'Codex' as const }, { provider: 'Codex' as const, from: '2026-02-30', to: '2026-03-01' }, { provider: 'Codex' as const, from: '2026-10-14', to: '2026-10-13' }]) await expect(f.store.assign(scope, one)).rejects.toThrow('valid date');
    await writeFile(path.join(f.store.directory, 'assignments.json'), '{broken');
    await expect(second.assign({ provider: 'Codex', conversationId: 'third' }, one)).rejects.toThrow();
    expect(await readFile(path.join(f.store.directory, 'assignments.json'), 'utf8')).toBe('{broken');
  });
  it('aliases native auth account IDs only to matching identities and exports no credentials', async () => {
    const f = await fixture(), profiles = new AccountProfiles(path.join(f.root, 'profiles'));
    const profile = await profiles.create('Codex'); await profiles.identify(profile.id, { signedIn: true, email: one.email, id: one.nativeAccountId, method: one.method });
    const authFile = path.join(profiles.home(profile.id), 'auth.json');
    const auth = (email: string) => JSON.stringify({ tokens: { account_id: 'creator-one', id_token: `header.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.signature`, refresh_token: 'PRIVATE-SECRET' } });
    await writeFile(authFile, auth(one.email));
    const known = await knownUsageAccounts(profiles); expect(known[0]?.nativeAccountIds).toEqual(['workspace-one', 'creator-one']);
    expect(JSON.stringify(known)).not.toContain('PRIVATE-SECRET'); expect(JSON.stringify(known)).not.toContain('id_token');
    await writeFile(authFile, auth(two.email)); expect((await knownUsageAccounts(profiles))[0]?.nativeAccountIds).toEqual(['workspace-one']);
  });
  it('keeps restored history out of native-only Local quota estimates while retaining Device coverage', () => {
    const now = Date.parse(stamp), from = now - 3600000;
    const data = { days: [], updatedAt: now, files: 1, unreadableFiles: 0, malformedLines: 0, oversizedLines: 0, undatedRecords: 0, duplicates: 0, timezone: 'UTC', recent: [
      { provider: 'Codex' as const, timestamp: from, total: 100, accountId: one.id },
      { provider: 'Codex' as const, timestamp: from, total: 200, accountId: two.id, accountSource: 'inferred' as const },
      { provider: 'Codex' as const, timestamp: from, total: 300, accountId: one.id, accountSource: 'manual' as const },
    ] };
    const account = { status: 'ready' as const, updatedAt: now, account: { signedIn: true, email: one.email, id: one.nativeAccountId, method: one.method }, quota: { status: 'available' as const, windows: [{ id: '5h', label: '5h', usedPercent: 25, resetsAt: now + 3600000 }] } };
    expect(quotaEstimates('Codex', account, data, now)[0]?.observedTokens).toBe(100);
    expect(quotaEstimates('Codex', account, data, now, 'Device')[0]?.observedTokens).toBe(600);
  });
});
