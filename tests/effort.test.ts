import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { EffortStore } from '../src/core/effort-store';
import { effortSelection, validateEffort } from '../src/providers/effort';
import { chatRequest } from '../src/providers/chat';

describe('reasoning effort selection', () => {
  it('accepts only the selected CLI/model capabilities and supports native future levels', () => {
    const catalog = { status: 'ready' as const, choices: [{ id: 'first', label: 'First', reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'ultra', label: 'Ultra' }] }, { id: 'second', label: 'Second' }] };
    expect(validateEffort('ultra', 'first', catalog)).toBe('ultra');
    expect(validateEffort('', '', undefined)).toBe('');
    for (const [effort, model] of [['high', 'first'], ['low', 'second'], ['low', '']]) expect(() => validateEffort(effort!, model!, catalog)).toThrow('unavailable');
    expect(() => validateEffort('low', 'first', { ...catalog, status: 'loading' })).toThrow('unavailable');
  });
  it('validates host selections/chat requests while preserving Auto as an explicit empty value', () => {
    const base = { requestId: 'r', project: '/p', provider: 'Codex', text: 'hi' };
    expect(chatRequest({ ...base, reasoningEffort: '' }).reasoningEffort).toBe('');
    expect(chatRequest({ ...base, reasoningEffort: 'xhigh' }).reasoningEffort).toBe('xhigh');
    for (const reasoningEffort of [true, 'high\n', 'a'.repeat(33)]) expect(() => chatRequest({ ...base, reasoningEffort })).toThrow();
    expect(effortSelection({ project: '/p', provider: 'Claude', model: 'sonnet', effort: 'max' }).effort).toBe('max');
    expect(() => effortSelection({ project: '/p', provider: 'wrong', model: 'm', effort: 'high' })).toThrow();
  });
  it('persists per project, provider and model, including Auto and corrupt preference recovery', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agentdock-effort-')), store = new EffortStore(directory);
    await Promise.all([store.save('/one', 'Codex', 'm1', 'low'), store.save('/one', 'Codex', 'm2', 'ultra'), store.save('/one', 'Claude', 'm1', 'high')]);
    expect(await new EffortStore(directory).read('/one')).toEqual({ Codex: { m1: 'low', m2: 'ultra' }, Claude: { m1: 'high' } });
    expect(await store.read('/two')).toEqual({ Codex: {}, Claude: {} });
    await store.save('/one', 'Codex', 'm1', '');
    expect((await store.read('/one')).Codex).toEqual({ m1: '', m2: 'ultra' });
    const file = path.join(directory, (await readdir(directory))[0]!);
    expect(JSON.parse(await readFile(file, 'utf8')).Claude.m1).toBe('high');
    await writeFile(file, JSON.stringify({ Codex: { valid: 'high', invalid: 42 }, Claude: null }));
    expect(await store.read('/one')).toEqual({ Codex: { valid: 'high' }, Claude: {} });
    await writeFile(file, '{broken'); expect(await store.read('/one')).toEqual({ Codex: {}, Claude: {} });
  });
});
