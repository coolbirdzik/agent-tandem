import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { CheckpointStore, TIMELINE_SETTLE_MS } from '../src/core/checkpoints';
import { ReviewStore } from '../src/core/review';
import { StorageManager } from '../src/core/storage';
import { ProjectConversations, type ConversationContent } from '../src/providers/conversations';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function fixture() {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-timeline-')); folders.push(folder);
  const root = path.join(folder, 'data'), project = path.join(folder, 'project'); await mkdir(project);
  const checkpoints = new CheckpointStore(path.join(root, 'checkpoints'));
  const reviews = new ReviewStore(path.join(root, 'reviews'), undefined, (target, snapshot) => checkpoints.track(target, snapshot));
  const set = (name: string, text: string) => writeFile(path.join(project, name), text);
  const get = (name: string) => readFile(path.join(project, name), 'utf8');
  return { folder, root, project, checkpoints, reviews, set, get };
}
/** A native conversation whose user prompts were sent at the given times. */
const conversation = (times: number[]): ConversationContent => ({
  conversation: { key: 'Codex:native', id: 'native', provider: 'Codex', title: 'Native chat', cwd: '', updatedAt: Date.now(), revision: '1' },
  messages: times.map((at, index) => ({ id: `m${index}`, role: 'user' as const, text: `prompt ${index}`, timestamp: new Date(at).toISOString() })),
});

