import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Hash/copy bytes with bounded memory, and reject a source changed during reading. */
export async function streamFile(file: string, options: {
  target?: string; signal?: AbortSignal; chunk?: (bytes: Buffer) => void; expectedHash?: string;
} = {}): Promise<{ hash: string; size: number }> {
  options.signal?.throwIfAborted();
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Snapshot source is not a file.');
    const digest = createHash('sha256'); let size = 0;
    const transform = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      try { digest.update(chunk); size += chunk.length; options.chunk?.(chunk); callback(null, chunk); }
      catch (error) { callback(error as Error); }
    } });
    await pipeline(handle.createReadStream({ autoClose: false }), transform,
      options.target ? createWriteStream(options.target, { flags: 'wx' }) : new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      { signal: options.signal });
    const hash = digest.digest('hex');
    if (options.expectedHash && hash !== options.expectedHash) throw new Error('Snapshot blob is corrupt.');
    const [after, current] = await Promise.all([handle.stat(), lstat(file)]);
    // Blob publication/removing a temporary hardlink changes ctime. For immutable
    // blobs the expected content hash verifies bytes even during concurrent reuse.
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || (!options.expectedHash && after.ctimeMs !== before.ctimeMs)
      || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) {
      throw new Error(`File changed while preparing review: ${file}`);
    }
    return { hash, size };
  } finally { await handle.close(); }
}
