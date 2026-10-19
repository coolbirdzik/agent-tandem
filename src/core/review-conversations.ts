import path from 'node:path';
import type { Conversation } from '../providers/conversations';
import { execPatches } from './review-exec-patches';

export type ReviewConversation = Pick<Conversation, 'key' | 'id' | 'provider' | 'title'>;
export interface ReviewCapture { before?: string; after?: string; from: number; to: number; conversations?: ReviewConversation[]; assignment?: 'manual' }
export interface ConversationEdit {
  id: string; conversation: ReviewConversation; timestamp: number; startedAt?: number; path: string;
  operation: { kind: 'write'; content: string } | { kind: 'delete' } | { kind: 'edit'; edits: Array<{ old: string; next: string; all: boolean }> } | { kind: 'patch'; chunks: string[][]; added: boolean }
    | { kind: 'hunks'; hunks: LineHunk[]; endings: 'file' | 'explicit' };
}
/** A positioned diff hunk: `start` is the 1-based first old line, `lines` are ` `/`-`/`+` prefixed. */
interface LineHunk { start: number; lines: string[] }
const obj = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {};
const hunkLine = (line: unknown): line is string => typeof line === 'string' && /^[ +\-]/.test(line);

/** Claude records the applied change as line-ending-normalized jsdiff hunks. */
function claudeHunks(value: unknown): LineHunk[] | undefined {
  if (!Array.isArray(value) || !value.length) return;
  const hunks: LineHunk[] = [];
  for (const item of value) {
    const { oldStart, lines } = obj(item);
    // "\ No newline at end of file" markers fall back to the tool input.
    if (!Number.isInteger(oldStart) || oldStart < 1 || !Array.isArray(lines) || !lines.length || !lines.every(hunkLine)) return;
    hunks.push({ start: oldStart, lines });
  }
  return hunks;
}

