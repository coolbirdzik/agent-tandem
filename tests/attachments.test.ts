import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chatAttachments, MAX_IMAGE_BYTES } from '../src/core/attachments';
import { AttachmentStore } from '../src/core/attachment-store';
import { codexInput, claudePrompt } from '../src/providers/chat-input';
import { chatRequest } from '../src/providers/chat';
import { claudeMessages, codexMessages } from '../src/providers/conversations';
import { ChatQueue } from '../src/core/chat-queue';
const image = { name: 'screen.png', mimeType: 'image/png', data: Buffer.from('image bytes').toString('base64') };
const pdf = { name: 'reference.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.7').toString('base64') };
const file = { name: '../../file.txt', mimeType: 'text/plain', data: Buffer.from('Document text').toString('base64') };
const audio = { name: 'recording.wav', mimeType: 'audio/wav', data: Buffer.from('audio').toString('base64') };
const request = { requestId: 'r', project: '/project', provider: 'Codex' as const, text: '', attachments: [image, pdf, file, audio] };
describe('Chat attachment transport and persistence', () => {
  it('accepts attachment-only prompts, strips host paths and rejects malformed or oversized input', () => {
    expect(chatRequest({ ...request, preparedAttachments: [{ path: '/secret' }] })).toEqual(request);
    for (const attachments of [null, [{}], [ { ...image, data: 'bad%' } ], [ { ...image, data: 'AAAA===' } ], [ { ...image, mimeType: 'image/svg+xml' } ], Array(11).fill(image), [{ ...image, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }]]) {
      expect(() => chatAttachments(attachments)).toThrow();
    }
    expect(() => chatRequest({ ...request, attachments: [] })).toThrow();
  });
  it('stages immutable bytes outside the workspace, contains names and uses native image/audio/mention variants', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentdock-attachments-'));
    try {
      const store = new AttachmentStore(directory), preparedAttachments = await store.prepare(request.attachments);
      for (const item of preparedAttachments) { expect(path.dirname(item.path)).toBe(store.directory); expect(await readFile(item.path)).toEqual(Buffer.from(item.data, 'base64')); }
      expect((await store.prepare(request.attachments)).map(item => item.path)).toEqual(preparedAttachments.map(item => item.path));
      expect(codexInput({ ...request, preparedAttachments })).toEqual([
        { type: 'image', url: `data:image/png;base64,${image.data}` },
        { type: 'mention', name: pdf.name, path: preparedAttachments[1]!.path },
        { type: 'mention', name: file.name, path: preparedAttachments[2]!.path },
        { type: 'localAudio', path: preparedAttachments[3]!.path },
      ]);
      const prompt = claudePrompt({ ...request, provider: 'Claude', conversationKey: 'Claude:session', preparedAttachments });
      expect(typeof prompt).not.toBe('string'); const messages = []; for await (const message of prompt as Exclude<typeof prompt, string>) messages.push(message);
      expect(messages).toHaveLength(1); expect(messages[0]).toMatchObject({ type: 'user', session_id: 'session', parent_tool_use_id: null, message: { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } },
        { type: 'document', title: pdf.name, source: { type: 'base64', media_type: 'application/pdf', data: pdf.data } },
        { type: 'text', text: expect.stringContaining(preparedAttachments[2]!.path.replace(/\\/g, '\\\\')) },
        { type: 'text', text: expect.stringContaining(preparedAttachments[3]!.path.replace(/\\/g, '\\\\')) },
      ] } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('preserves native image/PDF history and does not hide attachment-only messages', () => {
    const records = [{ uuid: 'u1', type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }, { type: 'document', title: pdf.name, source: { type: 'base64', media_type: pdf.mimeType, data: pdf.data } }] } }];
    expect(claudeMessages(records)[0]).toMatchObject({ role: 'user', text: '[Image]\n[File]', attachments: [ { ...image, name: 'Image 1' }, pdf ] });
    const content = [{ type: 'input_image', image_url: `data:image/png;base64,${image.data}` }];
    const codex = codexMessages([{ type: 'response_item', payload: { type: 'message', role: 'user', content } }, { type: 'event_msg', payload: { type: 'user_message', message: '', images: [`data:image/png;base64,${image.data}`] } }]);
    expect(codex).toHaveLength(1); expect(codex[0]).toMatchObject({ text: '[Image]', attachments: [{ ...image, name: 'Image 1' }] });
  });
  it('retains attachments through queue edit, pause/reload, rebind and dequeue', () => {
    const queue = new ChatQueue(), chat = { requestId: 'active', provider: 'Codex' as const, conversationKey: 'Codex:draft', status: 'running' as const, prompts: [] };
    queue.enqueue(request, chat, chat.conversationKey); queue.edit(request.project, request.requestId, '');
    const restored = new ChatQueue(JSON.parse(JSON.stringify(queue.snapshot()))); restored.bind(request.project, 'Codex:draft', 'Codex:native'); restored.resume(request.project);
    expect(restored.next(request.project, { id: 'native', key: 'Codex:native', provider: 'Codex', cwd: request.project, title: 'Chat', updatedAt: 1, revision: '1' })?.attachments).toEqual(request.attachments);
  });
});
