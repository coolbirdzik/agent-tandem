import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import { ModelStore } from '../src/core/model-store';
import { modelSelection, validateModel, validateModelCLI } from '../src/providers/models';
import { codexModels, claudeModels } from '../src/providers/model-catalog';
import { chatRequest } from '../src/providers/chat';

describe('model selection', () => {
  it('requires an explicit model to come from the same CLI path and version used for inference', () => {
    const cli = { executable: 'C:\\Cli\\codex.exe', version: '0.162.0' };
    const catalog = { status: 'ready' as const, choices: [], cli };
    expect(() => validateModelCLI('model', catalog, { ...cli, executable: 'c:/cli/codex.exe' })).not.toThrow();
    expect(() => validateModelCLI('model', catalog, { ...cli, version: '0.147.0' })).toThrow('CLI changed');
    expect(() => validateModelCLI('model', catalog, { ...cli, executable: 'C:\\Other\\codex.exe' })).toThrow('CLI changed');
    expect(() => validateModelCLI('', undefined, cli)).not.toThrow();
  });
  it('validates IDs and preserves an explicit default on chat requests', () => {
    const request = { requestId: 'r', project: '/p', provider: 'Claude', text: 'hi' };
    expect(chatRequest({ ...request, model: 'sonnet[1m]' }).model).toBe('sonnet[1m]');
    expect(chatRequest({ ...request, model: '' }).model).toBe('');
    for (const model of [42, 'bad\nmodel', 'a'.repeat(257)]) expect(() => chatRequest({ ...request, model })).toThrow();
    expect(() => modelSelection({ project: '/p', provider: 'wrong', model: 'x' })).toThrow();
    expect(validateModel('', { status: 'error', choices: [] })).toBe('');
    expect(() => validateModel('old', { status: 'ready', choices: [{ id: 'new', label: 'New' }] })).toThrow('unavailable');
    expect(() => validateModel('new', { status: 'loading', choices: [{ id: 'new', label: 'New' }] })).toThrow('unavailable');
  });
  it('persists separately per project/provider, supports default reset and ignores corrupt preferences', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-models-')), store = new ModelStore(directory);
    await Promise.all([store.save('/one', 'Codex', 'codex-a'), store.save('/one', 'Claude', 'sonnet')]);
    expect(await new ModelStore(directory).read('/one')).toEqual({ Codex: 'codex-a', Claude: 'sonnet' });
    expect(await store.read('/two')).toEqual({ Codex: '', Claude: '' });
    await store.save('/one', 'Codex', ''); expect(await store.read('/one')).toEqual({ Codex: '', Claude: 'sonnet' });
    const file = path.join(directory, (await readdir(directory))[0]!);
    expect(JSON.parse(await readFile(file, 'utf8')).Claude).toBe('sonnet');
    await writeFile(file, '{broken'); expect(await store.read('/one')).toEqual({ Codex: '', Claude: '' });
  });
});
describe('native model discovery', () => {
  it('reads every Codex page using only initialize/model-list and reaps the child', async () => {
    let child: ReturnType<typeof spawn>;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agenttandem-catalog-')), log = path.join(directory, 'rpc.jsonl');
    const models = await codexModels(process.cwd(), process.execPath, undefined, () => child = spawn(process.execPath, [path.resolve('tests/fixtures/codex-chat-server.mjs')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_TANDEM_RPC_LOG: log },
    }) as any);
    expect(models.map(row => row.id)).toEqual(['fixture-supported', 'fixture-default']);
    expect(models[0]!.reasoningEfforts?.map(row => row.id)).toEqual(['low', 'medium', 'ultra']);
    expect(models[0]!.defaultReasoningEffort).toBe('medium');
    expect((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list']);
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  });
  it('cancels a hung Codex initialization and reaps its owned process', async () => {
    let child: ReturnType<typeof spawn>;
    const abort = new AbortController();
    const job = codexModels(process.cwd(), process.execPath, abort.signal, () => child = spawn(process.execPath, [path.resolve('tests/fixtures/codex-chat-server.mjs')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_TANDEM_MODEL_CASE: 'hung-init' },
    }) as any);
    setTimeout(() => abort.abort(), 150);
    await expect(job).rejects.toThrow('cancelled');
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  });
  it('gets Claude native aliases without sending a user prompt or persisting a session', async () => {
    let invocation: any; const close = vi.fn();
    const fake = vi.fn(args => { invocation = args; return { supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet', description: 'Fast' }, { value: 'opus', displayName: 'Opus' }], close }; });
    expect(await claudeModels(process.cwd(), fake as unknown as typeof query, process.execPath)).toEqual([{ id: 'sonnet', label: 'Sonnet', description: 'Fast' }, { id: 'opus', label: 'Opus', description: undefined }]);
    expect(invocation.options.persistSession).toBe(false);
    expect(invocation.options.settingSources).toEqual(['user', 'project', 'local']);
    expect(typeof invocation.prompt).not.toBe('string');
    expect(await invocation.prompt.next()).toEqual({ done: true, value: undefined });
    expect(close).toHaveBeenCalledOnce();
  });
  it('closes a hung Claude catalog when cancelled', async () => {
    const close = vi.fn(), abort = new AbortController();
    const fake = (() => ({ supportedModels: () => new Promise(() => {}), close })) as unknown as typeof query;
    const job = claudeModels(process.cwd(), fake, process.execPath, abort.signal);
    setTimeout(() => abort.abort(), 50);
    await expect(job).rejects.toThrow('cancelled'); expect(close).toHaveBeenCalledOnce();
  });
  it('uses Claude native per-model effort metadata and leaves unsupported models unset', async () => {
    const fake = (() => ({ supportedModels: async () => [
      { value: 'sonnet', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'xhigh'] },
      { value: 'haiku', displayName: 'Haiku', supportsEffort: false, supportedEffortLevels: ['high'] },
    ], close: () => undefined })) as unknown as typeof query;
    const rows = await claudeModels(process.cwd(), fake, process.execPath);
    expect(rows[0]!.reasoningEfforts?.map(row => [row.id, row.label])).toEqual([['low', 'Low'], ['xhigh', 'Extra high']]);
    expect(rows[1]!.reasoningEfforts).toBeUndefined();
  });
});