/** Codex records the applied change as a unified diff whose lines keep their CR. */
function unifiedHunks(diff: unknown): LineHunk[] | undefined {
  if (typeof diff !== 'string') return;
  const hunks: LineHunk[] = [];
  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (header) hunks.push({ start: Number(header[1]), lines: [] });
    else if (!line) continue;
    else if (!hunks.length || !hunkLine(line)) return;
    else hunks.at(-1)!.lines.push(line);
  }
  return hunks.length && hunks.every(hunk => hunk.start >= 1 && hunk.lines.length) ? hunks : undefined;
}

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
  const calls = new Map<string, { name: string; input: unknown; cwd: string; startedAt: number }>(), result: ConversationEdit[] = [];
  const push = (id: string, name: unknown, directory: string, at: number, startedAt: number | undefined, operation: ConversationEdit['operation']) => {
    const file = relative(name, directory);
    if (file) result.push({ id, conversation: source, timestamp: at, ...(startedAt !== undefined && Number.isFinite(startedAt) && startedAt <= at ? { startedAt } : {}), path: file, operation });
  };
  const consume = (id: unknown, output: unknown, failed: boolean, timestamp: unknown, applied?: unknown) => {
    if (typeof id !== 'string') return;
    const call = calls.get(id), at = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
    if (!call || failed || !Number.isFinite(at)) return;
    const add = (name: unknown, operation: ConversationEdit['operation']) => push(id, name, call.cwd, at, call.startedAt, operation);
    if (conversation.provider === 'Claude') {
      // The tool result's hunks are what Claude Code wrote, after its own
      // line-ending, quote and whitespace handling, so they are preferred.
      const input = obj(call.input), hunks = claudeHunks(obj(applied).structuredPatch);
      if (call.name === 'Write' && typeof input.content === 'string') {
        add(input.file_path, { kind: 'write', content: input.content });
        if (obj(applied).type === 'update' && hunks) add(input.file_path, { kind: 'hunks', hunks, endings: 'file' });
      }
      if ((call.name === 'Edit' || call.name === 'MultiEdit') && hunks) add(input.file_path, { kind: 'hunks', hunks, endings: 'file' });
      else if (call.name === 'Edit' || call.name === 'MultiEdit') {
        const edits = call.name === 'Edit' ? [input] : input.edits;
        if (Array.isArray(edits) && edits.length && edits.every(edit => typeof edit.old_string === 'string' && typeof edit.new_string === 'string')) {
          add(input.file_path, { kind: 'edit', edits: edits.map(edit => ({ old: edit.old_string, next: edit.new_string, all: edit.replace_all === true })) });
        }
      }
    } else {
      let patches: unknown[] = [];
      if (/(^|\.)apply_patch$/.test(call.name)) {
        const text = typeof output === 'string' ? output : JSON.stringify(output);
        if (!/Success\. Updated the following files:/m.test(text ?? '') || /(?:isError|is_error)"?\s*:\s*true/.test(text ?? '')) return;
        let patch = call.input;
        if (typeof patch === 'string') { try { const input = JSON.parse(patch); patch = input.patch ?? input.input ?? patch; } catch { /* Custom tool input is the patch itself. */ } }
        patches = [patch];
      } else if (/(^|\.)exec$/.test(call.name)) patches = execPatches(call.input, output);
      for (const patch of patches) {
        if (typeof patch !== 'string' || !patch.startsWith('*** Begin Patch')) continue;
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
    }
  };
  for (const value of records) {
    const record = obj(value), payload = obj(record.payload);
    if (typeof record.cwd === 'string') directory = record.cwd;
    if (record.type === 'turn_context' && typeof payload.cwd === 'string') directory = payload.cwd;
    if (conversation.provider === 'Claude') {
      const blocks = obj(record.message).content;
      // The record-level tool result belongs to its only tool_result block.
      const results = Array.isArray(blocks) ? blocks.filter(block => block?.type === 'tool_result').length : 0;
      if (Array.isArray(blocks)) for (const block of blocks) {
        if (block.type === 'tool_use' && typeof block.id === 'string') calls.set(block.id, { name: block.name, input: block.input, cwd: directory, startedAt: Date.parse(record.timestamp) });
        if (block.type === 'tool_result') consume(block.tool_use_id, block.content, block.is_error === true, record.timestamp, results === 1 ? record.toolUseResult : undefined);
      }
    } else if (record.type === 'response_item') {
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') calls.set(payload.call_id, { name: payload.name, input: payload.arguments ?? payload.input, cwd: directory, startedAt: Date.parse(record.timestamp) });
      if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') consume(payload.call_id, payload.output, false, record.timestamp);
    } else if (record.type === 'event_msg' && payload.type === 'item_completed') {
      // Codex reports every applied patch, including ones built dynamically
      // inside exec scripts, as a completed FileChange with its real diff.
      const item = obj(payload.item), at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
      if (item.type !== 'FileChange' || item.status !== 'completed' || typeof item.id !== 'string' || !Number.isFinite(at)) continue;
      for (const [name, value] of Object.entries(obj(item.changes))) {
        const change = obj(value);
        if (change.type === 'add' && typeof change.content === 'string') push(item.id, name, directory, at, undefined, { kind: 'write', content: change.content });
        // A rename removes its source; the destination's prior bytes are unknown.
        else if (change.type === 'delete' || (change.type === 'update' && change.move_path)) push(item.id, name, directory, at, undefined, { kind: 'delete' });
        else if (change.type === 'update') {
          const hunks = unifiedHunks(change.unified_diff);
          if (hunks) push(item.id, name, directory, at, undefined, { kind: 'hunks', hunks, endings: 'explicit' });
        }
      }
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
      // Claude matches LF strings against a CRLF file and writes CRLF back.
      const crlf: boolean = text.includes('\r\n') && !text.includes(edit.old) && !edit.old.includes('\r');
      const old: string = crlf ? edit.old.replace(/\n/g, '\r\n') : edit.old, next: string = crlf ? edit.next.replace(/\r?\n/g, '\r\n') : edit.next;
      if (!old || !text.includes(old)) return false;
      if (!edit.all && text.indexOf(old) !== text.lastIndexOf(old)) return false;
      text = edit.all ? text.split(old).join(next) : text.replace(old, () => next);
    }
    return text;
  }
  if (operation.kind === 'patch' && operation.added) {
    if (text !== undefined || operation.chunks.some(chunk => chunk.some(line => !line.startsWith('+')))) return false;
    return operation.chunks.flat().map(line => line.slice(1)).join('\n') + '\n';
  }
  if (text === undefined) return false;
  const newline = text.includes('\r\n') ? '\r\n' : '\n', trailing = text.endsWith('\n');
  const endings = [...text.matchAll(/\r?\n/g)].map(match => match[0]);
  const contents = text.split(/\r?\n/); if (trailing) contents.pop();
  const lines = contents.map((content, index) => ({ content, ending: endings[index] ?? '' }));
  const join = () => lines.map((line, index) => line.content + (index === lines.length - 1 && !trailing ? '' : line.ending || newline)).join('');
  if (operation.kind === 'hunks') {
    const strip = (line: string) => line.slice(1).replace(/\r$/, '');
    let delta = 0;
    for (const hunk of operation.hunks) {
      const old = hunk.lines.filter(line => !line.startsWith('+')).map(strip), at = hunk.start - 1 + delta;
      // Positions are exact for the bytes the tool changed; anything else is another writer.
      if (!old.length || at < 0 || at + old.length > lines.length || old.some((line, i) => lines[at + i]!.content !== line)) return false;
      const next: typeof lines = [];
      let cursor = at;
      for (const line of hunk.lines) {
        if (line.startsWith('+')) next.push({ content: strip(line), ending: operation.endings === 'file' ? newline : line.endsWith('\r') ? '\r\n' : '\n' });
        else { if (line.startsWith(' ')) next.push(lines[cursor]!); cursor++; }
      }
      lines.splice(at, old.length, ...next); delta += next.length - old.length;
    }
    return join();
  }
  let start = 0;
  for (const chunk of operation.chunks.filter(chunk => chunk.length)) {
    const old = chunk.filter(line => !line.startsWith('+')).map(line => line.slice(1));
    if (!old.length) return false; // An insertion with no context cannot be located safely.
    const matches: number[] = [];
    for (let i = start; i <= lines.length - old.length; i++) if (old.every((line, j) => lines[i + j]?.content === line)) matches.push(i);
    if (matches.length !== 1) return false;
    let cursor = matches[0]!;
    const next: typeof lines = [];
    for (const line of chunk) {
      if (line.startsWith('+')) next.push({ content: line.slice(1), ending: newline });
      else {
        // Context and untouched lines retain their own line endings. A file
        // can contain both LF and CRLF without the patch rewriting either.
        if (line.startsWith(' ')) next.push(lines[cursor]!);
        cursor++;
      }
    }
    lines.splice(matches[0]!, old.length, ...next); start = matches[0]! + next.length;
  }
  return join();
}

/** A wrapper can finish long after the watcher has captured its patch. */
export function editOverlapsCapture(edit: ConversationEdit, capture: ReviewCapture): boolean {
  return edit.timestamp >= capture.from && (edit.startedAt === undefined ? edit.timestamp <= capture.to + 10000 : edit.startedAt <= capture.to);
}

/** Verify a complete content transition; a nearby conversation or path alone is insufficient. */
export function captureConversations(capture: ReviewCapture, file: string, before: string | undefined, after: string | undefined, edits: ConversationEdit[]): ReviewConversation[] | undefined {
  const samePath = (name: string) => process.platform === 'win32' ? name.toLowerCase() === file.toLowerCase() : name === file;
  const candidates = edits.filter(edit => samePath(edit.path) && editOverlapsCapture(edit, capture)).sort((a, b) => a.timestamp - b.timestamp);
  const pending = [{ index: 0, text: before, sources: new Map<string, ReviewConversation>() }];
  let transitions = 0;
  while (pending.length) {
    let { index, text, sources } = pending.pop()!;
    for (; index < candidates.length; index++) {
      const edit = candidates[index]!, next = apply(text, edit.operation);
      if (next === false || next === text) continue;
      // A prior patch can finish after its bytes were already captured. Keep
      // the branch that skips it rather than forcing every overlapping result
      // into this transition. Only an exact before/after match proves a link.
      if (++transitions > 256) return; // Bound ambiguous histories conservatively.
      pending.push({ index: index + 1, text, sources });
      text = next; sources = new Map(sources); sources.set(edit.conversation.key, edit.conversation);
      if (text === after) return [...sources.values()];
    }
  }
  return;
}

