import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { UsageHistory, UsageParser } from '../src/providers/usage-history';
import { usageBreakdown } from '../src/core/usage-dashboard';
import { UsageAccountStore } from '../src/core/usage-account-store';
import { usageAccount, UNKNOWN_ACCOUNT } from '../src/core/usage-account';

const stamp = '2026-10-09T08:00:00Z';
const codexUsage = (input: number, output: number) => ({ input_tokens: input, cached_input_tokens: input / 2, output_tokens: output, reasoning_output_tokens: output / 2 });
const meta = { type: 'session_meta', payload: { id: 'thread' } };
const turn = { type: 'turn_context', payload: { turn_id: 'turn', model: 'codex-model' } };
const token = (response: string, input: number, output: number, cumulativeInput = input, cumulativeOutput = output) => ({ timestamp: stamp, type: 'token_usage_record', payload: {
  thread_id: 'thread', turn_id: 'turn', response_id: response, usage: codexUsage(input, output), thread_token_usage: codexUsage(cumulativeInput, cumulativeOutput) } });
const event = (input: number, output: number, lastInput = input, lastOutput = output) => ({ timestamp: stamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: codexUsage(input, output), last_token_usage: codexUsage(lastInput, lastOutput) } } });
const claude = (id: string, output = 20) => ({ timestamp: stamp, type: 'assistant', uuid: 'uuid', message: { id, model: 'claude-model', usage: {
  input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 200, output_tokens: output } } });
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

