import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runtime = path.join(process.cwd(), '.test-runtime', `usage-performance-${Date.now()}`);
await mkdir(runtime, { recursive: true });
const bundle = path.join(runtime, 'usage.mjs'), cache = path.join(runtime, 'cache');
const baseline = process.argv.includes('--baseline');
const entry = baseline ? { stdin: { contents: (await promisify(execFile)('git', ['show', ':src/providers/usage-history.ts'], { windowsHide: true })).stdout, resolveDir: path.join(process.cwd(), 'src/providers'), sourcefile: 'usage-baseline.ts', loader: 'ts' } } : { entryPoints: ['src/providers/usage-history.ts'] };
await build({ ...entry, outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22' });
const { UsageHistory } = await import(pathToFileURL(bundle).href);
const reader = new UsageHistory(undefined, undefined, cache), runs = [];
for (const [name, history] of [['cold', reader], ['warm', reader], ['reload', new UsageHistory(undefined, undefined, cache)]]) {
  const start = performance.now(), value = await history.read();
  const digest = createHash('sha256').update(JSON.stringify(value.days)).digest('hex');
  const run = { name, durationMs: Math.round(performance.now() - start), files: value.files, days: value.days.length, requests: value.days.reduce((n, row) => n + row.requests, 0), digest,
    ...Object.fromEntries(Object.entries(history.readStats ?? {}).map(([key, value]) => [key, Math.round(value)])) };
  runs.push(run); console.log(JSON.stringify(run));
}
await mkdir('artifacts', { recursive: true });
await writeFile(`artifacts/usage-performance${baseline ? '-baseline' : ''}.json`, JSON.stringify({ runs, sameTotals: runs.every(run => run.digest === runs[0].digest) }, null, 2));
