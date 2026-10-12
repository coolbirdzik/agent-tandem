import { mkdir, appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderChatRequest, ChatCallbacks } from '../../src/providers/chat';
import { claudeContent } from '../../src/providers/chat-input';
let active = 0;
export async function run(request: ProviderChatRequest, callbacks: ChatCallbacks, signal: AbortSignal) {
  const control = process.env.AGENT_DOCK_QUEUE_CONTROL!, provider = request.provider;
  const id = request.conversationKey?.split(':').slice(1).join(':') || randomUUID();
  const transcript = provider === 'Codex' ? path.join(process.env.CODEX_HOME!, 'sessions', `${id}.jsonl`) : path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', request.project.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
  await mkdir(path.dirname(transcript), { recursive: true });
  const timestamp = new Date().toISOString();
  let parentUuid: string | null = null;
  if (provider === 'Claude') try { parentUuid = JSON.parse((await readFile(transcript, 'utf8')).trim().split('\n').at(-1)!).uuid; } catch { /* First turn. */ }
  if (!request.conversationKey && provider === 'Codex') await appendFile(transcript, JSON.stringify({ timestamp, type: 'session_meta', payload: { id, cwd: request.project } }) + '\n');
  const images = (request.attachments ?? []).filter(item => item.mimeType.startsWith('image/')).map(item => `data:${item.mimeType};base64,${item.data}`);
  const record = provider === 'Codex' ? { timestamp, type: 'event_msg', payload: { type: 'user_message', client_id: request.requestId, message: request.text, images } } : { uuid: request.requestId, parentUuid, type: 'user', sessionId: id, cwd: request.project, timestamp, isSidechain: false, message: { role: 'user', content: request.attachments?.length ? claudeContent(request) : request.text } };
  await appendFile(transcript, JSON.stringify(record) + '\n'); callbacks.session(id);
  let staged = true;
  for (const item of request.preparedAttachments ?? []) {
    if (!(await readFile(item.path)).equals(Buffer.from(item.data, 'base64')) || !path.relative(request.project, item.path).startsWith('..')) staged = false;
  }
  active++; await appendFile(path.join(control, 'calls.jsonl'), JSON.stringify({ event: 'start', id: request.requestId, provider, text: request.text, conversation: id, active, attachments: request.attachments?.length ?? 0, staged }) + '\n');
  try {
    while (!signal.aborted) {
      try { await readFile(path.join(control, `release-${request.requestId}`)); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    if (signal.aborted) return 'interrupted' as const;
    if (request.text === 'fail') throw new Error('Simulated provider failure');
    const messageId = randomUUID(), text = `Reply: ${request.text}`;
    const reply = provider === 'Codex' ? { timestamp, type: 'response_item', payload: { id: messageId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } } : { uuid: messageId, parentUuid: request.requestId, type: 'assistant', sessionId: id, cwd: request.project, timestamp, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } };
    await appendFile(transcript, JSON.stringify(reply) + '\n'); callbacks.message({ id: messageId, role: 'assistant', text }); return 'completed' as const;
  } finally { active--; await appendFile(path.join(control, 'calls.jsonl'), JSON.stringify({ event: 'finish', id: request.requestId, active }) + '\n'); }
}
export const runCodexChat = run;
export const runClaudeChat = (request: ProviderChatRequest, callbacks: ChatCallbacks, abort: AbortController) => run(request, callbacks, abort.signal);
