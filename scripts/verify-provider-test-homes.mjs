import path from 'node:path';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { providerTestHomes } from './provider-test-homes.mjs';

const runtime = path.join(process.cwd(), '.test-runtime', `isolation-check-${Date.now()}`);
const workspace = path.join(runtime, 'workspace'); await mkdir(workspace, { recursive: true });
const homes = await providerTestHomes(runtime); Object.assign(process.env, homes);
await build({ entryPoints: ['src/providers/model-catalog.ts'], outfile: 'artifacts/isolation-catalog.cjs', bundle: true, platform: 'node', format: 'cjs' });
const { codexModels, claudeModels } = createRequire(import.meta.url)('../artifacts/isolation-catalog.cjs');
const { query } = await import('../dist/claude-history.mjs');
const results = await Promise.all([codexModels(workspace), claudeModels(workspace, query)]);
const entries = async folder => { try { return await readdir(folder, { recursive: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const histories = await Promise.all([entries(path.join(homes.CODEX_HOME, 'sessions')), entries(path.join(homes.CLAUDE_CONFIG_DIR, 'projects'))]);
const report = { success: results.every(rows => rows.length > 0) && histories.every(rows => !rows.some(file => file.endsWith('.jsonl'))), models: results.map(rows => rows.length), isolatedHomes: homes, createdConversations: histories.map(rows => rows.filter(file => file.endsWith('.jsonl')).length) };
await writeFile('artifacts/provider-test-isolation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report)); if (!report.success) process.exitCode = 1;
