import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
await mkdir('artifacts', { recursive: true });
await build({ entryPoints: ['src/providers/conversations.ts'], outfile: 'artifacts/conversations.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node20' });
const { ProjectConversations } = await import(pathToFileURL(path.resolve('artifacts/conversations.cjs')).href);
const sdk = await import(pathToFileURL(path.resolve('dist/claude-history.mjs')).href);
const project = path.resolve(process.argv[2] || '.');
const history = new ProjectConversations(async () => sdk);
const index = await history.list(project);
const sessions = [];
for (const conversation of index.conversations) {
  const content = await history.read(conversation, project);
  sessions.push({ provider: conversation.provider, id: conversation.id, cwd: conversation.cwd, messages: content.messages.length,
    user: content.messages.filter(message => message.role === 'user').length,
    assistant: content.messages.filter(message => message.role === 'assistant').length,
    tools: content.messages.filter(message => message.role === 'tool').length,
    notice: content.notice });
}
// Verification reports contain counts, never conversation text or credentials.
const report = { project, success: !index.errors.length, errors: index.errors, sessions };
await writeFile('artifacts/conversation-sync.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (index.errors.length) process.exitCode = 1;
