import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { conversationEdits, captureConversations, type ReviewConversation } from '../src/core/review-conversations';
import { reviewGroup, fileConversations } from '../src/core/review-groups';
import { ReviewStore } from '../src/core/review';
import { ProjectConversations } from '../src/providers/conversations';
import { StorageManager } from '../src/core/storage';

const claude: ReviewConversation = { key: 'Claude:11111111-1111-4111-8111-111111111111', id: '11111111-1111-4111-8111-111111111111', provider: 'Claude', title: 'Claude edit' };
const codex: ReviewConversation = { key: 'Codex:22222222-2222-4222-8222-222222222222', id: '22222222-2222-4222-8222-222222222222', provider: 'Codex', title: 'Codex edit' };
const records = (name: string, input: unknown, at: number, failed = false) => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit-1', name, input }] } },
  { type: 'user', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'edit-1', is_error: failed, content: 'Done' }] } },
];
const patch = (input: string, at: number, output = 'Success. Updated the following files:\nM source.ts') => [
  { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch-1', input } },
  { type: 'response_item', timestamp: new Date(at).toISOString(), payload: { type: 'custom_tool_call_output', call_id: 'patch-1', output } },
];
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-conversation-review-')); folders.push(root);
  const project = path.join(root, 'project'); await mkdir(project);
  const store = new ReviewStore(path.join(root, 'storage', 'reviews'));
  const set = (name: string, text: string) => writeFile(path.join(project, name), text);
  await set('source.ts', 'old\n'); await set('other.ts', 'other\n');
  return { root, project, store, set };
}
describe('Conversation change evidence', () => {
  it('skips an overlapping delayed patch already present in the captured baseline', () => {
    const earlier = conversationEdits(patch('*** Begin Patch\n*** Update File: source.ts\n@@\n header\n+already captured\n*** End Patch', 1200), codex, '/project', '/project');
    const current = conversationEdits(records('Edit', { file_path: 'source.ts', old_string: 'old', new_string: 'new' }, 1400), claude, '/project', '/project');
    const before = 'header\nalready captured\nold\n', after = 'header\nalready captured\nnew\n';
    expect(captureConversations({ from: 1100, to: 1500 }, 'source.ts', before, after, [...earlier, ...current])).toEqual([claude]);
    expect(captureConversations({ from: 1100, to: 1500 }, 'source.ts', before, after + 'manual\n', [...earlier, ...current])).toBeUndefined();
  });
  it('matches successful Claude Edit/MultiEdit/Write by exact contents and capture interval', () => {
    const edits = conversationEdits(records('Edit', { file_path: '/project/source.ts', old_string: 'old', new_string: 'new' }, 1200), claude, '/project', '/project');
    expect(captureConversations({ from: 1000, to: 1500 }, 'source.ts', 'old\n', 'new\n', edits)).toEqual([claude]);
    expect(captureConversations({ from: 1300, to: 1500 }, 'source.ts', 'old\n', 'new\n', edits)).toBeUndefined();
    expect(captureConversations({ from: 1000, to: 1500 }, 'source.ts', 'old\n', 'manual\n', edits)).toBeUndefined();
    const multi = conversationEdits(records('MultiEdit', { file_path: 'source.ts', edits: [{ old_string: 'a', new_string: 'b', replace_all: true }, { old_string: 'b b', new_string: 'c' }] }, 1200), claude, '/project', '/project');
    expect(captureConversations({ from: 1000, to: 1500 }, 'source.ts', 'a a', 'c', multi)).toEqual([claude]);
    const write = conversationEdits(records('Write', { file_path: 'source.ts', content: 'created\n' }, 1200), claude, '/project', '/project');
    expect(captureConversations({ from: 1000, to: 1500 }, 'source.ts', undefined, 'created\n', write)).toEqual([claude]);
  });
  it('ignores failed/unfinished/undated/read/shell tools and workspace escapes', () => {
    for (const name of ['Read', 'Bash', 'exec_command']) expect(conversationEdits(records(name, { file_path: 'source.ts', content: 'new' }, 1200), claude, '/project', '/project')).toEqual([]);
    expect(conversationEdits(records('Write', { file_path: 'source.ts', content: 'new' }, 1200, true), claude, '/project', '/project')).toEqual([]);
    expect(conversationEdits(records('Write', { file_path: 'source.ts', content: 'new' }, 1200).slice(0, 1), claude, '/project', '/project')).toEqual([]);
    for (const file_path of ['../outside.ts', '/elsewhere/a.ts', '']) expect(conversationEdits(records('Write', { file_path, content: 'new' }, 1200), claude, '/project', '/project')).toEqual([]);
    const undated = records('Write', { file_path: 'source.ts', content: 'new' }, 1200); delete (undated[1] as any).timestamp;
    expect(conversationEdits(undated, claude, '/project', '/project')).toEqual([]);
  });
  it('resolves Windows and nested working directories without substring matches', () => {
    expect(conversationEdits(records('Write', { file_path: 'source.ts', content: 'new' }, 1200), claude, 'L:\\Code\\project\\src', 'L:\\Code\\project')[0]?.path).toBe('src/source.ts');
    expect(conversationEdits(records('Write', { file_path: 'L:\\Code\\project-other\\file.ts', content: 'new' }, 1200), claude, 'L:\\Code\\project', 'L:\\Code\\project')).toEqual([]);
    const recordsInSubdirectory = [{ type: 'turn_context', payload: { cwd: '/project/src' } }, ...patch('*** Begin Patch\n*** Add File: source.ts\n+new\n*** End Patch', 1200)];
    expect(conversationEdits(recordsInSubdirectory, codex, '/project', '/project')[0]?.path).toBe('src/source.ts');
  });
  it('verifies Codex patch additions/updates/deletions, including CRLF, and rejects failed or ambiguous patches', () => {
    const input = '*** Begin Patch\n*** Update File: source.ts\n@@\n-old\n+new\n*** End Patch';
    const edits = conversationEdits(patch(input, 1200), codex, '/project', '/project');
    expect(captureConversations({ from: 1000, to: 1500 }, 'source.ts', 'old\r\n', 'new\r\n', edits)).toEqual([codex]);
    expect(captureConversations({ from: 1000, to: 1500 }, 'source.ts', 'old\nold\n', 'new\nold\n', edits)).toBeUndefined();
    expect(conversationEdits(patch(input, 1200, 'Failed to find expected lines'), codex, '/project', '/project')).toEqual([]);
    const add = conversationEdits(patch('*** Begin Patch\n*** Add File: source.ts\n+new\n*** End Patch', 1200), codex, '/project', '/project');
    expect(captureConversations({ from: 1000, to: 1500 }, 'source.ts', undefined, 'new\n', add)).toEqual([codex]);
    const del = conversationEdits(patch('*** Begin Patch\n*** Delete File: source.ts\n*** End Patch', 1200), codex, '/project', '/project');
    expect(captureConversations({ from: 1000, to: 1500 }, 'source.ts', 'old\n', undefined, del)).toEqual([codex]);
  });
  it('retains all contributors to a verified transition across conversations', () => {
    const first = conversationEdits(records('Edit', { file_path: 'source.ts', old_string: 'old', new_string: 'middle' }, 1200), claude, '/project', '/project');
    const second = conversationEdits(patch('*** Begin Patch\n*** Update File: source.ts\n@@\n-middle\n+new\n*** End Patch', 1300), codex, '/project', '/project');
    expect(captureConversations({ from: 1000, to: 1500 }, 'source.ts', 'old\n', 'new\n', [...first, ...second])).toEqual([claude, codex]);
  });
  it.each(['@@\n-old\n+new', '@@\n keep\n-old\n+new\n tail'])('preserves mixed line endings while verifying patch evidence: %s', chunk => {
    const before = 'head\r\nkeep\nold\r\ntail\n', after = 'head\r\nkeep\nnew\r\ntail\n';
    const edits = conversationEdits(patch(`*** Begin Patch\n*** Update File: source.ts\n${chunk}\n*** End Patch`, 1200), codex, '/project', '/project');
    expect(captureConversations({ from: 1000, to: 1500 }, 'source.ts', before, after, edits)).toEqual([codex]);
    expect(captureConversations({ from: 1000, to: 1500 }, 'source.ts', before, after.replace(/\r?\n/g, '\r\n'), edits)).toBeUndefined();
  });
});
describe('Conversation review ownership', () => {
  it('links script output and binary files explicitly, persists the links, and removes only the selected manual links', async () => {
    const f = await fixture();
    await mkdir(path.join(f.project, 'media')); await mkdir(path.join(f.project, 'tests'));
    const names = ['media/provider-icons.ttf', 'media/screenshots.png', 'tests/quota-status-bar.test.ts', 'tests/settings.test.ts', 'tests/status-bar-preferences.test.ts'];
    await f.set(names[1]!, '\0old image');
    for (const name of names.slice(2)) await f.set(name, 'old test\n');
    await f.store.initializeExternalTracking(f.project);
    for (const [i, name] of names.entries()) await f.set(name, i < 2 ? `\0binary ${i}` : 'new test\r\n');
    const pending = await f.store.scanExternal(f.project), request = { project: f.project, revision: pending.revision, group: 'unassigned' };
    const snapshots = pending.files.map(file => [file.path, file.before, file.after]);
    const linked = await f.store.setConversationLink(request, codex);
    expect(linked.files).toHaveLength(5); expect(linked.files.filter(file => file.binary)).toHaveLength(2);
    expect(linked.files.map(reviewGroup)).toEqual(Array(5).fill(codex.key));
    expect(linked.files.every(file => file.captures?.every(capture => capture.assignment === 'manual'))).toBe(true);
    expect(linked.files.map(file => [file.path, file.before, file.after])).toEqual(snapshots);
    const reloaded = new ReviewStore(f.store.directory);
    expect((await reloaded.read(f.project)).files).toEqual(linked.files);
    await expect(reloaded.setConversationLink(request, codex)).rejects.toThrow('updated');
    const unlinked = await reloaded.setConversationLink({ ...request, revision: linked.revision, group: codex.key, file: names[0] });
    expect(unlinked.files.filter(file => reviewGroup(file) === 'unassigned').map(file => file.path)).toEqual([names[0]]);
    expect(unlinked.files.filter(file => reviewGroup(file) === codex.key)).toHaveLength(4);
    expect(await readFile(path.join(f.project, names[0]!), 'utf8')).toBe('\0binary 0');
    expect((await reloaded.scanExternal(f.project)).files.map(file => [file.path, file.before, file.after])).toEqual(snapshots);
  });
  it('keeps native ownership on shared files when adding and removing explicit links', async () => {
    const f = await fixture(); await f.store.initializeExternalTracking(f.project);
    await f.store.begin(f.project, 'native', undefined, claude); await f.set('source.ts', 'native\n'); await f.store.finish(f.project, 'native');
    await f.set('source.ts', 'script\n'); const pending = await f.store.scanExternal(f.project);
    const linked = await f.store.setConversationLink({ project: f.project, revision: pending.revision, group: 'shared' }, codex);
    expect(fileConversations(linked.files[0]!)).toEqual([claude, codex]);
    const unlinked = await f.store.setConversationLink({ project: f.project, revision: linked.revision, file: 'source.ts' });
    expect(fileConversations(unlinked.files[0]!)).toEqual([claude]);
    expect(reviewGroup(unlinked.files[0]!)).toBe('shared');
    expect(unlinked.files[0]!.captures![0]!.assignment).toBeUndefined();
    expect(await readFile(path.join(f.project, 'source.ts'), 'utf8')).toBe('script\n');
    await f.store.begin(f.project, 'busy');
    await expect(f.store.setConversationLink({ project: f.project, revision: unlinked.revision }, codex)).rejects.toThrow('Wait for the agent');
  });
  it('repairs saved captures when successful patch output arrives after a long wrapper', async () => {
    const f = await fixture(); await f.store.initializeExternalTracking(f.project);
    const startedAt = Date.now(); await f.set('source.ts', 'new\n');
    const pending = await f.store.scanExternal(f.project);
    const input = `text(await tools.apply_patch(${JSON.stringify('*** Begin Patch\n*** Update File: source.ts\n@@\n-old\n+new\n*** End Patch')}));`;
    const edits = conversationEdits([
      { type: 'response_item', timestamp: new Date(startedAt).toISOString(), payload: { type: 'custom_tool_call', name: 'exec', call_id: 'long', input } },
      { type: 'response_item', timestamp: new Date(Date.now() + 60000).toISOString(), payload: { type: 'custom_tool_call_output', call_id: 'long', output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: '{}' }] } },
    ], codex, f.project, f.project);
    const grouped = await new ReviewStore(f.store.directory).attributeConversations(f.project, edits);
    expect(grouped.files.map(reviewGroup)).toEqual([codex.key]);
    expect(grouped.files[0]!.before).toBe(pending.files[0]!.before);
    expect(grouped.files[0]!.after).toBe(pending.files[0]!.after);
    expect(await readFile(path.join(f.project, 'source.ts'), 'utf8')).toBe('new\n');
  });
  it('repairs previously unassigned captures from wrapped exec history after reload without changing snapshots', async () => {
    const f = await fixture(); await f.store.initializeExternalTracking(f.project);
    await f.set('source.ts', 'new\n'); const at = Date.now(), pending = await f.store.scanExternal(f.project);
    expect(pending.files.map(reviewGroup)).toEqual(['unassigned']);
    const input = `text(await tools.apply_patch(${JSON.stringify('*** Begin Patch\n*** Update File: source.ts\n@@\n-old\n+new\n*** End Patch')}));`;
    const edits = conversationEdits([
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec', input } },
      { type: 'response_item', timestamp: new Date(at).toISOString(), payload: { type: 'custom_tool_call_output', call_id: 'exec', output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: '{}' }] } },
    ], codex, f.project, f.project);
    const reloaded = new ReviewStore(f.store.directory), matched = await reloaded.attributeConversations(f.project, edits);
    expect(matched.files.map(reviewGroup)).toEqual([codex.key]);
    expect(matched.files[0]!.before).toBe(pending.files[0]!.before); expect(matched.files[0]!.after).toBe(pending.files[0]!.after);
    expect(await readFile(path.join(f.project, 'source.ts'), 'utf8')).toBe('new\n');
    expect((await new ReviewStore(f.store.directory).read(f.project)).files).toEqual(matched.files);
  });
  it('persists native conversation identity, binds drafts and limits grouped decisions/editor navigation', async () => {
    const f = await fixture(); await f.store.initializeExternalTracking(f.project);
    await f.store.begin(f.project, 'first', undefined, { ...claude, key: 'Claude:draft', id: '' }); await f.set('source.ts', 'claude\n');
    await f.store.bindConversation(f.project, 'Claude:draft', claude); await f.store.finish(f.project, 'first');
    await f.store.begin(f.project, 'second', undefined, codex); await f.set('other.ts', 'codex\n'); const captured = await f.store.finish(f.project, 'second');
    const reloaded = new ReviewStore(f.store.directory);
    expect((await reloaded.read(f.project)).files.map(reviewGroup)).toEqual([codex.key, claude.key]);
    expect((await reloaded.editorFiles({ project: f.project, revision: captured.revision, group: claude.key })).map(file => file.path)).toEqual(['source.ts']);
    const remaining = await reloaded.accept({ project: f.project, revision: captured.revision, group: claude.key });
    expect(remaining.files.map(file => file.path)).toEqual(['other.ts']);
    await expect(reloaded.revert({ project: f.project, revision: remaining.revision, file: 'other.ts', group: claude.key })).rejects.toThrow('already been reviewed');
    await reloaded.revert({ project: f.project, revision: remaining.revision, group: codex.key });
    expect(await readFile(path.join(f.project, 'source.ts'), 'utf8')).toBe('claude\n');
    expect(await readFile(path.join(f.project, 'other.ts'), 'utf8')).toBe('other\n');
    expect((await reloaded.scanExternal(f.project)).files).toEqual([]);
  });
  it('links delayed external history after reload; protects shared files and intermediate evidence from cleanup', async () => {
    const f = await fixture(); await f.store.initializeExternalTracking(f.project);
    await f.set('source.ts', 'middle\n'); const at = Date.now(); await f.store.scanExternal(f.project);
    await new Promise(resolve => setTimeout(resolve, 10));
    await f.set('source.ts', 'new\n'); const next = Date.now(); const pending = await f.store.scanExternal(f.project);
    const edits = [...conversationEdits(records('Edit', { file_path: 'source.ts', old_string: 'old', new_string: 'middle' }, at), claude, f.project, f.project), ...conversationEdits(patch('*** Begin Patch\n*** Update File: source.ts\n@@\n-middle\n+new\n*** End Patch', next), codex, f.project, f.project)];
    const reloaded = new ReviewStore(f.store.directory), grouped = await reloaded.attributeConversations(f.project, edits);
    expect(grouped.revision).not.toBe(pending.revision); expect(grouped.files.map(reviewGroup)).toEqual(['shared']);
    expect(fileConversations(grouped.files[0]!).map(item => item.key)).toEqual([claude.key, codex.key]);
    const intermediate = grouped.files[0]!.captures![0]!.after!;
    const age = async (folder: string) => { for (const entry of await readdir(folder, { withFileTypes: true })) { const full = path.join(folder, entry.name); if (entry.isDirectory()) await age(full); else await utimes(full, new Date(0), new Date(0)); } };
    await age(path.dirname(f.store.directory));
    const manager = new StorageManager(path.dirname(f.store.directory));
    const cleanup = await manager.preview(); expect(cleanup.files.some(file => file.relative.endsWith(intermediate))).toBe(false);
    await manager.cleanup(cleanup); expect(await reloaded.history.readBlob(intermediate)).toBeTruthy();
    await reloaded.revert({ project: f.project, revision: grouped.revision, group: 'shared' });
    expect(await readFile(path.join(f.project, 'source.ts'), 'utf8')).toBe('old\n');
  });
  it('never assigns manual bytes or pre-baseline history to the current conversation', async () => {
    const f = await fixture(); await f.store.initializeExternalTracking(f.project);
    await f.set('source.ts', 'manual\n'); await f.store.scanExternal(f.project);
    const edits = conversationEdits(records('Write', { file_path: 'source.ts', content: 'manual\n' }, Date.now() - 100000), claude, f.project, f.project);
    expect((await f.store.attributeConversations(f.project, edits)).files.map(reviewGroup)).toEqual(['unassigned']);
  });
  it('binds a new native session without moving an existing conversation’s pending changes into its branch', async () => {
    const f = await fixture(), branch = { ...claude, key: 'Claude:branch', id: 'branch' };
    await f.store.begin(f.project, 'original', undefined, claude); await f.set('source.ts', 'original\n'); await f.store.finish(f.project, 'original');
    await f.store.begin(f.project, 'branch', undefined, claude); await f.store.bindConversation(f.project, claude.key, branch);
    await f.set('other.ts', 'branch\n'); const review = await f.store.finish(f.project, 'branch');
    expect(review.files.map(file => [file.path, reviewGroup(file)])).toEqual([['other.ts', branch.key], ['source.ts', claude.key]]);
  });
  it('advances attribution intervals for decided files while preserving evidence for other files', async () => {
    const f = await fixture(); await f.store.initializeExternalTracking(f.project);
    await f.set('source.ts', 'accepted\n'); const captured = await f.store.scanExternal(f.project);
    await new Promise(resolve => setTimeout(resolve, 10));
    const beforeDecision = Date.now();
    await f.store.accept({ project: f.project, revision: captured.revision, file: 'source.ts' });
    await f.set('source.ts', 'manual\n'); await f.set('other.ts', 'other manual\n');
    const next = await f.store.scanExternal(f.project);
    expect(next.files.find(file => file.path === 'source.ts')!.captures![0]!.from).toBeGreaterThanOrEqual(beforeDecision);
    expect(next.files.find(file => file.path === 'other.ts')!.captures![0]!.from).toBeLessThan(beforeDecision);
    const old = conversationEdits(records('Write', { file_path: 'source.ts', content: 'manual\n' }, beforeDecision - 1), claude, f.project, f.project);
    expect((await f.store.attributeConversations(f.project, old)).files.map(reviewGroup)).toEqual(['unassigned', 'unassigned']);
  });
  it('reads timestamped Claude/Codex local edit history through the indexed native sessions', async () => {
    const f = await fixture(), home = path.join(f.root, 'claude'), nativeCodex = path.join(f.root, 'codex');
    await mkdir(path.join(home, 'projects', 'workspace'), { recursive: true }); await mkdir(path.join(nativeCodex, 'sessions'), { recursive: true });
    const now = Date.now();
    await writeFile(path.join(home, 'projects', 'workspace', `${claude.id}.jsonl`), records('Write', { file_path: 'source.ts', content: 'new\n' }, now).map(record => JSON.stringify(record)).join('\n') + '\n');
    await writeFile(path.join(nativeCodex, 'sessions', 'rollout.jsonl'), [
      { type: 'session_meta', payload: { id: codex.id, cwd: f.project } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'wrapped', input: `text(await tools.apply_patch(${JSON.stringify('*** Begin Patch\n*** Update File: source.ts\n@@\n-old\n+new\n*** End Patch')}));` } },
      { type: 'response_item', timestamp: new Date(now).toISOString(), payload: { type: 'custom_tool_call_output', call_id: 'wrapped', output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: '{}' }] } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const source = new ProjectConversations(async () => ({ listSessions: async () => [{ sessionId: claude.id, summary: claude.title, cwd: f.project, lastModified: now }], getSessionMessages: async () => [] }), nativeCodex, home);
    const index = await source.list(f.project); expect(index.conversations).toHaveLength(2);
    for (const conversation of index.conversations) expect(await source.edits(conversation, f.project)).toMatchObject([{ path: 'source.ts', conversation: { key: conversation.key }, timestamp: now }]);
  });
});
