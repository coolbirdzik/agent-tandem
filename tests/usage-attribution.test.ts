import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UsageAttributionStore } from '../src/core/usage-attribution-store';
import { claudeHistoryOwner, usageAccount } from '../src/core/usage-account';
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
  const claudeOne = usageAccount('Claude', { signedIn: true, email: one.email, method: 'Claude account', organization: 'org-one' })!;
  const claudeTwo = usageAccount('Claude', { signedIn: true, email: two.email, method: 'Claude account', organization: 'org-two' })!;
  const message = (id: string, sessionId: string) => ({ type: 'assistant', timestamp: stamp, sessionId, message: { id, model: 'sonnet', usage: { input_tokens: 100, output_tokens: 10 } } });
  const owner = (sessionId: string, id = 'owner-one', organization = 'org-one') => ({ type: 'bridge-session', sessionId, ownerAccountUuid: id, ownerOrganizationUuid: organization });
  async function claudeFile(f: Awaited<ReturnType<typeof fixture>>, name: string, rows: unknown[]) {
    const file = path.join(f.homes.claude, 'projects', name + '.jsonl');
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n'));
  }
  const claudeOptions = (f: Awaited<ReturnType<typeof fixture>>) => ({ store: f.store, knownAccounts: async () => [
    { account: claudeOne, nativeAccountIds: [claudeHistoryOwner('owner-one', 'org-one')!] },
    { account: claudeTwo, nativeAccountIds: [claudeHistoryOwner('owner-two', 'org-two')!] },
  ] });
  it('restores Claude bridge owner identities even when metadata follows usage and reapplies them from cache', async () => {
    const f = await fixture();
    await claudeFile(f, 'main', [message('main', 'bridge'), owner('bridge')]);
    await claudeFile(f, 'child', [message('child', 'bridge')]);
    await claudeFile(f, 'outside', [message('outside', 'external')]);
    const options = claudeOptions(f), history = new UsageHistory(f.homes, f.ledger, f.cache, options);
    const first = await history.read();
    expect(usageBreakdown(first.days, { grouping: 'day', accountId: claudeOne.id }).totals.total).toBe(220);
    expect(first.days.find(row => row.account)?.accountSource).toBe('inferred');
    expect(usageBreakdown(first.days, { grouping: 'day', accountId: 'unknown' }).totals.total).toBe(110);
    const reload = new UsageHistory(f.homes, f.ledger, f.cache, options);
    expect((await reload.read()).days).toEqual(first.days); expect(reload.readStats?.diskHits).toBe(3);
    const assignment = await f.store.assign({ provider: 'Claude', conversationId: 'bridge' }, claudeTwo);
    expect((await reload.read()).days.find(row => row.account)?.account).toEqual(claudeTwo);
    await f.store.remove(assignment.id); expect((await reload.read()).days).toEqual(first.days);
  });
  it('never extends a Claude response account to unrecorded responses and keeps mismatched owners and conflicts unknown', async () => {
    const f = await fixture(), options = claudeOptions(f);
    await f.ledger.record('Claude:native', claudeOne);
    await claudeFile(f, 'main', [message('native', 'main'), message('unrecorded', 'main')]);
    const history = new UsageHistory(f.homes, f.ledger, f.cache, options);
    let data = await history.read();
    expect(data.days.filter(row => row.accountSource === 'inferred')).toHaveLength(0);
    expect(usageBreakdown(data.days, { grouping: 'day', accountId: 'unknown' }).totals.total).toBe(110);
    await f.ledger.record('Claude:switched', claudeTwo);
    await claudeFile(f, 'switch', [message('switched', 'main')]);
    await claudeFile(f, 'mismatch', [message('mismatch', 'mismatch'), owner('mismatch', 'owner-one', 'wrong-org')]);
    await claudeFile(f, 'conflict', [message('conflict', 'conflict'), owner('conflict'), owner('conflict', 'owner-two', 'org-two')]);
    data = await history.read();
    expect(data.days.filter(row => row.accountSource === 'inferred')).toHaveLength(0);
    expect(usageBreakdown(data.days, { grouping: 'day', accountId: 'unknown' }).totals.total).toBe(330);
    expect(data.days.filter(row => row.account).reduce((sum, row) => sum + row.total, 0)).toBe(220);
  });
  it('separates Claude responses in a resumed conversation despite a broad manual date assignment and cache reloads', async () => {
    const f = await fixture(), options = claudeOptions(f);
    await claudeFile(f, 'resumed', [message('first', 'shared'), message('second', 'shared'), message('unrecorded', 'shared')]);
    await f.ledger.record('Claude:first', claudeOne);
    await f.ledger.record('Claude:second', claudeTwo);
    const history = new UsageHistory(f.homes, f.ledger, f.cache, options);
    const first = await history.read();
    expect(first.conversations).toHaveLength(1);
    for (const accountId of [claudeOne.id, claudeTwo.id, 'unknown']) {
      expect(usageBreakdown(first.days, { grouping: 'day', accountId }).totals.total).toBe(110);
    }
    await f.store.assign({ provider: 'Claude', from: '2026-10-14', to: '2026-10-14' }, claudeOne);
    const reload = new UsageHistory(f.homes, new UsageAccountStore(f.ledger.directory), f.cache, options);
    const manual = await reload.read(); expect(reload.readStats?.diskHits).toBe(1);
    expect(usageBreakdown(manual.days, { grouping: 'day', accountId: claudeOne.id }).totals.total).toBe(220);
    expect(usageBreakdown(manual.days, { grouping: 'day', accountId: claudeTwo.id }).totals.total).toBe(110);
    expect(manual.conversations![0]!.days.reduce((sum, row) => sum + row.total, 0)).toBe(330);
    expect((await reload.read()).days).toEqual(manual.days); expect(reload.readStats?.memoryHits).toBe(1);
  });
  it('persists user-confirmed Claude response splits separately from legacy date assignments and keeps native evidence first', async () => {
    const f = await fixture(), options = claudeOptions(f);
    await claudeFile(f, 'split', [message('before', 'shared'), message('after', 'shared'), message('native', 'shared'), message('later', 'shared')]);
    const baseline = await f.store.assign({ provider: 'Claude', from: '2026-10-14', to: '2026-10-14' }, claudeOne);
    const legacyFile = path.join(f.store.directory, 'assignments.json'), original = await readFile(legacyFile, 'utf8');
    const before = await f.store.assign({ provider: 'Claude', conversationId: 'shared', responseIds: ['Claude:before', 'Claude:native'] }, claudeOne);
    const after = await f.store.assign({ provider: 'Claude', conversationId: 'shared', responseIds: ['Claude:after'] }, claudeTwo);
    expect(await readFile(legacyFile, 'utf8')).toBe(original);
    await f.ledger.record('Claude:native', claudeTwo);
    const history = new UsageHistory(f.homes, f.ledger, f.cache, options);
    const check = (data: Awaited<ReturnType<UsageHistory['read']>>) => {
      expect(usageBreakdown(data.days, { grouping: 'day', accountId: claudeOne.id }).totals.total).toBe(220);
      expect(usageBreakdown(data.days, { grouping: 'day', accountId: claudeTwo.id }).totals.total).toBe(220);
      expect(data.days.filter(row => row.account?.id === claudeTwo.id && !row.accountSource).map(row => row.total)).toEqual([110]);
      expect(data.assignments?.find(row => row.id === after.id)?.responseIds).toEqual(['Claude:after']);
    };
    check(await history.read()); check(await history.read());
    const reload = new UsageHistory(f.homes, new UsageAccountStore(f.ledger.directory), f.cache, { store: new UsageAttributionStore(f.store.directory), knownAccounts: options.knownAccounts });
    check(await reload.read()); expect(reload.readStats?.diskHits).toBe(1);
    await f.store.remove(baseline.id);
    const data = await reload.read();
    expect(usageBreakdown(data.days, { grouping: 'day', accountId: 'unknown' }).totals.total).toBe(110);
    await f.store.remove(after.id); await f.store.remove(before.id);
    expect(await f.store.read()).toEqual([]);
    for (const responseIds of [[], ['Codex:wrong-provider'], ['Claude:duplicate', 'Claude:duplicate'], ['Claude:bad\nkey']]) {
      await expect(f.store.assign({ provider: 'Claude', conversationId: 'shared', responseIds }, claudeOne)).rejects.toThrow();
    }
    await expect(f.store.assign({ provider: 'Claude', from: '2026-10-14', to: '2026-10-14', responseIds: ['Claude:before'] }, claudeOne)).rejects.toThrow();
  });
  it('reads Claude account aliases from matching native metadata without exporting unrelated metadata', async () => {
    const f = await fixture(), profiles = new AccountProfiles(path.join(f.root, 'profiles'));
    const profile = await profiles.create('Claude');
    await profiles.identify(profile.id, { signedIn: true, email: claudeOne.email, organization: 'org-one', method: 'Claude account' });
    const file = path.join(profiles.home(profile.id), '.claude.json');
    const metadata = (emailAddress: string, organizationUuid = 'org-one') => JSON.stringify({ oauthAccount: { emailAddress, accountUuid: 'owner-one', organizationUuid }, privateData: 'PRIVATE-METADATA' });
    await writeFile(file, metadata(claudeOne.email));
    const known = (await knownUsageAccounts(profiles)).find(row => row.account.id === claudeOne.id)!;
    expect(known.nativeAccountIds).toContain(claudeHistoryOwner('owner-one', 'org-one'));
    expect(JSON.stringify(known)).not.toContain('PRIVATE-METADATA');
    await writeFile(file, metadata(claudeTwo.email));
    expect((await knownUsageAccounts(profiles)).find(row => row.account.id === claudeOne.id)?.nativeAccountIds).toEqual([]);
    await writeFile(file, metadata(claudeOne.email, 'wrong-org'));
    expect((await knownUsageAccounts(profiles)).find(row => row.account.id === claudeOne.id)?.nativeAccountIds).toEqual([]);
  });
  it('infers the sole known Claude account for sessions without native evidence, but not once a second identity is known', async () => {
    const f = await fixture();
    await claudeFile(f, 'plain', [message('plain', 'plain')]);
    const sole = await new UsageHistory(f.homes, f.ledger, f.cache, { store: f.store, knownAccounts: async () => [{ account: claudeOne, nativeAccountIds: [] }, { account: claudeOne, nativeAccountIds: [] }] }).read();
    expect(sole.days[0]).toMatchObject({ total: 110, account: claudeOne, accountSource: 'inferred' });
    expect((await new UsageHistory(f.homes, f.ledger, f.cache, claudeOptions(f)).read()).days[0]?.account).toBeUndefined();
    await f.ledger.record('Claude:other', claudeTwo);
    await claudeFile(f, 'other', [message('other', 'other')]);
    const seen = await new UsageHistory(f.homes, f.ledger, f.cache, { store: f.store, knownAccounts: async () => [{ account: claudeOne, nativeAccountIds: [] }] }).read();
    expect(seen.conversations?.find(row => row.id === 'plain')?.days[0]?.account).toBeUndefined();
  });
  it('matches Claude bridge owners by organization name and recovers legacy signed-out profiles', async () => {
    const f = await fixture(), profiles = new AccountProfiles(path.join(f.root, 'profiles')), profile = await profiles.create('Claude');
    const named = usageAccount('Claude', { signedIn: true, email: claudeOne.email, method: 'Claude account', organization: 'Org One' })!;
    await profiles.identify(profile.id, { signedIn: true, email: claudeOne.email, organization: 'Org One', method: 'Claude account' });
    await writeFile(path.join(profiles.home(profile.id), '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: claudeOne.email, accountUuid: 'owner-one', organizationUuid: 'org-one', organizationName: 'Org One' } }));
    expect((await knownUsageAccounts(profiles)).find(row => row.account.id === named.id)?.nativeAccountIds).toEqual([claudeHistoryOwner('owner-one', 'org-one')]);
    await expect(profiles.identify(profile.id, { signedIn: false, method: 'Claude account' })).rejects.toThrow('expired');
    expect((await profiles.get(profile.id)).identity).toMatchObject({ signedIn: true, email: claudeOne.email, organization: 'Org One' });
    // Older refreshes erased saved identities. Seed that persisted state directly;
    // identify() now protects known identities from signed-out refresh results.
    const saved = await profiles.read();
    saved.profiles.find(row => row.id === profile.id)!.identity = { signedIn: false, method: 'Claude account' };
    await writeFile(path.join(profiles.root, 'accounts.json'), JSON.stringify(saved));
    expect((await profiles.get(profile.id)).identity?.signedIn).toBe(false);
    expect((await knownUsageAccounts(profiles)).find(row => row.account.id === named.id)).toEqual({ account: named, nativeAccountIds: [claudeHistoryOwner('owner-one', 'org-one')] });
  });
  it('recovers the Claude display identity from metadata when no SDK or saved identity is available', async () => {
    const f = await fixture(), profiles = new AccountProfiles(path.join(f.root, 'profiles')), profile = await profiles.create('Claude');
    await writeFile(path.join(profiles.home(profile.id), '.claude.json'), JSON.stringify({ oauthAccount: {
      emailAddress: claudeOne.email, accountUuid: 'owner-one', organizationUuid: 'org-one',
    } }));
    expect((await knownUsageAccounts(profiles)).find(row => row.account.id === claudeOne.id)).toEqual({ account: claudeOne, nativeAccountIds: [claudeHistoryOwner('owner-one', 'org-one')] });
  });
  it('isolates Claude sessions and rejects contradictory ownership copied into forks', async () => {
    const f = await fixture(), options = claudeOptions(f);
    await claudeFile(f, 'main', [owner('one'), message('one', 'one'), owner('two', 'owner-two', 'org-two'), message('two', 'two')]);
    let data = await new UsageHistory(f.homes, f.ledger, f.cache, options).read();
    expect(data.conversations?.find(row => row.id === 'one')?.days[0]?.account).toEqual(claudeOne);
    expect(data.conversations?.find(row => row.id === 'two')?.days[0]?.account).toEqual(claudeTwo);
    await claudeFile(f, 'fork', [message('one', 'one'), owner('one', 'owner-two', 'org-two')]);
    data = await new UsageHistory(f.homes, f.ledger, f.cache, options).read();
    expect(data.conversations?.find(row => row.id === 'one')?.days[0]?.account).toBeUndefined();
    expect(data.duplicates).toBe(1);
    expect(usageBreakdown(data.days, { grouping: 'day' }).totals.total).toBe(220);
  });
  it('reapplies reversible manual choices on disk/memory cache while native turns take priority', async () => {
    const f = await fixture(); await f.write('first', 'creator-one'); await f.write('second', 'creator-one');
    await f.ledger.record('Codex:turn:turn-second', two);
    const first = await f.history.read();
    expect(first.days.find(row => !row.account)?.total).toBe(110);
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
  it('lets users keep usage unknown and edit overlapping choices without touching history or counts', async () => {
    const f = await fixture(), file = await f.write('first', 'creator-one'); const original = await readFile(file, 'utf8');
    const assigned = await f.store.assign({ provider: 'Codex', conversationId: 'first' }, two);
    const unknown = await f.store.assign({ provider: 'Codex', conversationId: 'first' }, null);
    const data = await f.history.read(); expect(data.days[0]?.account).toBeUndefined(); expect(data.days[0]?.accountSource).toBe('manual');
    await new UsageAttributionStore(f.store.directory).remove(unknown.id);
    expect((await f.history.read()).days[0]?.account?.id).toBe(two.id);
    await f.store.remove(assigned.id);
    expect((await f.history.read()).days[0]).toMatchObject({ total: 110 });
    expect((await f.history.read()).days[0]?.account).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe(original);
  });
  it.each(['modern', 'legacy'] as const)('attributes each %s Codex turn independently of the conversation creator across switches and cache reloads', async format => {
    const f = await fixture(), date = new Date(Date.now() - 60000).toISOString();
    const file = await f.write('switched', 'creator-one', 'first', date);
    const token = (response: string, input: number, cumulative: number) => format === 'modern'
      ? { timestamp: date, type: 'token_usage_record', payload: { response_id: response, usage: { input_tokens: input, output_tokens: input / 10 } } }
      : { timestamp: date, type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: cumulative, output_tokens: cumulative / 10 },
        last_token_usage: { input_tokens: input, output_tokens: input / 10 },
      } } };
    await writeFile(file, [
      { type: 'session_meta', payload: { id: 'switched', creator_account_id: 'creator-one' } },
      { type: 'turn_context', payload: { turn_id: 'turn-first', model: 'model' } },
      token('first', 100, 100),
      { type: 'turn_context', payload: { turn_id: 'turn-second', model: 'model' } },
      token('second', 200, 300),
      { type: 'turn_context', payload: { turn_id: 'turn-external', model: 'model' } },
      token('external', 300, 600),
    ].map(row => JSON.stringify(row)).join('\n'));
    await f.ledger.record('Codex:turn:turn-first', one);
    await f.ledger.record('Codex:turn:turn-second', two);
    const check = (data: Awaited<ReturnType<UsageHistory['read']>>) => {
      expect(usageBreakdown(data.days, { grouping: 'day', accountId: one.id }).totals.total).toBe(110);
      expect(usageBreakdown(data.days, { grouping: 'day', accountId: two.id }).totals.total).toBe(220);
      expect(usageBreakdown(data.days, { grouping: 'day', accountId: 'unknown' }).totals.total).toBe(330);
      expect(data.conversations).toHaveLength(1);
      expect(data.conversations![0]!.days.reduce((sum, row) => sum + row.total, 0)).toBe(660);
      expect(data.recent?.map(row => [row.total, row.accountId])).toEqual([[110, one.id], [220, two.id], [330, undefined]]);
    };
    check(await f.history.read()); check(await f.history.read());
    expect(f.history.readStats?.memoryHits).toBe(1);
    const reloadedLedger = new UsageAccountStore(f.ledger.directory);
    const reload = new UsageHistory(f.homes, reloadedLedger, f.cache, f.options);
    check(await reload.read()); expect(reload.readStats?.diskHits).toBe(1);
    // Evidence discovered later must also fix previously cached unknown usage.
    await reloadedLedger.record('Codex:turn:turn-external', two);
    const recovered = await reload.read();
    expect(usageBreakdown(recovered.days, { grouping: 'day', accountId: two.id }).totals.total).toBe(550);
    expect(usageBreakdown(recovered.days, { grouping: 'day', accountId: 'unknown' }).totals.total).toBe(0);
  });
  it('does not assign external Codex history to its creator or the sole currently known account', async () => {
    const f = await fixture(); await f.write('external', 'creator-one'); await f.write('missing', '');
    for (const knownAccounts of [f.options.knownAccounts, async () => [{ account: one, nativeAccountIds: ['creator-one'] }]]) {
      const data = await new UsageHistory(f.homes, f.ledger, f.cache, { store: f.store, knownAccounts }).read();
      expect(data.days.every(row => !row.account && !row.accountSource)).toBe(true);
      expect(usageBreakdown(data.days, { grouping: 'day', accountId: 'unknown' }).totals.total).toBe(220);
    }
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
