import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd(), runtime = path.join(root, '.test-runtime', `usage-local-${Date.now()}`);
await mkdir(runtime, { recursive: true });
const file = path.join(runtime, 'usage.mjs');
await build({ entryPoints: ['src/providers/usage-history.ts'], outfile: file, bundle: true, platform: 'node', format: 'esm', target: 'node22' });
const { UsageHistory } = await import(pathToFileURL(file).href), history = new UsageHistory();
const started = Date.now(), value = await history.read();
const totals = value.days.reduce((result, row) => { for (const key of Object.keys(result)) result[key] += row[key]; return result; }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, requests: 0 });
const providers = Object.fromEntries(['Codex', 'Claude'].map(provider => [provider, value.days.filter(row => row.provider === provider).reduce((sum, row) => sum + row.total, 0)]));
// Only aggregates leave the reader, never prompts, paths, email or credentials.
const report = { success: true, durationMs: Date.now() - started, ...value, totals, providers };
await mkdir(path.join(root, 'artifacts'), { recursive: true });
await writeFile(path.join(root, 'artifacts/usage-local.json'), JSON.stringify(report, null, 2));
console.log(`AGENT_TANDEM_USAGE_LOCAL ${JSON.stringify({ ...report, days: value.days.length, recent: value.recent?.length })}`);