describe('Keeping tokens of deleted transcripts', () => {
  const rollout = (id: string, response: string, input: number, output: number) => jsonl([{ ...meta, payload: { id, cwd: 'L:/project' } }, turn,
    { ...token(response, input, output), payload: { ...token(response, input, output).payload, thread_id: id } }]);
  const setup = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-retained-usage-'));
    const homes = { codex: path.join(root, 'codex'), claude: path.join(root, 'claude') }, cache = path.join(root, 'cache');
    await mkdir(path.join(homes.codex, 'sessions'), { recursive: true });
    return { root, homes, cache, sessions: path.join(homes.codex, 'sessions') };
  };
  const total = (data: Awaited<ReturnType<UsageHistory['read']>>) => usageBreakdown(data.days, { grouping: 'day' }).totals.total;
  it('keeps counting a deleted transcript across reloads until the kept counts are purged', async () => {
    const f = await setup();
    try {
      await writeFile(path.join(f.sessions, 'kept.jsonl'), rollout('kept', 'r-kept', 100, 20));
      await writeFile(path.join(f.sessions, 'live.jsonl'), rollout('live', 'r-live', 200, 40));
      const history = new UsageHistory(f.homes, undefined, f.cache);
      const before = await history.read(); expect(total(before)).toBe(360); expect(before.retained).toBeUndefined();
      await rm(path.join(f.sessions, 'kept.jsonl'));
      const after = await history.read();
      expect(total(after)).toBe(360); expect(after.files).toBe(1);
      expect(after.retained).toEqual({ conversations: 1, tokens: 120 });
      expect(after.conversations!.find(row => row.id === 'kept')).toMatchObject({ transcriptDeleted: true, project: 'L:/project' });
      expect(after.conversations!.find(row => row.id === 'live')!.transcriptDeleted).toBeUndefined();
      const reload = await new UsageHistory(f.homes, undefined, f.cache).read();
      expect(total(reload)).toBe(360); expect(reload.conversations).toEqual(after.conversations);
      expect(await history.purgeRetained()).toBe(1);
      const purged = await history.read();
      expect(total(purged)).toBe(240); expect(purged.retained).toBeUndefined(); expect(purged.conversations!.map(row => row.id)).toEqual(['live']);
      expect((await new UsageHistory(f.homes, undefined, f.cache).read()).conversations!.map(row => row.id)).toEqual(['live']);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it('does not count a compressed or archived rollout twice or report it as deleted', async () => {
    const f = await setup();
    try {
      const file = path.join(f.sessions, 'moved.jsonl');
      await writeFile(file, rollout('moved', 'r-moved', 100, 20));
      const history = new UsageHistory(f.homes, undefined, f.cache); await history.read();
      await writeFile(`${file}.zst`, zstdCompressSync(await readFile(file))); await rm(file);
      const data = await history.read();
      expect(total(data)).toBe(120); expect(data.retained).toBeUndefined();
      expect(data.conversations![0]!.transcriptDeleted).toBeUndefined();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it('keeps counts written by an older cache format and ignores corrupt or foreign cache files', async () => {
    const f = await setup();
    try {
      const file = path.join(f.sessions, 'old.jsonl');
      await writeFile(file, rollout('old', 'r-old', 100, 20));
      await new UsageHistory(f.homes, undefined, f.cache).read();
      const [name] = await readdir(f.cache);
      const cached = JSON.parse(await readFile(path.join(f.cache, name!), 'utf8'));
      await writeFile(path.join(f.cache, name!), JSON.stringify({ ...cached, version: 1 }));
      await writeFile(path.join(f.cache, 'corrupt.json'), 'not json');
      await writeFile(path.join(f.cache, 'foreign.json'), JSON.stringify({ provider: 'Other', records: [] }));
      await rm(file);
      const data = await new UsageHistory(f.homes, undefined, f.cache).read();
      expect(total(data)).toBe(120); expect(data.retained).toEqual({ conversations: 1, tokens: 120 });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it('applies saved account evidence to kept tokens', async () => {
    const f = await setup();
    try {
      const account = usageAccount('Codex', { signedIn: true, email: 'kept@test.invalid', id: 'kept', method: 'ChatGPT' })!;
      const ledger = new UsageAccountStore(path.join(f.root, 'usage')); await ledger.record('Codex:r-kept', account);
      const file = path.join(f.sessions, 'kept.jsonl'); await writeFile(file, rollout('kept', 'r-kept', 100, 20));
      const history = new UsageHistory(f.homes, ledger, f.cache); await history.read(); await rm(file);
      expect((await history.read()).days[0]).toMatchObject({ total: 120, account });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it('has nothing to keep or purge without a cache and leaves live caches in place', async () => {
    const f = await setup();
    try {
      await writeFile(path.join(f.sessions, 'live.jsonl'), rollout('live', 'r-live', 100, 20));
      const uncached = new UsageHistory(f.homes); await uncached.read();
      expect(await uncached.purgeRetained()).toBe(0);
      const history = new UsageHistory(f.homes, undefined, f.cache); await history.read();
      expect(await history.purgeRetained()).toBe(0);
      const reload = new UsageHistory(f.homes, undefined, f.cache); await reload.read();
      expect(reload.readStats!.diskHits).toBe(1);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});

describe('Native usage accounting', () => {
  it('counts compressed Codex rollouts once, reports corrupt ones as unreadable and reuses the token-only cache', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-compressed-usage-'));
    try {
      const homes = { codex: path.join(root, 'codex'), claude: path.join(root, 'claude') }, cache = path.join(root, 'cache');
      const sessions = path.join(homes.codex, 'sessions'), archived = path.join(homes.codex, 'archived_sessions');
      await mkdir(sessions, { recursive: true }); await mkdir(archived, { recursive: true });
      const rollout = (id: string, response: string, input: number, output: number) => jsonl([{ ...meta, payload: { id, cwd: 'L:/Dự án' } }, turn,
        { ...token(response, input, output), payload: { ...token(response, input, output).payload, thread_id: id } }]);
      await writeFile(path.join(sessions, 'live.jsonl'), rollout('live', 'r-live', 100, 20));
      await writeFile(path.join(sessions, 'old.jsonl.zst'), zstdCompressSync(Buffer.from(rollout('old', 'r-old', 200, 40))));
      await writeFile(path.join(archived, 'archived.jsonl.zst'), zstdCompressSync(Buffer.from(rollout('archived', 'r-archived', 300, 60))));
      // Compression can leave both forms of one rollout on disk during the swap.
      await writeFile(path.join(sessions, 'swap.jsonl'), rollout('swap', 'r-swap', 400, 80));
      await writeFile(path.join(sessions, 'swap.jsonl.zst'), zstdCompressSync(Buffer.from(rollout('swap', 'r-swap', 400, 80))));
      await writeFile(path.join(archived, 'corrupt.jsonl.zst'), 'not a zstandard frame');
      // zlib ends a truncated frame without an error; only complete decoded lines count, and a finished write changes the signature.
      await writeFile(path.join(archived, 'truncated.jsonl.zst'), zstdCompressSync(Buffer.from(rollout('truncated', 'r-truncated', 999, 999))).subarray(0, -8));
      await writeFile(path.join(archived, 'other.zst'), zstdCompressSync(Buffer.from(rollout('other', 'r-other', 999, 999))));
      const history = new UsageHistory(homes, undefined, cache), first = await history.read();
      expect(usageBreakdown(first.days, { grouping: 'day' }).totals.total).toBe(1200);
      expect(first.conversations!.map(row => row.id).sort()).toEqual(['archived', 'live', 'old', 'swap']);
      expect(first.conversations!.find(row => row.id === 'old')!.project).toBe('L:/Dự án');
      expect(first.unreadableFiles).toBe(1); expect(first.files).toBe(7);
      const reload = new UsageHistory(homes, undefined, cache), second = await reload.read();
      expect(second.conversations).toEqual(first.conversations);
      expect(reload.readStats!.diskHits).toBe(6); expect(second.unreadableFiles).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('groups deduplicated tokens by conversation across models/accounts and retains metadata in the token-only cache', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-conversation-usage-'));
    try {
      const homes = { codex: path.join(root, 'codex'), claude: path.join(root, 'claude') }, cache = path.join(root, 'cache');
      await mkdir(path.join(homes.codex, 'sessions'), { recursive: true }); await mkdir(path.join(homes.claude, 'projects', 'test'), { recursive: true });
      await writeFile(path.join(homes.codex, 'sessions', 'one.jsonl'), jsonl([{ ...meta, payload: { id: 'thread-one', cwd: 'L:/project-one' } }, turn,
        { ...token('r1', 100, 20), payload: { ...token('r1', 100, 20).payload, thread_id: 'thread-one' } }]));
      const message = { ...claude('c1'), sessionId: 'claude-one', cwd: 'L:/project-two' };
      await writeFile(path.join(homes.claude, 'projects', 'test', 'one.jsonl'), jsonl([message, message, { ...message, message: { ...message.message, id: 'c2', model: 'second-model' } }]));
      const first = await new UsageHistory(homes, undefined, cache).read();
      expect(first.conversations).toHaveLength(2);
      const codex = first.conversations!.find(row => row.key === 'Codex:thread-one')!;
      expect(codex.project).toBe('L:/project-one'); expect(usageBreakdown(codex.days, { grouping: 'day' }).totals.total).toBe(120);
      const c = first.conversations!.find(row => row.key === 'Claude:claude-one')!;
      expect(c.project).toBe('L:/project-two'); expect(usageBreakdown(c.days, { grouping: 'day' }).totals.total).toBe(660);
      expect(usageBreakdown(c.days, { grouping: 'day' }).models).toHaveLength(2);
      expect(first.conversations!.reduce((sum, row) => sum + usageBreakdown(row.days, { grouping: 'day' }).totals.total, 0)).toBe(usageBreakdown(first.days, { grouping: 'day' }).totals.total);
      const reload = await new UsageHistory(homes, undefined, cache).read(); expect(reload.conversations).toEqual(first.conversations);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('reuses token-only disk cache after reload, invalidates changed/corrupt entries and reapplies account evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-usage-cache-'));
    try {
      const homes = { codex: path.join(root, 'codex'), claude: path.join(root, 'claude') }, cache = path.join(root, 'cache');
      const file = path.join(homes.codex, 'sessions', 's.jsonl'); await mkdir(path.dirname(file), { recursive: true });
      const ledger = new UsageAccountStore(path.join(root, 'ledger'));
      const one = usageAccount('Codex', { signedIn: true, email: 'one@test.invalid', method: 'ChatGPT' })!;
      const two = usageAccount('Codex', { signedIn: true, email: 'two@test.invalid', method: 'ChatGPT' })!;
      const prompt = 'Private prompt excluded from usage cache';
      await writeFile(file, jsonl([meta, turn, { type: 'response_item', payload: { type: 'message', content: prompt } }, token('r1', 100, 10)]));
      await ledger.record('Codex:turn:turn', one);
      const history = new UsageHistory(homes, ledger, cache), first = await history.read();
      expect(history.readStats).toMatchObject({ parsedFiles: 1, diskHits: 0 });
      expect((await history.read()).days).toEqual(first.days); expect(history.readStats).toMatchObject({ parsedFiles: 0, memoryHits: 1 });
      const { readdir } = await import('node:fs/promises');
      const cachedFile = path.join(cache, (await readdir(cache))[0]!);
      const encoded = await readFile(cachedFile, 'utf8');
      expect(encoded).not.toContain(prompt); expect(encoded).not.toContain(one.email); expect(encoded).not.toContain(file);
      const reload = new UsageHistory(homes, ledger, cache);
      expect((await reload.read()).days).toEqual(first.days); expect(reload.readStats).toMatchObject({ parsedFiles: 0, diskHits: 1 });
      await ledger.record('Codex:turn:turn', two);
      const conflict = await reload.read();
      expect(conflict.days.every(row => !row.account)).toBe(true); expect(reload.readStats!.parsedFiles).toBe(0);
      await appendFile(file, jsonl([token('r2', 200, 20, 300, 30)]));
      expect(usageBreakdown((await reload.read()).days, { grouping: 'day' }).totals.total).toBe(330);
      expect(reload.readStats!.parsedFiles).toBe(1);
      for (const invalid of ['{broken', JSON.stringify({ ...JSON.parse(await readFile(cachedFile, 'utf8')), version: -1 }), JSON.stringify({ ...JSON.parse(await readFile(cachedFile, 'utf8')), records: [['injected']] })]) {
        await writeFile(cachedFile, invalid);
        const fresh = new UsageHistory(homes, ledger, cache);
        expect(usageBreakdown((await fresh.read()).days, { grouping: 'day' }).totals.total).toBe(330);
        expect(fresh.readStats!.parsedFiles).toBe(1);
      }
      await rm(file);
      expect(usageBreakdown((await reload.read()).days, { grouping: 'day' }).totals.total).toBe(330); expect(reload.readStats!.parsedFiles).toBe(0);
      await reload.purgeRetained();
      expect((await reload.read()).days).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('keeps usage available when the optional cache directory cannot be written', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-usage-cache-'));
    try {
      const folder = path.join(root, 'claude', 'projects'); await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 's.jsonl'), jsonl([claude('r1')]));
      const blocked = path.join(root, 'file'); await writeFile(blocked, 'not a directory');
      const history = new UsageHistory({ codex: path.join(root, 'codex'), claude: path.join(root, 'claude') }, undefined, blocked);
      expect(usageBreakdown((await history.read()).days, { grouping: 'day' }).totals.total).toBe(330);
      expect(history.readStats!.parsedFiles).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('uses explicit native root-turn links for Codex subagents rather than conversation creator identity', () => {
    const parser = new UsageParser('Codex');
    parser.consume({ ...meta, payload: { ...meta.payload, creator_account_id: 'creator' } });
    parser.consume({ ...turn, payload: { ...turn.payload, turn_id: 'child', root_turn_id: 'parent' } });
    parser.consume({ ...token('child-response', 100, 10), payload: { ...token('child-response', 100, 10).payload, turn_id: 'child', root_turn_id: 'parent' } });
    expect(parser.records()[0]?.accountKey).toBe('Codex:turn:parent');
    expect(parser.records()[0]?.account).toBeUndefined();
  });
  it('separates accounts within one conversation, preserves fork attribution and leaves external history unknown', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-scoped-'));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-10T08:00:00Z'));
    try {
      const homes = { codex: path.join(root, 'codex'), claude: path.join(root, 'claude') };
      await mkdir(path.join(homes.codex, 'sessions'), { recursive: true });
      await mkdir(path.join(homes.claude, 'projects'), { recursive: true });
      const one = usageAccount('Codex', { signedIn: true, email: 'one@test.invalid', method: 'ChatGPT' })!;
      const two = usageAccount('Codex', { signedIn: true, email: 'two@test.invalid', method: 'ChatGPT' })!;
      const claudeOne = usageAccount('Claude', { signedIn: true, email: one.email, method: 'Claude account', organization: 'org' })!;
      const ledger = new UsageAccountStore(path.join(root, 'ledger'));
      await ledger.record('Codex:turn:turn', one); await ledger.record('Codex:turn:turn-two', two); await ledger.record('Claude:msg', claudeOne);
      const second = { ...token('r2', 200, 20, 300, 30), payload: { ...token('r2', 200, 20, 300, 30).payload, turn_id: 'turn-two' } };
      await writeFile(path.join(homes.codex, 'sessions', 'main.jsonl'), jsonl([meta, turn, token('r1', 100, 10), second]));
      await writeFile(path.join(homes.codex, 'sessions', 'fork.jsonl'), jsonl([meta, turn, token('r1', 100, 10), { ...token('external', 10, 10), payload: { ...token('external', 10, 10).payload, turn_id: 'external' } }]));
      await writeFile(path.join(homes.claude, 'projects', 'main.jsonl'), jsonl([claude('msg'), claude('outside')]));
      const reader = new UsageHistory(homes, ledger);
      const data = await reader.read(), result = usageBreakdown(data.days, { grouping: 'day' });
      expect(result.totals.total).toBe(1010); expect(data.duplicates).toBe(1);
      expect(usageBreakdown(data.days, { grouping: 'day', accountId: one.id }).totals.total).toBe(110);
      expect(usageBreakdown(data.days, { grouping: 'day', accountId: two.id }).totals.total).toBe(220);
      expect(usageBreakdown(data.days, { grouping: 'day', accountId: claudeOne.id }).totals.total).toBe(330);
      expect(usageBreakdown(data.days, { grouping: 'day', accountId: UNKNOWN_ACCOUNT }).totals.total).toBe(350);
      expect(data.recent?.filter(row => row.accountId === one.id)).toHaveLength(1);
      // An attribution change invalidates grouping even when transcript files are cached.
      await ledger.record('Codex:turn:turn', two);
      const refreshed = await reader.read();
      expect(usageBreakdown(refreshed.days, { grouping: 'day', accountId: one.id }).totals.total).toBe(0);
      expect(usageBreakdown(refreshed.days, { grouping: 'day', accountId: UNKNOWN_ACCOUNT }).totals.total).toBe(460);
    } finally { clock.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
  it('prices deduplicated responses individually and exposes only recent timestamp/token metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-priced-'));
    const now = Date.parse('2026-10-10T08:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const codex = path.join(root, 'codex', 'sessions'), project = path.join(root, 'claude', 'projects', 'project');
      await mkdir(codex, { recursive: true }); await mkdir(project, { recursive: true });
      const knownTurn = { ...turn, payload: { ...turn.payload, model: 'gpt-5.6-sol' } };
      await writeFile(path.join(codex, 's.jsonl'), jsonl([meta, knownTurn, token('r1', 200000, 0), token('r2', 200000, 0)]));
      const known = { ...claude('msg1'), message: { ...claude('msg1').message, model: 'claude-sonnet-4-6', usage: {
        input_tokens: 100000, cache_read_input_tokens: 500000, cache_creation_input_tokens: 300000, cache_creation: { ephemeral_1h_input_tokens: 100000 }, output_tokens: 100000,
      } } };
      await writeFile(path.join(project, 's.jsonl'), jsonl([known, known,
        { ...claude('old'), timestamp: new Date(now - 8 * 86400000).toISOString() },
        { ...claude('future'), timestamp: new Date(now + 1000).toISOString() },
      ]));
      const value = await new UsageHistory({ codex: path.join(root, 'codex'), claude: path.join(root, 'claude') }).read();
      const result = usageBreakdown(value.days, { grouping: 'day' });
      // Two 200k requests stay at standard rates even though their day totals 400k.
      expect(result.providers.find(row => row.key === 'Codex')?.cost.usd).toBeCloseTo(.88);
      expect(result.providers.find(row => row.key === 'Claude')?.cost.usd).toBeCloseTo(3.3);
      expect(result.cost.unpricedTokens).toBe(660);
      expect(value.recent).toHaveLength(3);
      expect(value.recent?.reduce((sum, row) => sum + row.total, 0)).toBe(1400000);
      for (const row of value.recent!) expect(Object.keys(row).sort()).toEqual(['provider', 'timestamp', 'total']);
      expect(value.duplicates).toBe(1);
    } finally { clock.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
  it('uses modern per-response usage instead of cumulative event/turn/thread totals', () => {
    const parser = new UsageParser('Codex');
    [meta, turn, token('r1', 100, 10), event(100, 10), token('r2', 200, 20, 300, 30), event(300, 30, 200, 20), event(300, 30, 200, 20)].forEach(row => parser.consume(row));
    const rows = parser.records();
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(330);
    expect(rows[1]).toMatchObject({ model: 'codex-model', input: 200, cacheRead: 100, output: 20, reasoning: 10, total: 220 });
  });
  it('keeps older usage before a CLI upgrade, handles legacy replay and counter reset', () => {
    const parser = new UsageParser('Codex');
    [meta, turn, event(100, 10), event(300, 30, 200, 20), token('r3', 100, 10, 400, 40), event(400, 40, 100, 10), event(400, 40), event(50, 10)].forEach(row => parser.consume(row));
    const rows = parser.records(); expect(rows).toHaveLength(4);
    expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(500);
  });
  it('counts Claude cache input once and skips synthetic/undated usage', () => {
    const parser = new UsageParser('Claude');
    parser.consume(claude('r1'));
    parser.consume({ ...claude('synthetic'), message: { ...claude('x').message, model: '<synthetic>' } });
    parser.consume({ ...claude('undated'), timestamp: undefined });
    parser.consume({ type: 'result', usage: claude('x').message.usage });
    expect(parser.records()).toHaveLength(1); expect(parser.undated).toBe(1);
    expect(parser.records()[0]).toMatchObject({ input: 310, output: 20, cacheRead: 100, cacheWrite: 200, total: 330 });
  });
  it('includes all projects, archived sessions/subagents, deduplicates copied/streamed responses and updates changed files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-usage-'));
    try {
      const homes = { codex: path.join(root, 'codex'), claude: path.join(root, 'claude') };
      const active = path.join(homes.codex, 'sessions', 'rollout.jsonl'), archived = path.join(homes.codex, 'archived_sessions', 'copied.jsonl');
      const project = path.join(homes.claude, 'projects', 'other-project', 'session.jsonl'), sub = path.join(homes.claude, 'projects', 'another-project', 'session', 'subagents', 'agent.jsonl');
      for (const file of [active, archived, project, sub]) await mkdir(path.dirname(file), { recursive: true });
      const original = jsonl([meta, turn, token('r1', 100, 10), event(100, 10)]);
      await writeFile(active, original); await writeFile(archived, original);
      await writeFile(project, jsonl([claude('msg1', 5), claude('msg1', 20)]));
      await writeFile(sub, jsonl([claude('subagent')]));
      const cache = path.join(root, 'cache'), history = new UsageHistory(homes, undefined, cache), first = await history.read();
      const result = usageBreakdown(first.days, { grouping: 'day' });
      expect(first.files).toBe(4); expect(first.duplicates).toBe(2);
      expect(result.totals).toMatchObject({ requests: 3, input: 720, output: 50, cacheRead: 250, cacheWrite: 400, total: 770 });
      expect(await readFile(active, 'utf8')).toBe(original);
      expect((await history.read()).days).toEqual(first.days);
      const reloaded = new UsageHistory(homes, undefined, cache), cached = await reloaded.read();
      expect(cached.days).toEqual(first.days); expect(cached.recent).toEqual(first.recent); expect(cached.duplicates).toBe(first.duplicates);
      expect(reloaded.readStats).toMatchObject({ parsedFiles: 0, diskHits: 4 });
      // A copied old-format fork can omit the newer response records, but its
      // cumulative counter still identifies usage already counted in the original.
      await writeFile(archived, jsonl([meta, turn, event(100, 10)]));
      expect(usageBreakdown((await history.read()).days, { grouping: 'day' }).totals.total).toBe(770);
      await appendFile(active, jsonl([token('r2', 100, 10, 200, 20)]));
      expect(usageBreakdown((await history.read()).days, { grouping: 'month' }).totals.total).toBe(880);
      await rm(archived); expect((await history.read()).files).toBe(3);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('reports malformed/oversized records and tolerates a live partial tail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-usage-'));
    try {
      const folder = path.join(root, 'claude', 'projects', 'project'); await mkdir(folder, { recursive: true });
      const file = path.join(folder, 's.jsonl');
      await writeFile(file, '{bad}\n' + 'x'.repeat(2 * 1024 * 1024 + 1) + '\n' + jsonl([claude('r1')]) + '{"type":');
      const value = await new UsageHistory({ codex: path.join(root, 'codex'), claude: path.join(root, 'claude') }).read();
      expect(value).toMatchObject({ malformedLines: 2, oversizedLines: 0 });
      expect(usageBreakdown(value.days, { grouping: 'day' }).totals.requests).toBe(1);
      const controller = new AbortController(); controller.abort();
      await expect(new UsageHistory({ codex: root, claude: root }).read(controller.signal)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('reads usage from a large assistant response while skipping large image/tool-only records', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-usage-'));
    try {
      const folder = path.join(root, 'claude', 'projects', 'project'); await mkdir(folder, { recursive: true });
      const large = 'x'.repeat(3 * 1024 * 1024);
      await writeFile(path.join(folder, 's.jsonl'), jsonl([
        { type: 'user', message: { content: large } },
        { ...claude('large-response'), message: { ...claude('large-response').message, content: [{ type: 'text', text: large }] } },
      ]));
      const value = await new UsageHistory({ codex: path.join(root, 'codex'), claude: path.join(root, 'claude') }).read();
      expect(value.oversizedLines).toBe(0); expect(usageBreakdown(value.days, { grouping: 'day' }).totals.total).toBe(330);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
