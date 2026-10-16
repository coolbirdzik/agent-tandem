import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import * as zlib from 'node:zlib';

/** Bound decoded output as well as input memory. No unpacked copy is written to the session store. */
export async function transcriptPrefix(file: string, limit = 256 * 1024): Promise<{ text: string; truncated: boolean }> {
  let data: Buffer;
  if (!file.endsWith('.jsonl.zst')) {
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(limit + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      data = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  } else {
    if (typeof zlib.createZstdDecompress !== 'function') throw new Error('Update VS Code to read compressed Codex history: this extension host does not support Zstandard.');
    const input = createReadStream(file), decoder = zlib.createZstdDecompress();
    const chunks: Buffer[] = []; let bytes = 0;
    input.on('error', error => decoder.destroy(error));
    input.pipe(decoder);
    try {
      for await (const value of decoder) {
        const chunk = (value as Buffer).subarray(0, limit + 1 - bytes);
        chunks.push(chunk); bytes += chunk.length;
        if (bytes > limit) break;
      }
      data = Buffer.concat(chunks, bytes);
    } catch (error) {
      throw new Error(`Could not read compressed transcript ${file}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { input.unpipe(decoder); input.destroy(); decoder.destroy(); }
  }
  return { text: data.subarray(0, limit).toString('utf8'), truncated: data.length > limit };
}
