import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';

/**
 * A snapshot entry that Git can rebuild byte for byte: `<oid>` when the bytes are the raw object, `<oid>:crlf` when they
 * are the object with every LF written as CRLF (the usual `core.autocrlf` checkout). Specs are only recorded after the
 * exact bytes were hashed both ways, so rebuilding never depends on the repository's filters or attributes.
 */
export type GitRefSpec = string;
export const gitRefPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})(?::crlf)?$/;
const LF = 0x0a, CR = 0x0d;

const objectHash = (oid: string) => createHash(oid.length === 64 ? 'sha256' : 'sha1');

/** The spec under which `oid` rebuilds exactly `bytes`, or undefined. */
export function gitRefOf(bytes: Uint8Array, oid: string): GitRefSpec | undefined {
  // Empty files can be intent-to-add entries whose object was never written; they cost nothing to store.
  if (!bytes.length) return undefined;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (objectHash(oid).update(`blob ${buffer.length}\0`).update(buffer).digest('hex') === oid) return oid;
  const lines: number[] = [];
  for (let at = buffer.indexOf(LF); at !== -1; at = buffer.indexOf(LF, at + 1)) {
    // A lone LF cannot be rebuilt from an LF-only object.
    if (at === 0 || buffer[at - 1] !== CR) return undefined;
    lines.push(at);
  }
  if (!lines.length) return undefined;
  const digest = objectHash(oid).update(`blob ${buffer.length - lines.length}\0`);
  let start = 0;
  for (const at of lines) { digest.update(buffer.subarray(start, at - 1)); start = at; }
  digest.update(buffer.subarray(start));
  return digest.digest('hex') === oid ? `${oid}:crlf` : undefined;
}

async function readChunks(file: string, each: (chunk: Buffer) => void, signal?: AbortSignal) {
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat();
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) { signal?.throwIfAborted(); each(chunk as Buffer); }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(`File changed while preparing review: ${file}`);
    return before.size;
  } finally { await handle.close(); }
}

/** Files up to this size are read once into memory; larger ones are streamed, at the cost of rereading them. */
const inMemoryBytes = 16 * 1024 * 1024;

/** `gitRefOf` for a file, with the content's SHA-256. */
export async function gitRefOfFile(file: string, oid: string, signal?: AbortSignal): Promise<{ hash: string; ref?: GitRefSpec }> {
  signal?.throwIfAborted();
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat();
    if (before.size <= inMemoryBytes) {
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(`File changed while preparing review: ${file}`);
      return { hash: createHash('sha256').update(bytes).digest('hex'), ref: gitRefOf(bytes, oid) };
    }
  } finally { await handle.close(); }
  const sha = createHash('sha256');
  let crlf = 0, lone = false, last = -1;
  // The object hash needs the size up front; hash the bytes first, then the header-prefixed form from a second read.
  const size = await readChunks(file, chunk => {
    sha.update(chunk);
    for (let at = chunk.indexOf(LF); at !== -1; at = chunk.indexOf(LF, at + 1)) {
      if ((at ? chunk[at - 1] : last) === CR) crlf++; else lone = true;
    }
    if (chunk.length) last = chunk[chunk.length - 1]!;
  }, signal);
  const hash = sha.digest('hex');
  if (!size) return { hash };
  const check = async (normalize: boolean) => {
    const digest = objectHash(oid).update(`blob ${normalize ? size - crlf : size}\0`), again = createHash('sha256');
    let held = false;
    await readChunks(file, chunk => {
      again.update(chunk);
      if (!normalize) { digest.update(chunk); return; }
      let start = 0;
      if (held) { if (chunk[0] !== LF) digest.update(Buffer.of(CR)); held = false; }
      for (let at = chunk.indexOf(LF); at !== -1; at = chunk.indexOf(LF, at + 1)) {
        if (at > 0) { digest.update(chunk.subarray(start, at - 1)); start = at; }
      }
      if (chunk.length && chunk[chunk.length - 1] === CR) { digest.update(chunk.subarray(start, chunk.length - 1)); held = true; }
      else digest.update(chunk.subarray(start));
    }, signal);
    if (held) digest.update(Buffer.of(CR));
    if (again.digest('hex') !== hash) throw new Error(`File changed while preparing review: ${file}`);
    return digest.digest('hex') === oid;
  };
  if (await check(false)) return { hash, ref: oid };
  if (crlf && !lone && await check(true)) return { hash, ref: `${oid}:crlf` };
  return { hash };
}

const withCrlf = (chunk: Buffer) => {
  let start = 0;
  const parts: Buffer[] = [];
  for (let at = chunk.indexOf(LF); at !== -1; at = chunk.indexOf(LF, at + 1)) { parts.push(chunk.subarray(start, at), Buffer.of(CR, LF)); start = at + 1; }
  if (!start) return chunk;
  parts.push(chunk.subarray(start));
  return Buffer.concat(parts);
};

/**
 * Stream the bytes each spec describes from the repository at `cwd`, in order, with one Git process. `each` receives an
 * entry's chunks; `done` follows every entry, with `found` false when Git no longer has its object.
 */
export async function readGitRefs(cwd: string, specs: GitRefSpec[], each: (index: number, chunk: Buffer) => Promise<void>, done: (index: number, found: boolean) => Promise<void>): Promise<void> {
  if (specs.some(spec => !gitRefPattern.test(spec))) throw new Error('Invalid Git snapshot reference.');
  if (!specs.length) return;
  const modes = specs.map(spec => spec.endsWith(':crlf'));
  const child = spawn('git', ['cat-file', '--batch'], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  child.stdin.on('error', () => undefined);
  child.stdin.end(`${specs.map(spec => spec.split(':')[0]).join('\n')}\n`);
  // Output per entry: "<oid> <type> <size>\n<content>\n", or "<oid> missing\n".
  let index = 0, remaining = -1, discard = false, trailing = false, pending: Buffer = Buffer.alloc(0);
  try {
    for await (const data of child.stdout as AsyncIterable<Buffer>) {
      let chunk: Buffer = pending.length ? Buffer.concat([pending, data]) : data;
      pending = Buffer.alloc(0);
      while (chunk.length || (remaining === 0 && !trailing)) {
        if (trailing) {
          if (!chunk.length) break;
          chunk = chunk.subarray(1); trailing = false;
          await done(index++, !discard); continue;
        }
        if (remaining < 0) {
          const end = chunk.indexOf(LF);
          if (end === -1) { pending = chunk; break; }
          const header = chunk.subarray(0, end).toString('latin1').split(' ');
          chunk = chunk.subarray(end + 1);
          const size = Number(header[2]);
          if (header.length !== 3 || !Number.isSafeInteger(size)) { await done(index++, false); continue; }
          remaining = size; discard = header[1] !== 'blob';
          continue;
        }
        const take = Math.min(remaining, chunk.length);
        if (take && !discard) await each(index, modes[index] ? withCrlf(chunk.subarray(0, take)) : chunk.subarray(0, take));
        remaining -= take; chunk = chunk.subarray(take);
        if (!remaining) { remaining = -1; trailing = true; }
      }
    }
    await exited;
    // Entries Git never answered, for example after it failed to start reading, are missing.
    while (index < specs.length) await done(index++, false);
  } finally { if (child.exitCode === null) child.kill(); }
}
