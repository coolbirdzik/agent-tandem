import path from 'node:path';
import type { Conversation } from '../providers/conversations';

export type ReviewConversation = Pick<Conversation, 'key' | 'id' | 'provider' | 'title'>;
export interface ReviewCapture { before?: string; after?: string; from: number; to: number; conversations?: ReviewConversation[] }
export interface ConversationEdit {
  id: string; conversation: ReviewConversation; timestamp: number; path: string;
  operation: { kind: 'write'; content: string } | { kind: 'delete' } | { kind: 'edit'; edits: Array<{ old: string; next: string; all: boolean }> } | { kind: 'patch'; chunks: string[][]; added: boolean };
}
const obj = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {};

/** Explicit successful edit tools only. Shell commands and failed tools are not writer evidence. */
export function conversationEdits(records: unknown[], conversation: ReviewConversation, cwd: string, project: string): ConversationEdit[] {
  const source: ReviewConversation = { key: conversation.key, id: conversation.id, provider: conversation.provider, title: conversation.title };
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(project), paths = windows ? path.win32 : path.posix;
  const relative = (name: unknown, directory: string) => {
    if (typeof name !== 'string' || !name || name.includes('\0')) return;
    const result = paths.relative(project, paths.resolve(directory, name)).replace(/\\/g, '/');
    if (!result || result === '..' || result.startsWith('../') || paths.isAbsolute(result)) return;
    return result;
  };
  let directory = cwd;
  const calls = new Map<string, { name: string; input: unknown; cwd: string }>(), result: ConversationEdit[] = [];
  const consume = (id: unknown, output: unknown, failed: boolean, timestamp: unknown) => {
    if (typeof id !== 'string') return;
    const call = calls.get(id), at = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
    if (!call || failed || !Number.isFinite(at)) return;
    const add = (name: unknown, operation: ConversationEdit['operation']) => {
      const file = relative(name, call.cwd); if (file) result.push({ id, conversation: source, timestamp: at, path: file, operation });
    };
    if (conversation.provider === 'Claude') {
      const input = obj(call.input);
      if (call.name === 'Write' && typeof input.content === 'string') add(input.file_path, { kind: 'write', content: input.content });
      if (call.name === 'Edit' || call.name === 'MultiEdit') {
        const edits = call.name === 'Edit' ? [input] : input.edits;
        if (Array.isArray(edits) && edits.length && edits.every(edit => typeof edit.old_string === 'string' && typeof edit.new_string === 'string')) {
          add(input.file_path, { kind: 'edit', edits: edits.map(edit => ({ old: edit.old_string, next: edit.new_string, all: edit.replace_all === true })) });
        }
      }
    } else if (/(^|\.)apply_patch$/.test(call.name)) {
      const text = typeof output === 'string' ? output : JSON.stringify(output);
      if (!/Success\. Updated the following files:/m.test(text ?? '') || /(?:isError|is_error)"?\s*:\s*true/.test(text ?? '')) return;
      let patch = call.input;
      if (typeof patch === 'string') { try { const input = JSON.parse(patch); patch = input.patch ?? input.input ?? patch; } catch { /* Custom tool input is the patch itself. */ } }
      if (typeof patch !== 'string' || !patch.startsWith('*** Begin Patch')) return;
      const sections = patch.split(/(?=^\*\*\* (?:Add|Update|Delete) File: )/m).slice(1);
      for (const section of sections) {
        const lines = section.split(/\r?\n/), header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines.shift()!);
        if (!header || lines.some(line => line.startsWith('*** Move to:'))) continue; // Renames require both sides; leave them unassigned.
        if (header[1] === 'Delete') { add(header[2], { kind: 'delete' }); continue; }
        const chunks: string[][] = [[]];
        for (const line of lines) {
          if (line.startsWith('@@')) { if (chunks.at(-1)!.length) chunks.push([]); }
          else if (/^[ +\-]/.test(line)) chunks.at(-1)!.push(line);
          else if (line && !line.startsWith('*** ')) { chunks.length = 0; break; }
        }
        if (chunks.length && chunks.some(chunk => chunk.length)) add(header[2], { kind: 'patch', chunks, added: header[1] === 'Add' });
      }
    }
  };
  for (const value of records) {
    const record = obj(value), payload = obj(record.payload);
    if (typeof record.cwd === 'string') directory = record.cwd;
    if (record.type === 'turn_context' && typeof payload.cwd === 'string') directory = payload.cwd;
    if (conversation.provider === 'Claude') {
      const blocks = obj(record.message).content;
      if (Array.isArray(blocks)) for (const block of blocks) {
        if (block.type === 'tool_use' && typeof block.id === 'string') calls.set(block.id, { name: block.name, input: block.input, cwd: directory });
        if (block.type === 'tool_result') consume(block.tool_use_id, block.content, block.is_error === true, record.timestamp);
      }
    } else if (record.type === 'response_item') {
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') calls.set(payload.call_id, { name: payload.name, input: payload.arguments ?? payload.input, cwd: directory });
      if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') consume(payload.call_id, payload.output, false, record.timestamp);
    }
  }
  return result;
}

