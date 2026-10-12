import { build, context } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await copyFile('node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md', 'dist/claude-sdk-LICENSE.md');
await copyFile('node_modules/diff/LICENSE', 'dist/diff-LICENSE.txt');
await copyFile('node_modules/ignore/LICENSE-MIT', 'dist/ignore-LICENSE.txt');
await copyFile('node_modules/jsonc-parser/LICENSE.md', 'dist/jsonc-parser-LICENSE.md');
await mkdir('media/codicons', { recursive: true });
await copyFile('node_modules/@vscode/codicons/LICENSE-CODE', 'media/codicons/License.txt');
for (const file of ['codicon.css', 'codicon.ttf']) await copyFile(`node_modules/@vscode/codicons/dist/${file}`, `media/codicons/${file}`);
for (const [source, target] of [['node_modules/@vscode/codicons/LICENSE', 'codicons-LICENSE.txt'], ['node_modules/marked/LICENSE', 'marked-LICENSE.md'], ['node_modules/dompurify/LICENSE', 'dompurify-LICENSE.txt']]) await copyFile(source, `dist/${target}`);
const configs = [
  { entryPoints: ['tests/extension/external-review.ts'], outfile: 'dist/external-review-host-tests.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { entryPoints: ['tests/extension/settings.ts'], outfile: 'dist/settings-host-tests.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { entryPoints: ['tests/extension/change-navigation.ts'], outfile: 'dist/change-navigation-tests.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { entryPoints: ['tests/extension/checkpoints.ts'], outfile: 'dist/checkpoint-tests.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { entryPoints: ['tests/extension/cli-manager-live.ts'], outfile: 'dist/cli-manager-live-tests.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { entryPoints: ['src/providers/claude-history.ts'], outfile: 'dist/claude-history.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node20' },
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: true },
  { entryPoints: ['src/webview.ts'], outfile: 'dist/webview.js', bundle: true, platform: 'browser', format: 'iife', target: 'es2022', sourcemap: true },
  { entryPoints: ['src/settings.ts'], outfile: 'dist/settings.js', bundle: true, platform: 'browser', format: 'iife', target: 'es2022', sourcemap: true },
  { entryPoints: ['tests/extension/index.ts'], outfile: 'dist/extension-tests.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { entryPoints: ['tests/extension/review-live.ts'], outfile: 'dist/review-live-tests.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { entryPoints: ['tests/extension/stop-live.ts'], outfile: 'dist/stop-live-tests.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { entryPoints: ['tests/extension/edit-live.ts'], outfile: 'dist/edit-live-tests.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { entryPoints: ['tests/extension/access-live.ts'], outfile: 'dist/access-live-tests.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { entryPoints: ['tests/extension/models-live.ts'], outfile: 'dist/models-live-tests.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { entryPoints: ['tests/extension/context-history.ts'], outfile: 'dist/context-history-tests.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
];
if (process.argv.includes('--watch')) {
  for (const config of configs) await (await context(config)).watch();
} else {
  for (const config of configs) await build(config);
}
