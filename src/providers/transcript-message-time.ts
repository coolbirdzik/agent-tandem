import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import * as zlib from 'node:zlib';

function messageTime(line: string): number | undefined {
  // Cheap necessary condition: skips parsing most tool output and token records.
  if (!line.includes('message"') && !line.includes('"user"') && !line.includes('"assistant"')) return;
  let row;
  try { row = JSON.parse(line); } catch { return; }
  const payload = row?.payload;
  const message = row?.type === 'user' || row?.type === 'assistant'
    || (row?.type === 'event_msg' && ['user_message', 'agent_message'].includes(payload?.type))
    || (row?.type === 'response_item' && payload?.type === 'message' && ['user', 'assistant'].includes(payload?.role));
  if (!message) return;
  const time = Date.parse(row.timestamp ?? payload?.timestamp);
  return Number.isFinite(time) ? time : undefined;
}
function latest(lines: string[]) {
  for (let index = lines.length - 1; index >= 0; index--) { const time = messageTime(lines[index]!); if (time !== undefined) return time; }
}

/** Read backwards for plain rollouts; compressed streams are decoded without writing a copy. */
export async function transcriptMessageTime(file: string, signal?: AbortSignal): Promise<number | undefined> {
  if (!/\.jsonl(?:\.zst)?$/.test(file)) return;
  if (!file.endsWith('.zst')) {
    const handle = await open(file, 'r');
    try {
      let position = (await handle.stat()).size, suffix = '';
      const buffer = Buffer.alloc(256 * 1024);
      while (position > 0) {
        const length = Math.min(position, buffer.length); position -= length;
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        const lines = (buffer.subarray(0, bytesRead).toString('utf8') + suffix).split('\n');
        suffix = position ? lines.shift()! : '';
        const time = latest(lines); if (time !== undefined) return time;
      }
    } finally { await handle.close(); }
    return;
  }
  if (typeof zlib.createZstdDecompress !== 'function') throw new Error('Update VS Code to read compressed Codex history.');
  const input = createReadStream(file), decoder = zlib.createZstdDecompress({ chunkSize: 256 * 1024 });
  input.on('error', error => decoder.destroy(error)); input.pipe(decoder);
  // Only the newest message per decoded block matters, so each block is scanned from its end.
  // Newline bytes never occur inside UTF-8 sequences; long lines are joined once, not per chunk.
  let last: number | undefined, partial: Buffer[] = [];
  try {
    for await (const chunk of decoder as AsyncIterable<Buffer>) {
      signal?.throwIfAborted();
      const end = chunk.lastIndexOf(10);
      if (end < 0) { partial.push(chunk); continue; }
      const time = latest(Buffer.concat([...partial, chunk.subarray(0, end)]).toString('utf8').split('\n'));
      if (time !== undefined) last = time;
      partial = [chunk.subarray(end + 1)];
    }
    return latest([Buffer.concat(partial).toString('utf8')]) ?? last;
  } finally { input.unpipe(decoder); input.destroy(); decoder.destroy(); }
}
