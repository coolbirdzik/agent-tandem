import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, unlink, rm, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { ConversationCleanup, type CleanupConversation, type ConversationCleanupPlan } from '../src/core/conversation-cleanup';
import { transcriptPrefix } from '../src/providers/transcript-prefix';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-cleanup-')); roots.push(root);
  const homes = { Codex: path.join(root, 'codex'), Claude: path.join(root, 'claude') }, protectedKeys = new Set<string>();
  const remove = vi.fn(async (row: CleanupConversation) => { for (const file of row.files) await unlink(file.path); });
  const cleaner = new ConversationCleanup(remove, () => protectedKeys, homes);
  async function session(provider: 'Codex' | 'Claude', id: string, archived = false, parent?: string) {
    const file = provider === 'Codex' ? path.join(homes.Codex, archived ? 'archived_sessions' : 'sessions/2026/01/01', `rollout-${id}.jsonl`) : path.join(homes.Claude, 'projects', '-repo', `${id}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    const record = provider === 'Codex' ? { type: 'session_meta', payload: { id, cwd: '/repo', ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } : {}) } }
      : { type: 'user', sessionId: id, cwd: '/repo', uuid: 'message', message: { role: 'user', content: 'Old Claude conversation' } };
    await writeFile(file, `${JSON.stringify(record)}\n`); await age(file); return file;
  }
  return { root, homes, cleaner, session, remove, protectedKeys };
}
async function age(file: string) { const date = new Date(Date.now() - 60 * 86400000); await utimes(file, date, date); }
async function compress(file: string, keepPlain = false) {
  const compressed = `${file}.zst`; await writeFile(compressed, zstdCompressSync(await readFile(file))); await age(compressed);
  if (!keepPlain) await unlink(file); return compressed;
}

describe('Native conversation cleanup', () => {
  it('waits for confirmation with the exact expanded count and cancels without deleting', async () => {
    const f = await fixture(); await f.session('Codex', ids[0]!); await f.session('Codex', ids[1]!, false, ids[0]);
    let answer!: (confirmed: boolean) => void;
    const confirm = vi.fn((_plan: ConversationCleanupPlan) => new Promise<boolean>(resolve => { answer = resolve; }));
    const job = f.cleaner.deleteMatching({ before: Date.now(), provider: 'Codex' }, { confirm });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(confirm.mock.calls[0]![0].conversations).toHaveLength(2);
    expect(f.remove).not.toHaveBeenCalled();
    answer(false);
    const state = await job;
    expect(state.result).toMatchObject({ removed: [], cancelled: true });
    expect(state.conversations).toHaveLength(2); expect(f.remove).not.toHaveBeenCalled();
  });
  it('revalidates transcripts after confirmation before deleting', async () => {
    const f = await fixture(), file = await f.session('Codex', ids[0]!);
    await expect(f.cleaner.deleteSelected([`Codex:${ids[0]}`], Date.now(), { confirm: async () => {
      await writeFile(file, await readFile(file, 'utf8') + '{}\n'); await age(file); return true;
    } })).rejects.toThrow('changed');
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('pauses immediately on an error until Skip is chosen', async () => {
    const f = await fixture(); for (const id of ids) await f.session('Codex', id);
    f.remove.mockRejectedValueOnce(new Error('Locked'));
    let answer!: (choice: 'skip') => void;
    const onError = vi.fn((_row: CleanupConversation, _reason: string) => new Promise<'skip'>(resolve => { answer = resolve; }));
    const job = f.cleaner.deleteMatching({ before: Date.now() }, { onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(f.remove).toHaveBeenCalledOnce(); expect(onError.mock.calls[0]![1]).toBe('Locked');
    answer('skip');
    expect((await job).result).toMatchObject({ removed: expect.any(Array), failures: [expect.stringContaining('Locked')] });
    expect(f.remove).toHaveBeenCalledTimes(3);
  });
  it('limits Skip All to the same provider and exact error and resets it each run', async () => {
    const f = await fixture(); for (const id of ids) await f.session('Codex', id);
    f.remove.mockRejectedValueOnce(new Error('Locked')).mockRejectedValueOnce(new Error('Locked')).mockRejectedValueOnce(new Error('Permission denied'));
    const onError = vi.fn(async (_row: CleanupConversation, _reason: string) => 'skipAll' as const);
    const first = await f.cleaner.deleteMatching({ before: Date.now() }, { onError });
    expect(first.result!.failures).toHaveLength(3); expect(onError.mock.calls.map(call => call[1])).toEqual(['Locked', 'Permission denied']);
    f.remove.mockRejectedValue(new Error('Locked')); onError.mockClear();
    await f.cleaner.deleteMatching({ before: Date.now() }, { onError });
    expect(onError).toHaveBeenCalledOnce();
    await f.session('Claude', ids[0]!); onError.mockClear();
    await f.cleaner.deleteMatching({ before: Date.now() }, { onError });
    expect(onError.mock.calls.map(call => call[0].provider).sort()).toEqual(['Claude', 'Codex']);
  });
  it('stops after Cancel and reports already completed deletions', async () => {
    const f = await fixture(); for (const id of ids) await f.session('Codex', id);
    const remove = f.remove.getMockImplementation()!;
    f.remove.mockImplementationOnce(remove).mockRejectedValueOnce(new Error('Locked'));
    const state = await f.cleaner.deleteMatching({ before: Date.now() }, { onError: async () => 'cancel' });
    expect(state.result).toMatchObject({ cancelled: true, failures: [expect.stringContaining('Locked')] });
    expect(state.result!.removed).toHaveLength(1); expect(state.conversations).toHaveLength(2); expect(f.remove).toHaveBeenCalledTimes(2);
  });
  it('uses the last user/assistant message beyond the prefix, ignores later tool records and reads compressed history', async () => {
    const f = await fixture(), plain = await f.session('Codex', ids[0]!);
    const metadata = await readFile(plain, 'utf8');
    await writeFile(plain, metadata + JSON.stringify({ type: 'event_msg', timestamp: '2025-01-01T00:00:00Z', payload: { type: 'user_message', message: 'First' } }) + '\n'
      + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(600000) } }) + '\n'
      + JSON.stringify({ type: 'response_item', timestamp: '2025-02-03T04:05:06Z', payload: { type: 'message', role: 'assistant', content: [{ text: 'Last reply' }] } }) + '\n'
      + JSON.stringify({ type: 'event_msg', timestamp: '2025-12-31T00:00:00Z', payload: { type: 'token_count' } }) + '\n');
    await age(plain); await compress(plain, true);
    const claude = await f.session('Claude', ids[1]!);
    await writeFile(claude, await readFile(claude, 'utf8') + JSON.stringify({ type: 'assistant', timestamp: '2025-01-15T00:00:00Z', message: { content: 'Older reply' } }) + '\n'); await age(claude);
    let scan = await f.cleaner.inspect();
    expect(scan.errors).toEqual([]);
    // The compressed copy is decoded later; until then the row falls back to its newer file time.
    expect(scan.dates).toEqual({ done: 0, total: 1 });
    expect(scan.conversations!.map(row => row.lastMessageAt)).toEqual([Date.parse('2025-01-15T00:00:00Z'), undefined]);
    scan = (await f.cleaner.resolveDates(scan, new AbortController().signal))!;
    expect(scan.dates).toBeUndefined();
    expect(scan.conversations!.map(row => row.lastMessageAt)).toEqual([Date.parse('2025-01-15T00:00:00Z'), Date.parse('2025-02-03T04:05:06Z')]);
    expect(scan.conversations!.at(-1)!.files).toHaveLength(2);
    // A timestamp beyond the initial 256 KB is used even after compression.
    await unlink(plain); scan = await f.cleaner.inspect();
    expect(scan.dates).toBeUndefined();
    expect(scan.conversations!.at(-1)!.lastMessageAt).toBe(Date.parse('2025-02-03T04:05:06Z'));
  });
  it('persists compressed message dates and stops reading them when aborted', async () => {
    const f = await fixture(), plain = await f.session('Codex', ids[0]!), cache = path.join(f.root, 'cache', 'dates.json');
    await writeFile(plain, await readFile(plain, 'utf8') + JSON.stringify({ type: 'event_msg', timestamp: '2025-01-01T00:00:00Z', payload: { type: 'user_message', message: 'Hi' } }) + '\n');
    await compress(plain);
    const first = new ConversationCleanup(f.remove, () => new Set(), f.homes, cache), abort = new AbortController(); abort.abort();
    expect(await first.resolveDates(await first.inspect(), abort.signal)).toBeUndefined();
    await expect(readFile(cache, 'utf8').then(JSON.parse)).resolves.toEqual({ version: 1, entries: [] });
    expect((await first.resolveDates(await first.inspect(), new AbortController().signal))!.conversations![0]!.lastMessageAt).toBe(Date.parse('2025-01-01T00:00:00Z'));
    // A new session (VS Code reload) reuses the saved date without decoding again.
    const second = new ConversationCleanup(f.remove, () => new Set(), f.homes, cache), scan = await second.inspect();
    expect(scan.dates).toBeUndefined(); expect(scan.conversations![0]!.lastMessageAt).toBe(Date.parse('2025-01-01T00:00:00Z'));
  });
  it('deletes directly by cutoff in oldest-first order and keeps nonmatching chats', async () => {
    const f = await fixture(), times = ['2025-03-01', '2025-01-01', '2025-06-01'];
    for (const [index, id] of ids.entries()) {
      const file = await f.session('Codex', id);
      await writeFile(file, await readFile(file, 'utf8') + JSON.stringify({ type: 'event_msg', timestamp: `${times[index]}T00:00:00Z`, payload: { type: 'user_message', message: 'Hello' } }) + '\n'); await age(file);
    }
    const progress = vi.fn();
    const result = await f.cleaner.deleteSelected([`Codex:${ids[0]}`, `Codex:${ids[1]}`], Date.parse('2025-04-01'), { deleting: progress });
    expect(result.result).toMatchObject({ removed: [`Codex:${ids[1]}`, `Codex:${ids[0]}`], skipped: [], failures: [] });
    expect(result.conversations!.map(row => row.id)).toEqual([ids[2]]);
    expect(progress).toHaveBeenLastCalledWith(2, 2);
  });
  it('keeps a conversation whose cascading child is newer than the cutoff and rejects invalid cutoffs', async () => {
    const f = await fixture(); await f.session('Codex', ids[0]!);
    const child = await f.session('Codex', ids[1]!, false, ids[0]);
    await writeFile(child, await readFile(child, 'utf8') + JSON.stringify({ type: 'event_msg', timestamp: '2025-06-01T00:00:00Z', payload: { type: 'user_message', message: 'Newer child' } }) + '\n'); await age(child);
    const key = `Codex:${ids[0]}`;
    // Give the parent an earlier message date instead of relying on filesystem time.
    const parent = path.join(f.homes.Codex, 'sessions/2026/01/01', `rollout-${ids[0]}.jsonl`);
    await writeFile(parent, await readFile(parent, 'utf8') + JSON.stringify({ type: 'event_msg', timestamp: '2025-01-01T00:00:00Z', payload: { type: 'user_message', message: 'Old parent' } }) + '\n'); await age(parent);
    const kept = await f.cleaner.deleteSelected([key], Date.parse('2025-04-01'));
    expect(kept.result).toMatchObject({ removed: [], kept: [{ key, reason: expect.stringContaining('subagent history') }] });
    for (const cutoff of [undefined, '2025-04-01', NaN, Infinity, Date.now() + 86400000]) await expect(f.cleaner.deleteSelected([key], cutoff)).rejects.toThrow('valid past cutoff');
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('deletes everything the filters match in one run, reading deferred dates first and reporting what was kept', async () => {
    const f = await fixture(), message = (time: string) => JSON.stringify({ type: 'event_msg', timestamp: time, payload: { type: 'user_message', message: 'Hi' } }) + '\n';
    const extra = ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
    for (const id of [ids[0]!, ids[1]!, extra[0]!]) { const file = await f.session('Codex', id); await writeFile(file, await readFile(file, 'utf8') + message('2025-01-01T00:00:00Z')); await age(file); }
    // A compressed rollout whose file time is recent: only its decoded message date makes it match.
    const compressed = await compress(await f.session('Codex', ids[2]!).then(async file => { await writeFile(file, await readFile(file, 'utf8') + message('2025-01-02T00:00:00Z')); return file; }));
    await utimes(compressed, new Date(Date.now() - 3600000), new Date(Date.now() - 3600000));
    const child = await f.session('Codex', extra[1]!, false, extra[0]); await writeFile(child, await readFile(child, 'utf8') + message('2025-06-01T00:00:00Z')); await age(child);
    f.protectedKeys.add(`Codex:${ids[1]}`);
    const dates = vi.fn(), deleting = vi.fn();
    const state = await f.cleaner.deleteMatching({ before: Date.parse('2025-04-01'), provider: 'Codex' }, { dates, deleting });
    expect(state.result!.removed.sort()).toEqual([`Codex:${ids[0]}`, `Codex:${ids[2]}`].sort());
    expect(state.result!.titles).toMatchObject({ [`Codex:${ids[2]}`]: expect.any(String) });
    expect(state.result!.kept!.map(row => [row.key, row.reason])).toEqual([[`Codex:${ids[1]}`, expect.stringContaining('Open')], [`Codex:${extra[0]}`, expect.stringContaining('subagent history newer')]]);
    expect(deleting).toHaveBeenLastCalledWith(2, 2);
    expect(state.conversations!.map(row => row.key).sort()).toEqual([`Codex:${ids[1]}`, `Codex:${extra[0]}`, `Codex:${extra[1]}`].sort());
    for (const filter of [undefined, { before: Date.now() + 86400000 }, { before: 0, provider: 'Gemini' }, { before: 1000, after: 1000 }, { before: 1000, after: 'x' }]) await expect(f.cleaner.deleteMatching(filter)).rejects.toThrow();
  });
  it('previews compressed Codex archives and spawned children using their on-disk paths and sizes', async () => {
    const f = await fixture(), kept = await f.session('Codex', ids[2]!);
    const parent = await compress(await f.session('Codex', ids[0]!, true));
    const child = await compress(await f.session('Codex', ids[1]!, false, ids[0]));
    const scan = await f.cleaner.inspect(); expect(scan.errors).toEqual([]); expect(scan.conversations).toHaveLength(3);
    expect(scan.conversations!.find(row => row.id === ids[0])).toMatchObject({ archived: true, project: '/repo' });
    const preview = await f.cleaner.preview([`Codex:${ids[0]}`]);
    expect(preview.plan!.conversations.flatMap(row => row.files.map(file => file.path)).sort()).toEqual([parent, child].sort());
    expect(preview.plan!.bytes).toBe((await readFile(parent)).length + (await readFile(child)).length);
    expect(f.remove).not.toHaveBeenCalled();
    const result = await f.cleaner.delete(preview.plan!.token);
    expect(result.result).toMatchObject({ removed: [`Codex:${ids[1]}`, `Codex:${ids[0]}`], failures: [], skipped: [] });
    expect(await readFile(kept, 'utf8')).toContain(ids[2]);
  });
  it('groups plain and compressed copies of a conversation into one exact deletion preview', async () => {
    const f = await fixture(), plain = await f.session('Codex', ids[0]!), compressed = await compress(plain, true);
    const preview = await f.cleaner.preview([`Codex:${ids[0]}`]); expect(preview.plan!.conversations).toHaveLength(1);
    expect(preview.plan!.conversations[0]!.files.map(file => file.path).sort()).toEqual([plain, compressed].sort());
    expect((await f.cleaner.delete(preview.plan!.token)).result!.removed).toEqual([`Codex:${ids[0]}`]);
  });
  it('rejects previews when compressed data changes or a plain transcript is replaced by compression', async () => {
    const f = await fixture(), plain = await f.session('Codex', ids[0]!);
    const first = (await f.cleaner.preview([`Codex:${ids[0]}`])).plan!;
    const compressed = await compress(plain);
    await expect(f.cleaner.delete(first.token)).rejects.toThrow('changed'); expect(f.remove).not.toHaveBeenCalled();
    const second = (await f.cleaner.preview([`Codex:${ids[0]}`])).plan!;
    await writeFile(compressed, zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session_meta', payload: { id: ids[0], cwd: '/other-project' } }) + '\n'))); await age(compressed);
    await expect(f.cleaner.delete(second.token)).rejects.toThrow('changed'); expect(f.remove).not.toHaveBeenCalled();
  });
  it('reports corrupt compressed files and keeps deletion blocked until their metadata can be read', async () => {
    const f = await fixture(), file = await f.session('Codex', ids[0]!);
    const compressed = `${file}.zst`; await writeFile(compressed, 'not a zstandard frame'); await age(compressed);
    const state = await f.cleaner.inspect(); expect(state.errors!.join(' ')).toContain(`Could not read compressed transcript ${compressed}`);
    await expect(f.cleaner.preview([`Codex:${ids[0]}`])).rejects.toThrow('scan errors'); expect(f.remove).not.toHaveBeenCalled();
    await expect(transcriptPrefix(compressed)).rejects.toThrow('Could not read compressed transcript');
  });
  it('bounds decompressed header reads and leaves the compressed source unchanged', async () => {
    const f = await fixture(), plain = await f.session('Codex', ids[0]!);
    const header = await readFile(plain, 'utf8'), large = Buffer.from(header + JSON.stringify({ type: 'event_msg', payload: { message: 'a'.repeat(3 * 1024 * 1024) } }) + '\n');
    await writeFile(plain, large); const file = await compress(plain), bytes = await readFile(file);
    const prefix = await transcriptPrefix(file);
    expect(prefix.truncated).toBe(true); expect(Buffer.byteLength(prefix.text)).toBe(256 * 1024); expect(prefix.text.startsWith(header)).toBe(true);
    expect(await readFile(file)).toEqual(bytes); await expect(readFile(plain)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await f.cleaner.inspect()).errors).toEqual([]);
  });
  it('recognizes old flat Codex metadata in plain and compressed rollouts without inventing a project', async () => {
    const f = await fixture(), plain = await f.session('Codex', ids[0]!), other = await f.session('Codex', ids[1]!, true);
    for (const [file, id] of [[plain, ids[0]], [other, ids[1]]] as const) {
      await writeFile(file, JSON.stringify({ id, timestamp: '2025-09-03T13:55:55Z', instructions: null, git: {} }) + '\n'); await age(file);
    }
    const compressed = await compress(other), scan = await f.cleaner.inspect();
    expect(scan.errors).toEqual([]); expect(scan.conversations).toHaveLength(2);
    expect(scan.conversations!.every(row => row.project === 'Unknown project')).toBe(true);
    const preview = await f.cleaner.preview([`Codex:${ids[0]}`, `Codex:${ids[1]}`]);
    expect(preview.plan!.conversations.flatMap(row => row.files.map(file => file.path)).sort()).toEqual([plain, compressed].sort());
  });
  it('deletes unindexed legacy Codex rollouts directly because the CLI cannot read them', async () => {
    const f = await fixture(), legacy = await f.session('Codex', ids[0]!), modern = await f.session('Codex', ids[1]!);
    await writeFile(legacy, JSON.stringify({ id: ids[0], timestamp: '2025-09-03T13:55:55Z', instructions: null, git: {} }) + '\n'); await age(legacy);
    const scan = await f.cleaner.inspect();
    expect(scan.conversations!.map(row => [row.id, row.legacy])).toEqual(expect.arrayContaining([[ids[0], true], [ids[1], undefined]]));
    const result = await f.cleaner.deleteSelected([`Codex:${ids[0]}`, `Codex:${ids[1]}`], Date.now());
    expect(result.result).toMatchObject({ failures: [] }); expect(result.result!.removed.sort()).toEqual([`Codex:${ids[0]}`, `Codex:${ids[1]}`].sort());
    expect(f.remove.mock.calls.map(([row]) => row.id)).toEqual([ids[1]]);
    await expect(readFile(legacy)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(readFile(modern)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps native deletion for legacy rollouts that Codex has indexed', async () => {
    const f = await fixture(), legacy = await f.session('Codex', ids[0]!);
    await writeFile(legacy, JSON.stringify({ id: ids[0], timestamp: '2025-09-03T13:55:55Z', instructions: null, git: {} }) + '\n'); await age(legacy);
    await writeFile(path.join(f.homes.Codex, 'session_index.jsonl'), JSON.stringify({ id: ids[0], thread_name: 'Indexed' }) + '\n');
    expect((await f.cleaner.inspect()).conversations![0]!.legacy).toBeUndefined();
    expect((await f.cleaner.deleteSelected([`Codex:${ids[0]}`], Date.now())).result!.removed).toEqual([`Codex:${ids[0]}`]);
    expect(f.remove).toHaveBeenCalledTimes(1);
  });
  it('rejects old flat metadata with an ID that disagrees with its rollout filename', async () => {
    const f = await fixture(), file = await f.session('Codex', ids[0]!);
    await writeFile(file, JSON.stringify({ id: ids[1], timestamp: '2025-09-03T13:55:55Z', instructions: null }) + '\n'); await age(file);
    expect((await f.cleaner.inspect()).errors!.join(' ')).toContain('ID does not match');
    await expect(f.cleaner.preview([`Codex:${ids[1]}`])).rejects.toThrow('scan errors'); expect(f.remove).not.toHaveBeenCalled();
  });
  it('ignores empty rollout placeholders without deleting or blocking other conversations', async () => {
    const f = await fixture(), empty = await f.session('Codex', ids[0]!); await writeFile(empty, '');
    await f.session('Codex', ids[1]!);
    const state = await f.cleaner.inspect(); expect(state.errors).toEqual([]); expect(state.conversations!.map(row => row.id)).toEqual([ids[1]]);
    const plan = (await f.cleaner.preview([`Codex:${ids[1]}`])).plan!; await f.cleaner.delete(plan.token);
    expect(await readFile(empty, 'utf8')).toBe('');
  });
  it('discovers both providers and Codex archives, previews exact files and deletes only selected history', async () => {
    const f = await fixture(), kept = await f.session('Codex', ids[0]!), archived = await f.session('Codex', ids[1]!, true), claude = await f.session('Claude', ids[2]!);
    const state = await f.cleaner.inspect(); expect(state.errors).toEqual([]); expect(state.conversations).toHaveLength(3);
    expect(state.conversations!.find(row => row.id === ids[1])?.archived).toBe(true);
    const preview = await f.cleaner.preview([`Codex:${ids[1]}`, `Claude:${ids[2]}`]);
    expect(preview.plan!.conversations.flatMap(row => row.files.map(file => file.path)).sort()).toEqual([archived, claude].sort());
    expect(f.remove).not.toHaveBeenCalled();
    const result = await f.cleaner.delete(preview.plan!.token);
    expect(result.result).toMatchObject({ removed: expect.arrayContaining([`Codex:${ids[1]}`, `Claude:${ids[2]}`]), skipped: [], failures: [] });
    expect(result.result!.bytes).toBe(preview.plan!.bytes); expect(await readFile(kept, 'utf8')).toContain(ids[0]);
    await expect(f.cleaner.delete(preview.plan!.token)).rejects.toThrow('Preview');
  });
  it('rejects changed previews and protects open, queued and recently updated sessions', async () => {
    const f = await fixture(), file = await f.session('Codex', ids[0]!), key = `Codex:${ids[0]}`;
    let plan = (await f.cleaner.preview([key])).plan!;
    await writeFile(file, await readFile(file, 'utf8') + '{}\n'); await age(file);
    await expect(f.cleaner.delete(plan.token)).rejects.toThrow('changed'); expect(f.remove).not.toHaveBeenCalled();
    f.protectedKeys.add(key); await expect(f.cleaner.preview([key])).rejects.toThrow('open');
    f.protectedKeys.clear(); plan = (await f.cleaner.preview([key])).plan!; f.protectedKeys.add(key);
    await expect(f.cleaner.delete(plan.token)).rejects.toThrow('protected'); f.protectedKeys.clear();
    await utimes(file, new Date(), new Date()); expect((await f.cleaner.inspect()).conversations![0]!.blocked).toContain('10 minutes');
    await expect(f.cleaner.preview(['../../outside'])).rejects.toThrow('changed');
  });
  it('includes spawned Codex children and keeps the parent if a child fails', async () => {
    const f = await fixture(); await f.session('Codex', ids[0]!); await f.session('Codex', ids[1]!, true, ids[0]);
    const preview = await f.cleaner.preview([`Codex:${ids[0]}`]); expect(preview.plan!.conversations).toHaveLength(2);
    f.remove.mockRejectedValueOnce(new Error('Locked transcript'));
    const result = (await f.cleaner.delete(preview.plan!.token)).result!;
    expect(result.removed).toEqual([]); expect(result.skipped).toEqual([`Codex:${ids[0]}`]); expect(result.failures[0]).toContain('Locked transcript');
    expect(f.remove).toHaveBeenCalledTimes(1); expect(f.remove.mock.calls[0]![0].id).toBe(ids[1]);
  });
  it('rejects a newly spawned child after preview and a protected child during preview', async () => {
    const f = await fixture(); await f.session('Codex', ids[0]!);
    const plan = (await f.cleaner.preview([`Codex:${ids[0]}`])).plan!;
    await f.session('Codex', ids[1]!, false, ids[0]);
    await expect(f.cleaner.delete(plan.token)).rejects.toThrow('changed');
    f.protectedKeys.add(`Codex:${ids[1]}`); await expect(f.cleaner.preview([`Codex:${ids[0]}`])).rejects.toThrow('open');
  });
  it('includes all Claude sidecar files, rejects new sidecars and deletes with the bundled SDK', async () => {
    const f = await fixture(); await f.session('Claude', ids[0]!);
    const folder = path.join(f.homes.Claude, 'projects', '-repo', ids[0]!, 'subagents'); await mkdir(folder, { recursive: true });
    const sub = path.join(folder, 'agent-child.jsonl'); await writeFile(sub, '{}\n'); await age(sub);
    let plan = (await f.cleaner.preview([`Claude:${ids[0]}`])).plan!; expect(plan.conversations[0]!.files).toHaveLength(2);
    await writeFile(path.join(folder, 'agent-child.meta.json'), '{}');
    await expect(f.cleaner.delete(plan.token)).rejects.toThrow('changed'); await age(path.join(folder, 'agent-child.meta.json'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', f.homes.Claude);
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const actual = new ConversationCleanup(row => sdk.deleteSession(row.id), () => new Set(), f.homes);
    plan = (await actual.preview([`Claude:${ids[0]}`])).plan!;
    const result = await actual.delete(plan.token);
    expect(result.result).toMatchObject({ removed: [`Claude:${ids[0]}`], failures: [] }); expect(result.conversations).toEqual([]);
  });
  it('blocks linked stores without touching their targets, and reports partial provider failures', async () => {
    const f = await fixture(); await f.session('Codex', ids[0]!); await mkdir(f.homes.Claude, { recursive: true });
    const outside = path.join(f.root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'keep.jsonl'), 'keep');
    await symlink(outside, path.join(f.homes.Claude, 'projects'), 'junction');
    const state = await f.cleaner.inspect(); expect(state.conversations).toHaveLength(1); expect(state.errors![0]).toContain('Linked');
    await expect(f.cleaner.preview([`Codex:${ids[0]}`])).rejects.toThrow('scan errors'); expect(await readFile(path.join(outside, 'keep.jsonl'), 'utf8')).toBe('keep');
  });
  it('keeps failed native deletions visible and detects a provider no-op', async () => {
    const f = await fixture(); await f.session('Codex', ids[0]!); await f.session('Claude', ids[1]!);
    const plan = (await f.cleaner.preview([`Codex:${ids[0]}`, `Claude:${ids[1]}`])).plan!;
    f.remove.mockImplementation(async row => { if (row.provider === 'Codex') throw new Error('Unsupported thread/delete'); });
    const result = (await f.cleaner.delete(plan.token)).result!;
    expect(result.removed).toEqual([]); expect(result.failures).toHaveLength(2);
    expect(result.failures.join(' ')).toContain('Unsupported'); expect(result.failures.join(' ')).toContain('did not remove');
  });
});
