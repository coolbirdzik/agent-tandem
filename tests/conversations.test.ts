import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink, truncate } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { ProjectConversations, belongsToProject, projectHistoryAllowed, claudeMessages, codexMessages, type ClaudeHistoryAPI } from '../src/providers/conversations';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const empty: ClaudeHistoryAPI = { listSessions: async () => [], getSessionMessages: async () => [] };
const line = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + '\n';
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdock-history-')); roots.push(root);
  const dir = path.join(root, 'sessions', '2026', '10', '07'); await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'rollout.jsonl');
  await writeFile(file, line('session_meta', { id: 'session-1', cwd: 'L:\\Code\\agent-dock' }) + line('event_msg', { type: 'user_message', message: 'Fix login', client_id: 'u1' }) + line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }], id: 'a1' }));
  return { root, file };
}
describe('Project conversation sync', () => {
  it('uses native Codex titles/current root, skips archived sessions and refreshes renames', async () => {
    const { root, file } = await fixture();
    const database = new DatabaseSync(path.join(root, 'state_5.sqlite'));
    try {
      database.exec('CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, archived INTEGER)');
      database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run('session-1', 'L:\\Code\\moved', 'Native renamed chat', 0);
      const reader = new ProjectConversations(async () => empty, root);
      expect((await reader.list('L:\\Code\\agent-dock')).conversations).toEqual([]);
      const original = (await reader.list('L:\\Code\\moved')).conversations[0]!;
      expect(original.title).toBe('Native renamed chat'); expect(original.cwd).toBe('L:\\Code\\moved');
      expect((await reader.read(original, original.cwd)).messages[0]!.text).toBe('Fix login');
      database.prepare('UPDATE threads SET title = ?').run('Renamed again');
      const updated = (await reader.list(original.cwd)).conversations[0]!;
      expect(updated.title).toBe('Renamed again'); expect(updated.revision).not.toBe(original.revision);
      database.exec('UPDATE threads SET archived = 1'); expect((await reader.list(original.cwd)).conversations).toEqual([]);
    } finally { database.close(); }
    expect(file).toContain('rollout');
  });
  it('uses the latest native name index and still lists transcripts larger than the read limit', async () => {
    const { root, file } = await fixture();
    await writeFile(path.join(root, 'session_index.jsonl'), JSON.stringify({ id: 'session-1', thread_name: 'Old name' }) + '\n' + JSON.stringify({ id: 'session-1', thread_name: 'Latest native name' }) + '\n{partial');
    await truncate(file, 129 * 1024 * 1024);
    const reader = new ProjectConversations(async () => empty, root), index = await reader.list('L:\\Code\\agent-dock');
    expect(index.errors).toEqual([]); expect(index.conversations[0]!.title).toBe('Latest native name');
    await expect(reader.read(index.conversations[0]!, 'L:\\Code\\agent-dock')).rejects.toThrow('128 MiB');
  });
  it('finds Claude sessions with missing cwd via scoped discovery, merges nested sessions and tolerates a failed global index', async () => {
    const sdk: ClaudeHistoryAPI = {
      listSessions: async options => options.dir ? [{ sessionId: 'missing', summary: 'Native Claude chat', lastModified: 2 }] : [{ sessionId: 'nested', cwd: '/repo/src', summary: 'Nested', lastModified: 1 }, { sessionId: 'other', cwd: '/private', summary: 'Elsewhere', lastModified: 3 }],
      getSessionMessages: async (_id, options) => [{ uuid: 'u', type: 'user', message: { content: options.dir } }],
    };
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentdock-scope-')); roots.push(root);
    const reader = new ProjectConversations(async () => sdk, root);
    const index = await reader.list('/repo'); expect(index.conversations.map(row => row.id)).toEqual(['missing', 'nested']);
    expect((await reader.read(index.conversations[0]!, '/repo')).messages[0]!.text).toBe('/repo');
    sdk.listSessions = async options => { if (!options.dir) throw new Error('Global index failed'); return [{ sessionId: 'missing', summary: 'Still available', lastModified: 2 }]; };
    expect((await reader.list('/repo')).conversations[0]!.title).toBe('Still available');
  });
  it('matches canonical directory aliases for both providers and can read those sessions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentdock-alias-')); roots.push(root);
    const canonical = path.join(root, 'canonical'), alias = path.join(root, 'alias'), home = path.join(root, 'codex');
    await mkdir(canonical); await symlink(canonical, alias, process.platform === 'win32' ? 'junction' : 'dir'); await mkdir(path.join(home, 'sessions'), { recursive: true });
    await writeFile(path.join(home, 'sessions/a.jsonl'), line('session_meta', { id: 'c', cwd: canonical }) + line('event_msg', { type: 'user_message', message: 'Alias session' }));
    const sdk: ClaudeHistoryAPI = { listSessions: async () => [{ sessionId: 'a', cwd: canonical, summary: 'Alias Claude', lastModified: 1 }], getSessionMessages: async () => [] };
    const reader = new ProjectConversations(async () => sdk, home), index = await reader.list(alias);
    expect(index.conversations.map(row => row.provider).sort()).toEqual(['Claude', 'Codex']);
    for (const conversation of index.conversations) await expect(reader.read(conversation, alias)).resolves.toBeDefined();
  });
  it('retains the scoped transcript directory when global metadata reports a changed cwd', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentdock-claude-cwd-')); roots.push(root);
    const sdk: ClaudeHistoryAPI = {
      listSessions: async options => [{ sessionId: 'changed-cwd', cwd: '/repo/src', summary: 'Claude workspace conversation', lastModified: 1 }],
      getSessionMessages: async (_id, options) => options.dir === '/repo' ? [{ uuid: 'u1', type: 'user', message: { content: 'Original workspace conversation' } }] : [],
    };
    const reader = new ProjectConversations(async () => sdk, root);
    const index = await reader.list('/repo');
    expect(index.conversations).toHaveLength(1);
    expect((await reader.read(index.conversations[0]!, '/repo')).messages[0]?.text).toBe('Original workspace conversation');
  });
  const plugins = '<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n\n- Dropbox (app-69b31dc2110c8191b8b47dc98fe5a052@openai-curated-remote)\n- GitHub (github@openai-curated-remote)\n</recommended_plugins>';
  const environment = '<environment_context>\n  <cwd>H:\\Code\\aot-new</cwd>\n  <shell>powershell</shell>\n  <current_date>2026-10-08</current_date>\n  <timezone>Asia/Saigon</timezone>\n  <filesystem><workspace_roots><root>H:\\Code\\aot-new</root></workspace_roots><permission_profile type="managed"><file_system type="restricted" /></permission_profile></filesystem>\n</environment_context>';
  const response = (text: string, id: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', id, content: [{ type: 'input_text', text }] } });
  it.each([null, 'page-123'])('hides automatic open-page context in response-only history (page_id=%s)', page_id => {
    const page = `<external_codex_apps_open_page>${JSON.stringify({ page_id })}</external_codex_apps_open_page>`;
    const records = [response(page, 'page'), response(`${environment}\n${page}`, 'combined'), response('Fix login', 'u1')];
    expect(codexMessages(records).map(message => message.text)).toEqual(['Fix login']);
    expect(codexMessages([{ type: 'event_msg', payload: { type: 'user_message', client_id: 'human', message: page } }])).toMatchObject([{ id: 'human', role: 'user', text: page }]);
  });
  it('keeps open-page examples, malformed context and real requests containing a page block', () => {
    const page = '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';
    const texts = [`Explain this: ${page}`, `${page}\nFix login`, `\`\`\`xml\n${page}\n\`\`\``, '<external_codex_apps_open_page>Example</external_codex_apps_open_page>', '<external_codex_apps_open_page>{"page_id":42}</external_codex_apps_open_page>', '<external_codex_apps_open_page>{"page_id":null,"request":"Fix login"}</external_codex_apps_open_page>'];
    expect(codexMessages(texts.map((text, index) => response(text, `u${index}`))).map(message => message.text)).toEqual(texts);
  });
  it('hides injected plugin/environment context in response-only history while retaining actual prompts, replies and tools', () => {
    const records = [response(plugins, 'plugins'), response(environment, 'env'), response(`${plugins}\n${environment}`, 'combined'), response('Fix the login bug', 'u1'),
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'a1', content: [{ type: 'output_text', text: 'Done' }] } },
      { type: 'response_item', payload: { type: 'function_call', id: 't1', name: 'exec', arguments: environment } }];
    expect(codexMessages(records).map(message => [message.role, message.id])).toEqual([['user', 'u1'], ['assistant', 'a1'], ['tool', 't1']]);
    expect(codexMessages(records).at(-1)?.text).toBe(environment);
  });
  it('keeps human questions, code samples, incomplete blocks and arbitrary XML using the same tag names', () => {
    const texts = [`why does this message appear as if I sent it ${plugins}\n${environment}`, `${environment}\nExplain this`, `\`\`\`xml\n${environment}\n\`\`\``, '<environment_context>Example for my parser</environment_context>', '<recommended_plugins>My plugin list</recommended_plugins>', '<environment_context><cwd>/project</cwd>'];
    expect(codexMessages(texts.map((text, index) => response(text, `u${index}`))).map(message => message.text)).toEqual(texts);
  });
  it('trusts explicit human user events even when the user pastes a complete context block', () => {
    const text = `${plugins}\n${environment}`;
    expect(codexMessages([response(text, 'response'), { type: 'event_msg', payload: { type: 'user_message', client_id: 'human', message: text } }])).toMatchObject([{ id: 'human', role: 'user', text }]);
  });
  it('uses the first real request as the title and keeps filtering after history refresh', async () => {
    const { root, file } = await fixture();
    await writeFile(file, line('session_meta', { id: 'session-1', cwd: 'L:\\Code\\agent-dock' }) + [response(`${plugins}\n${environment}`, 'context'), response('Fix login', 'u1')].map(record => JSON.stringify(record) + '\n').join(''));
    const reader = new ProjectConversations(async () => empty, root);
    let conversation = (await reader.list('L:\\Code\\agent-dock')).conversations[0]!;
    expect(conversation.title).toBe('Fix login');
    expect((await reader.read(conversation, conversation.cwd)).messages.map(message => message.text)).toEqual(['Fix login']);
    await appendFile(file, JSON.stringify(response(environment, 'context-later')) + '\n' + JSON.stringify(response('Add tests', 'u2')) + '\n');
    conversation = (await reader.list(conversation.cwd)).conversations[0]!;
    expect((await reader.read(conversation, conversation.cwd)).messages.map(message => message.text)).toEqual(['Fix login', 'Add tests']);
  });
  it('matches Windows case, subdirectories and extended paths, excludes sibling projects', () => {
    expect(belongsToProject('l:\\code\\AGENT-DOCK\\src', 'L:\\Code\\agent-dock\\')).toBe(true);
    expect(belongsToProject('\\\\?\\L:\\Code\\agent-dock', 'L:\\Code\\agent-dock')).toBe(true);
    expect(belongsToProject('\\\\?\\UNC\\server\\share\\repo', '\\\\server\\share\\repo')).toBe(true);
    expect(belongsToProject('L:\\Code\\agent-dock-other', 'L:\\Code\\agent-dock')).toBe(false);
    expect(belongsToProject('/repo/child', '/repo')).toBe(true);
    expect(belongsToProject('/repo-other', '/repo')).toBe(false);
  });
  it('reads existing Codex history, then syncs appended messages with stable keys', async () => {
    const { root, file } = await fixture(), reader = new ProjectConversations(async () => empty, root);
    const initial = await reader.list('L:\\Code\\agent-dock');
    expect(initial.errors).toEqual([]); expect(initial.conversations).toHaveLength(1);
    const original = initial.conversations[0]!;
    expect(original.title).toBe('Fix login');
    expect((await reader.read(original, original.cwd)).messages.map(item => item.text)).toEqual(['Fix login', 'Done']);
    await appendFile(file, line('event_msg', { type: 'user_message', message: 'Add tests', client_id: 'u2' }));
    const updated = (await reader.list(original.cwd)).conversations[0]!;
    expect(updated.key).toBe(original.key); expect(updated.revision).not.toBe(original.revision);
    expect((await reader.read(updated, original.cwd)).messages.at(-1)?.text).toBe('Add tests');
    expect((await reader.list('L:\\Code\\other')).conversations).toEqual([]);
  });
  it('skips incomplete records while a writer appends, and picks up completed records', async () => {
    const { root, file } = await fixture(), reader = new ProjectConversations(async () => empty, root);
    await appendFile(file, '{"type":"event_msg","payload":');
    let session = (await reader.list('L:\\Code\\agent-dock')).conversations[0]!;
    expect((await reader.read(session, session.cwd)).notice).toMatch(/incomplete/i);
    await appendFile(file, '{"type":"user_message","message":"Finished write"}}\n');
    session = (await reader.list(session.cwd)).conversations[0]!;
    const content = await reader.read(session, session.cwd);
    expect(content.notice).toBeUndefined(); expect(content.messages.at(-1)?.text).toBe('Finished write');
  });
  it('keeps Claude available when Codex history fails, and filters Claude by project boundary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentdock-history-')); roots.push(root);
    await writeFile(path.join(root, 'sessions'), 'not a directory');
    const sdk: ClaudeHistoryAPI = {
      listSessions: async () => [{ sessionId: 'c1', cwd: 'L:\\Code\\agent-dock\\nested', summary: 'Claude chat', lastModified: 1 }, { sessionId: 'c2', cwd: 'L:\\Code\\else', summary: 'Private other project', lastModified: 2 }],
      getSessionMessages: async () => [{ uuid: 'm1', type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }],
    };
    const reader = new ProjectConversations(async () => sdk, root), index = await reader.list('L:\\Code\\agent-dock');
    expect(index.errors).toHaveLength(1); expect(index.conversations.map(item => item.id)).toEqual(['c1']);
    expect((await reader.read(index.conversations[0]!, 'L:\\Code\\agent-dock')).messages[0]?.text).toBe('Hello');
    await expect(reader.read(index.conversations[0]!, 'L:\\Code\\else')).rejects.toThrow(/does not belong/);
  });
  it('does not duplicate Codex event and response messages or show internal instructions/reasoning', () => {
    const payloads = [
      { type: 'event_msg', payload: { type: 'user_message', message: 'Hi' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'Hi' }] } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Hello' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'Hello' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text: 'Internal' }] } },
      { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'hidden' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: '{"cmd":"test"}', call_id: 't1' } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'Passed', call_id: 't1' } },
    ];
    const messages = codexMessages(payloads);
    expect(messages.map(item => item.text)).toEqual(['Hi', 'Hello', '{"cmd":"test"}', 'Passed']);
    expect(messages[2]?.toolCallId).toBe('t1');
  });
  it('honors Codex rolled-back user turns', () => {
    const records = ['first', 'second', 'third'].map(message => ({ type: 'event_msg', payload: { type: 'user_message', message } }));
    expect(codexMessages([...records, { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 2 } }]).map(item => item.text)).toEqual(['first']);
  });
  it('maps Claude tool blocks and outputs without exposing thinking blocks', () => {
    const messages = claudeMessages([{ uuid: 'a', type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Internal' }, { type: 'text', text: 'Editing' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts' } }] } }, { uuid: 'u', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Applied' }] }] } }]);
    expect(messages.map(message => message.role)).toEqual(['assistant', 'tool', 'tool']);
    expect(messages[2]?.text).toBe('Applied'); expect(messages[2]?.toolCallId).toBe('t1');
  });
});


