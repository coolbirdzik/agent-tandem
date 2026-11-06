import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeLineParts, computePatch } from '../src/core/diff-compute';
import { configureDiffWorker, diffLineParts, diffPatch, disposeDiffWorker } from '../src/core/diff-async';
import { reviewHunks, reviewHunksAsync } from '../src/core/review-hunks';

let directory: string, script: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'agent-tandem-diff-'));
  script = path.join(directory, 'diff-worker.js');
  await build({ entryPoints: ['src/core/diff-worker.ts'], outfile: script, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' });
  return async () => { disposeDiffWorker(); await rm(directory, { recursive: true, force: true }); };
});
afterEach(() => configureDiffWorker(undefined));

const before = 'one\r\nkeep\ntwo\nkeep\nthree', after = 'ONE\r\nkeep\ntwo\nkeep\nTHREE\nfour\n';

describe('diffs off the extension host thread', () => {
  it('gives the worker and inline results that are identical', async () => {
    const inline = [computeLineParts(before, after, 1000), computePatch('a/b.ts', before, after, 1000), reviewHunks(before, after)];
    configureDiffWorker(script);
    expect(await diffLineParts(before, after)).toEqual(inline[0]);
    expect(await diffPatch('a/b.ts', before, after)).toBe(inline[1]);
    expect(await reviewHunksAsync(before, after)).toEqual(inline[2]);
    configureDiffWorker(undefined);
    expect(await reviewHunksAsync(before, after)).toEqual(inline[2]);
  });
  it('runs inline when the script is missing', async () => {
    configureDiffWorker(path.join(directory, 'missing.js'));
    expect(await diffLineParts('a\n', 'b\n')).toEqual(computeLineParts('a\n', 'b\n', 1000));
  });
  it('stops using a script that cannot start and still answers', async () => {
    const broken = path.join(directory, 'broken.js');
    await build({ stdin: { contents: 'throw new Error("broken");', resolveDir: directory }, outfile: broken, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    configureDiffWorker(broken);
    expect(await diffLineParts('a\n', 'b\n')).toEqual(computeLineParts('a\n', 'b\n', 1000));
    expect(await diffPatch('x', 'a\n', 'b\n')).toBe(computePatch('x', 'a\n', 'b\n', 1000));
  });
  it('answers requests that are still waiting when the worker is stopped', async () => {
    configureDiffWorker(script);
    const waiting = Promise.all([diffLineParts(before, after), diffPatch('a.ts', before, after)]);
    disposeDiffWorker();
    expect(await waiting).toEqual([computeLineParts(before, after, 1000), computePatch('a.ts', before, after, 1000)]);
    expect(await diffLineParts(before, after)).toEqual(computeLineParts(before, after, 1000));
  });
  it('keeps the event loop responsive while a slow diff runs, and gives up at the timeout', async () => {
    const lines = (prefix: string) => Array.from({ length: 20000 }, (_, i) => `${prefix}${i}`).join('\n');
    const left = lines('left'), right = lines('right');
    configureDiffWorker(script);
    let ticks = 0; const timer = setInterval(() => { ticks++; }, 10);
    const start = performance.now(), parts = await diffLineParts(left, right, 600);
    clearInterval(timer);
    expect(parts).toBeUndefined();
    expect(performance.now() - start).toBeGreaterThan(300);
    expect(ticks).toBeGreaterThan(10);
    await expect(reviewHunksAsync(left, right)).rejects.toThrow('took too long');
  });
});
