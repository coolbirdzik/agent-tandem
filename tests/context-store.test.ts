import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { it, expect } from 'vitest';
import { ContextStore } from '../src/core/context-store';

it('restores both providers after restart without resetting cache time, isolates projects and rejects changed transcripts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentdock-context-')), store = new ContextStore(directory);
  const usage = { usedTokens: 42, cachedTokens: 30, windowTokens: 100, cacheTtlMs: 300000, cacheExpiresAt: 301000, updatedAt: 1000 };
  await Promise.all([store.save('/one', 'Codex:one', { usedTokens: 100 }, 'r1'), store.save('/one', 'Claude:one', usage, 'r2')]);
  const reopened = new ContextStore(directory);
  expect(await reopened.read('/one', 'Claude:one', 'r2', Date.now())).toEqual(usage);
  expect(await reopened.read('/one', 'Codex:one', 'r1', Date.now())).toEqual({ usedTokens: 100 });
  expect(await reopened.read('/two', 'Claude:one', 'r2', 1000)).toBeUndefined();
  expect(await reopened.read('/one', 'Claude:one', 'changed-externally', 1000)).toBeUndefined();
});
it('recovers corrupt metadata and filters invalid numbers without injecting an expiry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentdock-context-')), store = new ContextStore(directory);
  await store.save('/one', 'Claude:one', { usedTokens: 42 }, 'r1');
  const file = path.join(directory, (await readdir(directory))[0]!);
  const rows = JSON.parse(await readFile(file, 'utf8')); rows[0].usage = { usedTokens: 42, windowTokens: -1, cacheExpiresAt: 'bad' };
  await writeFile(file, JSON.stringify(rows)); expect(await store.read('/one', 'Claude:one', 'r1', 0)).toEqual({ usedTokens: 42 });
  await writeFile(file, '{broken'); expect(await store.read('/one', 'Claude:one', 'r1', 0)).toBeUndefined();
  await store.save('/one', 'Claude:one', { usedTokens: 50 }, 'r2'); expect(await store.read('/one', 'Claude:one', 'r2', 0)).toEqual({ usedTokens: 50 });
});