it('excludes only known AgentDock test run folders from a parent project, keeps normal nested chats and direct test workspaces', () => {
  const project = 'L:\\Code\\agent-dock';
  const fixture = project + '\\.test-runtime\\models-live-123\\workspace';
  expect(projectHistoryAllowed(fixture, project)).toBe(false);
  expect(projectHistoryAllowed(fixture, fixture)).toBe(true);
  expect(projectHistoryAllowed(project + '\\src', project)).toBe(true);
  expect(projectHistoryAllowed('/repo/.test-runtime/edit-live-123/workspace', '/repo')).toBe(false);
  expect(projectHistoryAllowed('/repo/.test-runtime/my-real-project', '/repo')).toBe(true);
});
it('filters old test histories for both providers without hiding a user who pasted MODEL_OK', async () => {
  const store = await mkdtemp(path.join(os.tmpdir(), 'agentdock-test-history-')); roots.push(store);
  await mkdir(path.join(store, 'sessions'));
  const fixture = '/repo/.test-runtime/models-live-123/workspace';
  await writeFile(path.join(store, 'sessions/test.jsonl'), line('session_meta', { id: 'code-test', cwd: fixture }) + line('event_msg', { type: 'user_message', message: 'MODEL_OK' }));
  const sdk: ClaudeHistoryAPI = { listSessions: async () => [
    { sessionId: 'real', summary: 'Reply with exactly MODEL_OK', cwd: '/repo', lastModified: 1 },
    { sessionId: 'test', summary: 'MODEL_OK', cwd: fixture, lastModified: 2 },
  ], getSessionMessages: async () => [] };
  const reader = new ProjectConversations(async () => sdk, store);
  expect((await reader.list('/repo')).conversations.map(row => row.key)).toEqual(['Claude:real']);
  expect((await reader.list(fixture)).conversations.map(row => row.key).sort()).toEqual(['Claude:test', 'Codex:code-test']);
});
