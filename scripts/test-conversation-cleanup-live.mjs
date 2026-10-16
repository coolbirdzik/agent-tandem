import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

// No credentials or real history are copied. All mutations target this isolated run.
const root = path.resolve('.test-runtime', `conversation-cleanup-${Date.now()}`);
await mkdir(root, { recursive: true });
const imports = name => JSON.stringify(path.resolve(name).replaceAll('\\', '/'));
const source = `
import assert from 'node:assert/strict';
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { ConversationCleanup } from ${imports('src/core/conversation-cleanup.ts')};
import { deleteCodexThread } from ${imports('src/providers/codex-history-mutation.ts')};
import { findExecutable } from ${imports('src/providers/probe.ts')};
import { zstdCompressSync } from 'node:zlib';
async function main() {
const root = process.env.CLEANUP_TEST_ROOT;
const homes = { Codex: process.env.CODEX_HOME, Claude: process.env.CLAUDE_CONFIG_DIR };
const id = '11111111-1111-4111-8111-111111111111';
const dir = path.join(homes.Codex, 'archived_sessions'); await mkdir(dir, { recursive:true });
const compressed = ${process.argv.includes('--compressed')};
const file = path.join(dir, 'rollout-2026-01-01T00-00-00-'+id+'.jsonl'+(compressed?'.zst':''));
const transcript = JSON.stringify({timestamp:'2026-01-01T00:00:00Z',type:'session_meta', payload:{id,session_id:id,cwd:root,timestamp:'2026-01-01T00:00:00Z',originator:'codex_cli_rs',cli_version:'0.1.0',source:'cli',model_provider:'openai',base_instructions:{text:'Isolated cleanup fixture'}}})+'\\n'+JSON.stringify({timestamp:'2026-01-01T00:00:01Z',type:'event_msg',payload:{type:'user_message',message:'Cleanup fixture',images:[],local_images:[],text_elements:[]}})+'\\n';
await writeFile(file, compressed ? zstdCompressSync(Buffer.from(transcript)) : transcript);
const date = new Date(Date.now()-60*86400000); await utimes(file,date,date);
const executable = await findExecutable('codex');
const cleaner = new ConversationCleanup(row => deleteCodexThread(executable,row.id),()=>new Set(),homes);
const preview = await cleaner.preview(['Codex:'+id]); assert.equal(preview.plan.conversations.length,1);
assert.equal(preview.plan.conversations[0].lastMessageAt, Date.parse('2026-01-01T00:00:01Z'));
const result = await cleaner.deleteSelected(['Codex:'+id], Date.now()-30*86400000);
await writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));
assert.deepEqual(result.result.failures,[]); assert.deepEqual(result.result.removed,['Codex:'+id]);
console.log('NATIVE_CONVERSATION_CLEANUP_OK');
}
main().catch(error => { console.error(error); process.exitCode=1; });
`;
const script = path.join(root, 'run.cjs');
await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: 'ts' }, outfile: script, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
await writeFile(path.join(root, 'test-info.json'), JSON.stringify({ root, purpose: 'Isolated native conversation deletion; no user history copied.' }, null, 2));
const child = spawn(process.execPath, [script], { windowsHide: true, stdio: 'inherit', env: { ...process.env, CLEANUP_TEST_ROOT: root, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') } });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
console.log('Test artifacts:', root); process.exitCode = code ?? 1;
