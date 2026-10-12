import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { FastModeStore } from '../src/core/fast-mode-store';
import { fastModeSelection } from '../src/providers/fast-mode';
import { chatRequest } from '../src/providers/chat';

describe('Codex Fast mode', () => {
  it('validates explicit On/Off and refuses malformed or Claude requests', () => {
    const base = { requestId: 'r', project: '/one', provider: 'Codex', text: 'hi' };
    for (const enabled of [true, false]) {
      expect(chatRequest({ ...base, fastMode: enabled }).fastMode).toBe(enabled);
      expect(fastModeSelection({ project: '/one', provider: 'Codex', enabled }).enabled).toBe(enabled);
    }
    expect(chatRequest(base).fastMode).toBeUndefined();
    for (const fastMode of ['true', 1, null]) expect(() => chatRequest({ ...base, fastMode })).toThrow();
    expect(() => chatRequest({ ...base, provider: 'Claude', fastMode: true })).toThrow('only supported for Codex');
    expect(() => fastModeSelection({ project: '/one', provider: 'Claude', enabled: true })).toThrow();
  });
  it('survives restart, isolates projects and persists switching Off', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentdock-fast-')), store = new FastModeStore(directory);
    expect(await store.read('/one')).toBe(false);
    await store.save('/one', true);
    expect(await new FastModeStore(directory).read('/one')).toBe(true);
    expect(await store.read('/two')).toBe(false);
    await Promise.all([store.save('/one', true), store.save('/one', false)]);
    expect(await new FastModeStore(directory).read('/one')).toBe(false);
    const file = path.join(directory, (await readdir(directory))[0]!);
    await writeFile(file, '{broken'); expect(await store.read('/one')).toBe(false);
    await writeFile(file, JSON.stringify({ enabled: 'true' })); expect(await store.read('/one')).toBe(false);
  });
});
