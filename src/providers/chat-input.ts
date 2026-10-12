import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { attachmentKind } from '../core/attachments';
import type { ProviderChatRequest } from './chat';

export function codexInput(request: ProviderChatRequest) {
  const input: any[] = request.text.trim() ? [{ type: 'text', text: request.text, text_elements: [] }] : [];
  for (const item of request.attachments ?? []) {
    const kind = attachmentKind(item), local = request.preparedAttachments?.find(row => row.name === item.name && row.data === item.data);
    if (kind === 'image') input.push({ type: 'image', url: `data:${item.mimeType};base64,${item.data}` });
    else {
      if (!local) throw new Error('Attachment is not prepared. Choose the file again.');
      input.push(kind === 'audio' ? { type: 'localAudio', path: local.path } : { type: 'mention', name: item.name, path: local.path });
    }
  }
  return input;
}
export function claudePrompt(request: ProviderChatRequest): string | AsyncIterable<SDKUserMessage> {
  if (!request.attachments?.length) return request.text;
  const content = claudeContent(request);
  return (async function* () { yield { type: 'user' as const, session_id: request.conversationKey?.slice('Claude:'.length) ?? '', parent_tool_use_id: null, message: { role: 'user' as const, content } }; })();
}
export function claudeContent(request: ProviderChatRequest): SDKUserMessage['message']['content'] {
  const content: SDKUserMessage['message']['content'] = [];
  if (request.text.trim()) content.push({ type: 'text', text: request.text });
  for (const item of request.attachments ?? []) {
    const kind = attachmentKind(item);
    if (kind === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: item.mimeType as 'image/png', data: item.data } });
    else if (kind === 'document') content.push({ type: 'document', title: item.name, source: { type: 'base64', media_type: 'application/pdf', data: item.data } });
    else {
      const local = request.preparedAttachments?.find(row => row.name === item.name && row.data === item.data);
      if (!local) throw new Error('Attachment is not prepared. Choose the file again.');
      content.push({ type: 'text', text: `Attached file ${JSON.stringify(item.name)}: ${JSON.stringify(local.path)}. Read this file as needed.` });
    }
  }
  return content;
}