function apply(text: string | undefined, operation: ConversationEdit['operation']): string | undefined | false {
  if (operation.kind === 'write') return operation.content;
  if (operation.kind === 'delete') return undefined;
  if (operation.kind === 'edit') {
    if (text === undefined) return false;
    for (const edit of operation.edits) {
      if (!edit.old || !text.includes(edit.old)) return false;
      if (!edit.all && text.indexOf(edit.old) !== text.lastIndexOf(edit.old)) return false;
      text = edit.all ? text.split(edit.old).join(edit.next) : text.replace(edit.old, () => edit.next);
    }
    return text;
  }
  if (operation.added) {
    if (text !== undefined || operation.chunks.some(chunk => chunk.some(line => !line.startsWith('+')))) return false;
    return operation.chunks.flat().map(line => line.slice(1)).join('\n') + '\n';
  }
  if (text === undefined) return false;
  const newline = text.includes('\r\n') ? '\r\n' : '\n', trailing = text.endsWith('\n');
  const lines = text.split(/\r?\n/); if (trailing) lines.pop();
  let start = 0;
  for (const chunk of operation.chunks.filter(chunk => chunk.length)) {
    const old = chunk.filter(line => !line.startsWith('+')).map(line => line.slice(1));
    const next = chunk.filter(line => !line.startsWith('-')).map(line => line.slice(1));
    if (!old.length) return false; // An insertion with no context cannot be located safely.
    const matches: number[] = [];
    for (let i = start; i <= lines.length - old.length; i++) if (old.every((line, j) => lines[i + j] === line)) matches.push(i);
    if (matches.length !== 1) return false;
    lines.splice(matches[0]!, old.length, ...next); start = matches[0]! + next.length;
  }
  return lines.join(newline) + (trailing ? newline : '');
}

/** Verify a complete content transition; a nearby conversation or path alone is insufficient. */
export function captureConversations(capture: ReviewCapture, file: string, before: string | undefined, after: string | undefined, edits: ConversationEdit[]): ReviewConversation[] | undefined {
  const samePath = (name: string) => process.platform === 'win32' ? name.toLowerCase() === file.toLowerCase() : name === file;
  const candidates = edits.filter(edit => samePath(edit.path) && edit.timestamp >= capture.from && edit.timestamp <= capture.to + 10000).sort((a, b) => a.timestamp - b.timestamp);
  let text = before;
  const sources = new Map<string, ReviewConversation>();
  for (const edit of candidates) {
    const next = apply(text, edit.operation);
    if (next === false || next === text) continue;
    text = next; sources.set(edit.conversation.key, edit.conversation);
    if (text === after && sources.size) return [...sources.values()];
  }
  return;
}

