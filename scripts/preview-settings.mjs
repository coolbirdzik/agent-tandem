import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
await mkdir('artifacts', { recursive: true });
await build({ entryPoints: { 'settings-html': 'src/host/settings-html.ts', 'api-pricing': 'src/core/api-pricing.ts' }, outdir: 'artifacts', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs' });
const { settingsHtml } = createRequire(import.meta.url)('../artifacts/settings-html.cjs');
const { apiCost } = createRequire(import.meta.url)('../artifacts/api-pricing.cjs');
const demo = process.argv.includes('--demo');
const demoDate = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Saigon' }).format(Date.now());
const data = demo ? {
  days: Array.from({ length: 7 }, (_, index) => ['Codex', 'Claude'].map(provider => ({
    day: new Date(`${demoDate}T12:00:00Z`).setUTCDate(new Date(`${demoDate}T12:00:00Z`).getUTCDate() - 6 + index),
    provider, model: provider === 'Codex' ? 'Codex demo model' : 'Claude demo model',
    input: 80000 + index * 12000, output: 4000 + index * 1000, cacheRead: 50000 + index * 8000,
    cacheWrite: 0, reasoning: 0, total: 84000 + index * 13000, requests: 8 + index * 2,
  }))).flat().map(row => ({ ...row, day: new Date(row.day).toISOString().slice(0, 10) })),
  updatedAt: Date.now(), files: 12, unreadableFiles: 0, malformedLines: 0, undatedRecords: 0, duplicates: 0, oversizedLines: 0, timezone: 'Asia/Saigon',
} : JSON.parse(await readFile('artifacts/usage-local.json', 'utf8'));
// Demo identities and quota percentages; real token counts remain local-only.
const now = Date.now(); data.updatedAt = now;
const windows = (fiveHour, weekly) => [{ id: '5h', label: '5h', usedPercent: fiveHour, resetsAt: now + 3600000 }, { id: '7d', label: '7d', usedPercent: weekly, resetsAt: now + 3 * 86400000 }];
const state = { status: 'ready', data, preferences: { showQuotaInStatusBar: true, grouping: 'day' }, accounts: {
  Codex: { status: 'ready', updatedAt: now, account: { signedIn: true, email: 'codex@example.test', method: 'ChatGPT', plan: 'plus' }, quota: { status: 'available', windows: windows(25, 50) } },
  Claude: { status: 'ready', updatedAt: now, account: { signedIn: true, email: 'claude@example.test', method: 'Claude account', plan: 'pro' }, quota: { status: 'available', windows: windows(100, 50) } } } };
if (demo) state.quotaHistory = ['Codex', 'Claude'].flatMap(provider => {
  const account = state.accounts[provider];
  return account.quota.windows.flatMap(window => Array.from({ length: 4 }, (_, index) => {
    const duration = window.label === '5h' ? 5 * 3600000 : 7 * 86400000;
    const resetsAt = window.resetsAt - index * duration;
    return { provider, accountId: JSON.stringify([provider, account.account.method, account.account.email, '']),
      plan: account.account.plan, label: window.label === '5h' ? '5h' : 'Weekly', from: resetsAt - duration,
      resetsAt, to: index ? resetsAt - 60000 : now, usedPercent: index ? 84 - index * 7 : window.usedPercent,
      observedTokens: (804531 + index * 76037) * (window.label === '7d' ? 12 : 1), source: provider === 'Codex' ? 'API' : 'Local' };
  }));
});
// Optional fully synthetic fixtures for account-filter UI verification. Never
// relabel the user's real historical tokens with demonstration identities.
const demoDay = demoDate;
function demoRow(provider, email, total) {
  const method = provider === 'Codex' ? 'ChatGPT' : 'Claude account', account = { id: JSON.stringify([provider, method, email, '']), provider, email, method };
  return { day: demoDay, provider, model: provider === 'Codex' ? 'gpt-5.2-codex' : 'claude-sonnet-4-6', account, input: total - 1000, output: 1000, cacheRead: 10000, cacheWrite: 0, reasoning: 0, total, requests: 1 };
}
const accountRows = [demoRow('Codex', 'codex@example.test', 80000), demoRow('Codex', 'work@example.test', 40000), demoRow('Claude', 'claude@example.test', 60000), { ...demoRow('Codex', 'unknown@example.test', 20000), account: undefined }];
const demoDays = Array.from({ length: 7 }, (_, index) => new Date(Date.parse(`${demoDay}T12:00:00Z`) - (6 - index) * 86400000).toISOString().slice(0, 10));
const accountDays = demoDays.flatMap((day, index) => accountRows.map(row => {
  const total = row.total + index * 6000;
  const value = { ...row, day, input: total - 1000, total };
  return { ...value, cost: apiCost(value.provider, value.model, value) };
}));
const accountState = { ...state, accounts: { ...state.accounts, Codex: { ...state.accounts.Codex, usage: { source: 'API', status: 'available', accountId: accountDays[0].account.id, updatedAt: now,
  summary: { lifetimeTokens: 9000000, peakDailyTokens: 1200000, longestRunningTurnSec: 540, currentStreakDays: 7, longestStreakDays: 12 }, daily: demoDays.map((day, index) => ({ day, tokens: 400000 + index * 50000 })) } } },
  data: { ...data, days: accountDays, recent: accountDays.map(row => ({ timestamp: now - 60000, provider: row.provider, total: row.total, ...(row.account ? { accountId: row.account.id } : {}) })) } };
accountState.data.conversations = accountRows.map((row, index) => ({ key: `${row.provider}:demo-${index}`, id: `demo-${index}`, provider: row.provider,
  project: index % 2 ? 'L:/Code/demo-desktop' : 'L:/Code/demo-dashboard', firstAt: now - 6 * 86400000, lastAt: now,
  days: accountDays.filter(day => day.provider === row.provider && day.account?.id === row.account?.id) }));
accountState.conversationTitles = Object.fromEntries(['Add account switching', 'Improve review navigation', 'Fix dashboard filters', 'Update project docs'].map((title, index) => [accountState.data.conversations[index].key, title]));
accountState.managedAccounts = [
  { provider: 'Codex', label: 'Personal', email: 'codex@example.test', plan: 'plus', used: 25, active: true },
  { provider: 'Codex', label: 'Work', email: 'work@example.test', plan: 'team', used: 62 },
  { provider: 'Claude', label: 'Daily', email: 'claude@example.test', plan: 'pro', used: 50, active: true },
  { provider: 'Claude', label: 'Team', email: 'team@example.test', plan: 'max', used: 18 },
  { provider: 'Cursor', label: 'Studio', email: 'studio@example.test', plan: 'pro', active: true },
  { provider: 'Antigravity', label: 'Research', email: 'research@example.test' },
].map((row, index) => {
  const identity = { signedIn: true, email: row.email, plan: row.plan, method: row.provider === 'Codex' ? 'ChatGPT' : `${row.provider} account` };
  return { id: `00000000-0000-4000-8000-00000000000${index}`, provider: row.provider, label: row.label, createdAt: now - 86400000, identity, active: !!row.active,
    status: { status: 'ready', account: identity, updatedAt: now, quota: { status: row.used === undefined ? 'unavailable' : 'available', windows: row.used === undefined ? [] : windows(row.used, row.used / 2) } } };
});
for (const profile of accountState.managedAccounts) if (profile.active && accountState.accounts[profile.provider]) profile.status = accountState.accounts[profile.provider];
accountState.quotaTicks = accountState.managedAccounts.flatMap(profile => profile.status.quota.windows.flatMap(window => Array.from({ length: 7 }, (_, index) => ({
  provider: profile.provider, accountId: JSON.stringify([profile.provider, profile.identity.method, profile.identity.email, '']), plan: profile.identity.plan,
  windowId: window.id, label: window.label, resetsAt: window.resetsAt, at: now - (6 - index) * 10 * 60000, usedPercent: Math.max(0, window.usedPercent - (6 - index) * 2),
}))));
const theme = `:root{--vscode-editor-background:#181818;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#999999;--vscode-panel-border:#303030;--vscode-font-family:'Segoe UI',sans-serif;--vscode-list-hoverBackground:#292929;--vscode-focusBorder:#007fd4;--vscode-button-background:#0078d4;--vscode-button-hoverBackground:#026ec1;--vscode-button-foreground:#ffffff;--vscode-input-foreground:#cccccc;--vscode-input-background:#222222;--vscode-errorForeground:#f48771;--vscode-editorWarning-foreground:#cca700}`;
const lightTheme = `:root{--vscode-editor-background:#ffffff;--vscode-foreground:#333333;--vscode-descriptionForeground:#666666;--vscode-panel-border:#e5e5e5;--vscode-font-family:'Segoe UI',sans-serif;--vscode-list-hoverBackground:#f3f3f3;--vscode-focusBorder:#0078d4;--vscode-button-background:#0078d4;--vscode-button-hoverBackground:#026ec1;--vscode-button-foreground:#ffffff;--vscode-input-foreground:#333333;--vscode-input-background:#f6f6f6;--vscode-errorForeground:#a1260d;--vscode-editorWarning-foreground:#895503}`;
const assets = new Map(['/media/hover-hints.css', '/dist/settings.js', '/media/settings.css', '/media/claude.svg', '/media/codex.svg', '/media/codicons/codicon.css', '/media/codicons/codicon.ttf'].map(uri => [uri, path.join(process.cwd(), uri.slice(1))]));
const storageDemo = { status: 'ready', root: 'Example profile / Code / User / globalStorage / agent-tandem-local.agent-tandem', total: 128 * 1024 * 1024,
  categories: [{ label: 'Review snapshots & tracking', bytes: 96 * 1024 * 1024, files: 840 }, { label: 'Message checkpoints & Undo', bytes: 1024 * 1024, files: 12 }, { label: 'Chat attachments', bytes: 28 * 1024 * 1024, files: 18 }, { label: 'Usage & account evidence', bytes: 3 * 1024 * 1024, files: 24 }], cleanable: { bytes: 12 * 1024 * 1024, files: 2 },
  plan: { token: 'demo-preview', createdAt: now, bytes: 12 * 1024 * 1024, files: [{ relative: 'reviews/history/snapshots/00000000-0000-4000-8000-000000000001.json', bytes: 1024, modified: 0, changed: 0, inode: 1 }, { relative: `reviews/history/blobs/${'0'.repeat(64)}`, bytes: 12 * 1024 * 1024 - 1024, modified: 0, changed: 0, inode: 2 }] } };
storageDemo.histories = [
  { id: 'a'.repeat(64), projectId: 'website', project: 'L:/Code/demo-website', label: 'Demo · Update the dashboard layout', kind: 'checkpoints', count: 14, bytes: 64 * 1024 * 1024, reclaimable: 48 * 1024 * 1024, createdAt: now - 8 * 86400000, updatedAt: now - 86400000 },
  { id: 'b'.repeat(64), projectId: 'website', project: 'L:/Code/demo-website', label: 'Demo · Add image upload', kind: 'checkpoints', count: 6, bytes: 28 * 1024 * 1024, reclaimable: 18 * 1024 * 1024, createdAt: now - 5 * 86400000, updatedAt: now - 3 * 86400000 },
  { id: 'c'.repeat(64), projectId: 'desktop', project: 'L:/Code/demo-desktop', label: 'Demo · Fix folder drag and drop', kind: 'checkpoints', count: 9, bytes: 12 * 1024 * 1024, reclaimable: 9 * 1024 * 1024, createdAt: now - 3 * 86400000, updatedAt: now - 3600000 },
  { id: 'd'.repeat(64), projectId: 'website', project: 'L:/Code/demo-website', label: 'Last restore backup', kind: 'undo', count: 1, bytes: 8 * 1024 * 1024, reclaimable: 2 * 1024 * 1024, createdAt: now - 86400000, updatedAt: now - 86400000 },
  { id: 'e'.repeat(64), projectId: 'desktop', project: 'L:/Code/demo-desktop', label: 'Change tracking baseline', kind: 'tracking', count: 0, bytes: 22 * 1024 * 1024, reclaimable: 22 * 1024 * 1024, createdAt: now - 10 * 86400000, updatedAt: now - 2 * 86400000 },
].sort((a, b) => b.reclaimable - a.reclaimable);
storageDemo.plan = undefined;
const conversationDemo = { status: 'ready', roots: { Codex: 'Example profile / .codex', Claude: 'Example profile / .claude' }, errors: [], conversations: [
  ['Codex', 'Improve file search and keyboard shortcuts', 'L:/Code/demo-desktop', 72, 24.8, false],
  ['Claude', 'Build the account settings screen', 'L:/Code/demo-dashboard', 48, 18.3, false],
  ['Codex', 'Fix the folder drag and drop behavior', 'L:/Code/demo-desktop', 41, 12.7, true],
  ['Claude', 'Simplify the upload flow', 'L:/Code/demo-website', 37, 8.6, false],
  ['Codex', 'Review the storage cleanup implementation', 'L:/Code/demo-dashboard', 33, 6.2, true],
  ['Claude', 'Update navigation and focus states', 'L:/Code/demo-desktop', 31, 4.1, false],
  ['Codex', 'Current workspace conversation', 'L:/Code/demo-desktop', 0, 2.3, false],
].map(([provider, title, project, days, mb, archived], index) => ({ key: `${provider}:demo-cleanup-${index}`, id: `demo-cleanup-${index}`, provider, title, project, archived, lastMessageAt: now - days * 86400000, updatedAt: now - days * 86400000, bytes: Math.round(mb * 1024 * 1024), files: [{ path: `Example profile/${provider}/demo-${index}.jsonl`, bytes: Math.round(mb * 1024 * 1024) }], ...(days === 0 ? { blocked: 'Open conversation or pending message queue.' } : {}) })) };
// Demo lifetime total; the preview adds each simulated deletion to it.
const freedDemo = { bytes: Math.round(842.6 * 1024 * 1024), conversations: 46, files: 1280, runs: 7, lastAt: now - 2 * 3600000, lastBytes: Math.round(64.7 * 1024 * 1024) };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1'), pathname = url.pathname, light = url.searchParams.get('theme') === 'light';
    if (pathname === '/') {
      const base = `http://127.0.0.1:${server.address().port}`;
      let preview = url.searchParams.get('storage') === '1' ? { ...state, data: undefined, storage: storageDemo, conversationCleanup: conversationDemo, storageFreed: freedDemo } : url.searchParams.get('loading') === '1' ? { ...state, status: 'loading', data: undefined, accounts: { Codex: { status: 'loading' }, Claude: { status: 'loading' } } } : url.searchParams.get('accounts') === '1' ? accountState : state;
      if (url.searchParams.get('switch') === '1') {
        if (!demo) throw new Error('Switch screenshots require --demo.');
        const messages = ['Preparing account switch.', 'Checking active agent work.', 'Reading the current native sign-in.', 'Backing up the current sign-in.', 'Checking the selected sign-in.', 'Updating the default CLI sign-in.', 'Verifying the new native sign-in.'];
        preview = { ...accountState, accountsBusy: true, accountSwitch: { id: 'readme-demo-switch', profileId: accountState.managedAccounts[1].id, provider: 'Codex', label: 'Work', status: 'running', outcome: 'unknown', startedAt: now - 4200, logs: messages.map((message, index) => ({ at: now - 4200 + index * 600, level: 'info', message })) } };
      }
      const bootstrap = `window.previewDashboard=${JSON.stringify(preview).replace(/</g, '\\u003c')};window.previewMessages=[];window.pushPreview=()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state:previewDashboard}}));window.acquireVsCodeApi=()=>({postMessage(m){previewMessages.push(m);if(m.type==='scanConversations'){delete previewDashboard.conversationCleanup.plan;pushPreview()}if(m.type==='previewConversationCleanup'){const c=previewDashboard.conversationCleanup;const rows=c.conversations.filter(r=>m.value.keys.includes(r.key));c.plan={token:'demo-conversation-preview',createdAt:Date.now(),conversations:rows,bytes:rows.reduce((s,r)=>s+r.bytes,0)};pushPreview()}if(m.type==='deleteConversations'){const c=previewDashboard.conversationCleanup,f=m.value.filter;const rows=f?c.conversations.filter(r=>(!f.provider||r.provider===f.provider)&&(r.lastMessageAt??r.updatedAt)<f.before):m.value.keys?c.conversations.filter(r=>m.value.keys.includes(r.key)):c.plan.conversations;const ok=rows.filter(r=>!r.blocked);c.status='cleaning';c.dates={done:4,total:9};pushPreview();setTimeout(()=>{delete c.dates;c.done=1;c.total=ok.length;pushPreview()},700);setTimeout(()=>{c.result={removed:ok.map(r=>r.key),bytes:ok.reduce((sum,r)=>sum+r.bytes,0),skipped:[],failures:[],titles:Object.fromEntries(ok.map(r=>[r.key,r.title])),kept:rows.filter(r=>r.blocked).map(r=>({key:r.key,title:r.title,reason:r.blocked}))};const fr=previewDashboard.storageFreed;if(fr&&ok.length){fr.bytes+=c.result.bytes;fr.conversations+=ok.length;fr.runs++;fr.lastAt=Date.now();fr.lastBytes=c.result.bytes}c.status='ready';c.conversations=c.conversations.filter(r=>!c.result.removed.includes(r.key));delete c.plan;pushPreview()},1400)}if(m.type==='preferences'){Object.assign(previewDashboard.preferences,m.value)}if(m.type==='storage'){delete previewDashboard.storage.historyPlan;pushPreview()}if(m.type==='previewHistoryDeletion'){const histories=previewDashboard.storage.histories.filter(g=>m.value.ids.includes(g.id));previewDashboard.storage.historyPlan={token:'demo-delete',createdAt:Date.now(),histories,records:[],bytes:20*1024*1024,files:[{relative:'reviews/history/blobs/'+ '1'.repeat(64),bytes:20*1024*1024,modified:0,changed:0,inode:1}]};pushPreview()}if(m.type==='deleteHistory'){const p=previewDashboard.storage.historyPlan;previewDashboard.storage.historyResult={checkpointsRemoved:p.histories.reduce((s,g)=>s+g.count,0),removed:p.files.length,bytes:p.bytes,skipped:0,failures:[]};previewDashboard.storage.histories=previewDashboard.storage.histories.filter(g=>!p.histories.some(h=>h.id===g.id));previewDashboard.storage.total-=p.bytes;delete previewDashboard.storage.historyPlan;pushPreview()}if(m.type==='refresh'&&previewDashboard.data){previewDashboard.status='loading';pushPreview();setTimeout(()=>{previewDashboard.status='ready';pushPreview()},1200)}else if(['ready','preferences','refresh'].includes(m.type))setTimeout(pushPreview,0)}});`;
      let html = settingsHtml({ script: '/dist/settings.js', style: '/media/settings.css', icons: '/media/codicons/codicon.css', claude: '/media/claude.svg', codex: '/media/codex.svg', nonce: 'preview', cspSource: base });
      html = html.replace('<body ', `<body class="vscode-${light ? 'light' : 'dark'}" `).replace('</head>', `<link rel="stylesheet" href="/theme.css${light ? '?theme=light' : ''}"><script nonce="preview">${bootstrap}</script></head>`);
      if (url.searchParams.get('storage') === '1') html = html.replace('</body>', '<script nonce="preview">setTimeout(()=>document.querySelector("[data-page=storage]").click(),1000)</script></body>');
      if (url.searchParams.get('nativeMatching') === '1') html = html.replace('</body>', `<script nonce="preview">setTimeout(()=>{const age=document.getElementById("native-history-age");age.value=${JSON.stringify(url.searchParams.get('age') ?? '0')};age.dispatchEvent(new Event("change"));document.getElementById("native-history-delete-matching").click()},1600)</script></body>`);
      if (url.searchParams.get('nativeReview') === '1') html = html.replace('</body>', '<script nonce="preview">setTimeout(()=>{document.getElementById("native-history-select").click();document.getElementById("native-history-preview").click()},1600)</script></body>');
      if (url.searchParams.get('page') === 'accounts' || url.searchParams.get('switch') === '1') html = html.replace('</body>', '<script nonce="preview">document.querySelector("[data-page=accounts]").click()</script></body>');
      if (url.searchParams.get('page') === 'preferences') html = html.replace('</body>', '<script nonce="preview">document.querySelector("[data-page=preferences]").click()</script></body>');
      if (url.searchParams.get('view') === 'all') html = html.replace('</body>', `<script nonce="preview">setTimeout(()=>{const view=document.getElementById('dashboard-view');view.value='all';view.dispatchEvent(new Event('change'));const range=document.getElementById('filter-range');range.value=${JSON.stringify(url.searchParams.get('range') === 'month' ? 'month' : 'today')};range.dispatchEvent(new Event('change'))},1000)</script></body>`);
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return;
    }
    if (pathname === '/theme.css') { response.setHeader('Content-Type', 'text/css'); response.end(light ? lightTheme : theme); return; }
    if (!assets.has(pathname)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' }[path.extname(pathname)]);
    response.end(await readFile(assets.get(pathname)));
  } catch { response.writeHead(500).end(); }
});
server.listen(0, '127.0.0.1', () => console.log(`SETTINGS_PREVIEW http://127.0.0.1:${server.address().port}`));