describe('Change tracking timeline', () => {
  it('restores code to before a message sent from another chat while tracking stays on, and undoes it', async () => {
    const f = await fixture(); await f.set('source.ts', 'first\n');
    const beforeTracking = Date.now(); await tick();
    await f.reviews.initializeExternalTracking(f.project); await tick();
    const sent = Date.now(); await tick();
    // The other chat's agent edits after the prompt was sent.
    await f.set('source.ts', 'agent edit\n'); await f.reviews.scanExternal(f.project);
    const [checkpoint, ...rest] = await f.checkpoints.list(f.project, conversation([beforeTracking, sent]));
    expect(rest).toEqual([]);
    expect(checkpoint).toMatchObject({ messageId: 'm1' });
    const plan = await f.reviews.prepareCheckpoint(f.project, (await f.checkpoints.get(f.project, checkpoint!.id)).snapshot);
    expect(plan.files.map(file => file.path)).toEqual(['source.ts']);
    let backup = '';
    const restored = await f.reviews.restoreCheckpoint(f.project, plan, async snapshot => { backup = (await f.checkpoints.saveUndo(f.project, snapshot)).id; });
    expect(await f.get('source.ts')).toBe('first\n');
    expect(restored.externalTracking).toBe(true);
    // The restored workspace is itself a new state on the timeline.
    expect(await f.checkpoints.timeline(f.project)).toHaveLength(3);
    await f.reviews.restoreCheckpoint(f.project, await f.reviews.prepareCheckpoint(f.project, (await f.checkpoints.get(f.project, backup)).snapshot));
    expect(await f.get('source.ts')).toBe('agent edit\n');
  });

  it('includes edits saved since the last scan when previewing with tracking on', async () => {
    const f = await fixture(); await f.set('source.ts', 'first\n');
    await f.reviews.initializeExternalTracking(f.project);
    const [point] = await f.checkpoints.timeline(f.project);
    await f.set('source.ts', 'not scanned yet\n');
    const plan = await f.reviews.prepareCheckpoint(f.project, point!.snapshot);
    expect(plan.files.map(file => file.path)).toEqual(['source.ts']);
    // The preview scan advanced and saved the baseline, so the edit is reviewable and on the timeline.
    expect((await f.reviews.read(f.project)).files.map(file => file.path)).toEqual(['source.ts']);
    expect(await f.checkpoints.timeline(f.project)).toHaveLength(2);
  });

  it('maps each message to the latest state saved at or before it, and none before tracking or after it stopped', async () => {
    const f = await fixture(), [a, b] = [randomUUID(), randomUUID()];
    await f.checkpoints.track(f.project, a, 1000);
    await f.checkpoints.track(f.project, a, 1500);
    await f.checkpoints.track(f.project, b, 2000);
    await f.checkpoints.track(f.project, undefined, 3000);
    const points = await f.checkpoints.timeline(f.project);
    expect(points.map(point => point.snapshot)).toEqual([a, b]); expect(points[1]!.end).toBe(3000);
    const listed = await f.checkpoints.list(f.project, conversation([500, 1000, 1200, 1999, 2000, 2500, 3000]));
    const byMessage = Object.fromEntries(listed.map(entry => [entry.messageId, entry.id]));
    expect(byMessage).toEqual({ m1: points[0]!.id, m2: points[0]!.id, m3: points[0]!.id, m4: points[1]!.id, m5: points[1]!.id });
    // A message sent from AgentTandem keeps its own checkpoint.
    const own = randomUUID(), content = conversation([1200]);
    await f.checkpoints.record(f.project, content.conversation.key, ['prompt 0'], own);
    expect(await f.checkpoints.list(f.project, content)).toEqual([expect.objectContaining({ messageId: 'm0', id: expect.not.stringMatching(points[0]!.id) })]);
  });

  it('keeps only states a prompt restores to, the newest state and states still settling', async () => {
    const f = await fixture(), now = 100 * TIMELINE_SETTLE_MS;
    const at = [1, 2, 3, 4, 5].map(step => step * 1000), recent = now - TIMELINE_SETTLE_MS + 1000;
    for (const time of [...at, recent, recent + 1000]) await f.checkpoints.track(f.project, randomUUID(), time);
    // Prompts at 2.5 s and 4 s need the states saved at 2 s and 4 s.
    expect(await f.checkpoints.prune(f.project, [2500, 4000], now)).toBe(2);
    // The state at 5 s stays only because its successor is still settling; a prompt may not be indexed yet.
    expect((await f.checkpoints.timeline(f.project)).map(point => point.createdAt)).toEqual([2000, 4000, 5000, recent, recent + 1000]);
    // Decisions before `since` are final even without the prompts that justified them.
    expect(await f.checkpoints.prune(f.project, [], now, 5500)).toBe(0);
    expect(await f.checkpoints.prune(f.project, [], now)).toBe(2);
    expect((await f.checkpoints.timeline(f.project)).map(point => point.createdAt)).toEqual([5000, recent, recent + 1000]);
  });

  it('keeps storage cleanup working and removes the oldest tracking states first under the size limit', async () => {
    const f = await fixture(); await f.set('source.ts', 'first\n');
    await f.reviews.initializeExternalTracking(f.project);
    for (const text of ['second\n', 'third\n']) { await tick(); await f.set('source.ts', text); await f.reviews.scanExternal(f.project); }
    const manager = new StorageManager(f.root), state = await manager.inspect();
    expect(state.cleanupBlocked).toBeUndefined();
    // Tracking timeline states join the project's tracking baseline: they share its snapshots.
    expect(state.histories?.find(history => history.kind === 'tracking')).toMatchObject({ label: 'Change tracking', count: 3 });
    const [oldest, ...newer] = await f.checkpoints.timeline(f.project);
    const result = await manager.enforceLimit(1, { maxRecords: 1 });
    expect(result).toMatchObject({ checkpointsRemoved: 1, failures: [] });
    expect((await f.checkpoints.timeline(f.project)).map(point => point.id)).toEqual(newer.map(point => point.id));
    expect(oldest).toBeTruthy();
  });

  it('reads Claude prompt times from raw records the history SDK leaves out', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-claude-times-')); folders.push(folder);
    const project = path.join(folder, 'project'), home = path.join(folder, 'claude'), id = '33333333-3333-4333-8333-333333333333';
    await mkdir(project); await mkdir(path.join(home, 'projects', 'workspace'), { recursive: true });
    const sent = Date.parse('2026-11-17T08:00:00.000Z');
    const prompt = { type: 'user', uuid: 'prompt-1', message: { role: 'user', content: [{ type: 'text', text: 'Fix the bug' }] } };
    await writeFile(path.join(home, 'projects', 'workspace', `${id}.jsonl`), [
      { ...prompt, timestamp: new Date(sent).toISOString() },
      { type: 'user', uuid: 'result-1', timestamp: new Date(sent + 1000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
      { type: 'user', uuid: 'sub-1', isSidechain: true, timestamp: new Date(sent + 2000).toISOString(), message: { content: [{ type: 'text', text: 'Subagent task' }] } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const source = new ProjectConversations(async () => ({ listSessions: async () => [{ sessionId: id, summary: 'Claude chat', cwd: project, lastModified: sent }], getSessionMessages: async () => [prompt] }) as never, path.join(folder, 'codex'), home);
    const [listed] = (await source.list(project)).conversations;
    const content = await source.read(listed!, project);
    expect(content.messages).toEqual([expect.objectContaining({ id: 'prompt-1', role: 'user', timestamp: new Date(sent).toISOString() })]);
    expect(await source.promptTimes(listed!, project)).toEqual([sent]);
  });
});
