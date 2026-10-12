import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import path from 'node:path';
import { createRequire } from 'node:module';

await mkdir('artifacts', { recursive: true });
await build({ entryPoints: ['src/host/panel-html.ts'], outfile: 'artifacts/panel-html.cjs', bundle: true, platform: 'node', format: 'cjs' });
const { panelHtml } = createRequire(import.meta.url)('../artifacts/panel-html.cjs');
const project = 'L:\\Code\\agent-dock';
const conversation = { key: 'Codex:preview', id: 'preview', provider: 'Codex', title: 'Model picker and chat layout', cwd: project, revision: 'preview:1', updatedAt: Date.now() };
const state = {
  sessions: [], running: false, providers: [], project, projectName: 'agent-dock', screen: 'conversations', composeProvider: 'Codex',
  selectedModels: { Codex: 'gpt-5.2-codex', Claude: 'sonnet' }, accessModes: { Codex: 'full-access', Claude: 'default' },
  modelCatalogs: { Codex: { status: 'ready', choices: [{ id: 'gpt-5.2-codex', label: 'gpt-5.2-codex', reasoningEfforts: [{id:'low',label:'Low'},{id:'medium',label:'Medium'},{id:'high',label:'High'},{id:'xhigh',label:'Extra high'}] }, { id: 'gpt-5.2', label: 'gpt-5.2' }] }, Claude: { status: 'ready', choices: [{ id: 'sonnet', label: 'Sonnet', reasoningEfforts: [{id:'low',label:'Low'},{id:'medium',label:'Medium'},{id:'high',label:'High'}] }, { id: 'opus', label: 'Opus' }] } },
  accounts: { Codex: {status:'ready',account:{signedIn:true,email:'demo@example.test',method:'ChatGPT',plan:'plus'},quota:{status:'available',windows:[{id:'5h',label:'5h',usedPercent:25},{id:'7d',label:'7d',usedPercent:82}]} } },
  conversations: [conversation], conversation: { conversation, usage: {usedTokens:46000,windowTokens:200000,cachedTokens:42000,cacheTtlMs:300000,cacheExpiresAt:Date.now()+300000}, messages: [
    { id: 'u1', role: 'user', text: 'Make the chat flat and use the models from my CLI.' },
    { id: 'tool1', role: 'tool', toolName: 'Read', text: 'src/providers/probe.ts\nmedia/panel.css' },
    { id: 'a1', role: 'assistant', text: 'The model picker now follows your terminal CLI. You can choose another installation in Diagnostics.\n\nThe chat uses one surface, compact controls and plain tool rows.' },
    { id: 'u2', role: 'user', text: 'Also collapse the pending changes box and let me jump back to an older message.' },
    { id: 'a2', role: 'assistant', text: 'The pending changes box now collapses to its heading, and the chat has an arrow pair that focuses your previous or next message.' },
    { id: 'u3', role: 'user', text: 'Show me how it looks in a narrow sidebar.' },
  ] },
  review: { project, revision: 'preview', busy: false, files: [{ path: 'src/providers/probe.ts', kind: 'modified', additions: 24, deletions: 18 }, { path: 'media/panel.css', kind: 'modified', additions: 12, deletions: 10 }] },
};
const historyRoot = process.argv[process.argv.indexOf('--history') + 1];
if (process.argv.includes('--history') && historyRoot) {
  await build({ entryPoints: ['src/providers/conversations.ts'], outfile: 'artifacts/history-preview.mjs', bundle: true, platform: 'node', format: 'esm', external: ['node:sqlite'] });
  const { ProjectConversations } = await import('../artifacts/history-preview.mjs');
  const sdk = await import('../dist/claude-history.mjs');
  const index = await new ProjectConversations(async () => sdk).list(historyRoot);
  state.project = historyRoot; state.projectName = path.basename(historyRoot);
  state.conversations = index.conversations; state.conversation = undefined; state.review = undefined; state.syncErrors = index.errors;
}
const theme = `:root{--vscode-sideBar-background:#181818;--vscode-editor-background:#1f1f1f;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#999999;--vscode-panel-border:#303030;--vscode-widget-border:#303030;--vscode-list-hoverBackground:#292929;--vscode-list-inactiveSelectionBackground:#333333;--vscode-font-family:'Segoe UI',sans-serif;--vscode-editor-font-family:Consolas,monospace;--vscode-focusBorder:#007fd4;--vscode-textLink-foreground:#4daafc;--vscode-button-background:#0078d4;--vscode-button-hoverBackground:#026ec1;--vscode-button-foreground:#ffffff;--vscode-input-foreground:#cccccc;--vscode-input-placeholderForeground:#868686;--vscode-input-background:#222222;--vscode-dropdown-background:#222222;--vscode-dropdown-foreground:#cccccc;--vscode-errorForeground:#f48771;--vscode-textCodeBlock-background:#202020}`;
const assets = new Map(['/dist/webview.js', '/media/panel.css', '/media/codicons/codicon.css', '/media/codicons/codicon.ttf', '/media/codex.svg', '/media/claude.svg'].map(uri => [uri, path.join(process.cwd(), uri.slice(1))]));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1'), pathname = url.pathname;
    if (pathname === '/') {
      const port = server.address().port, base = `http://127.0.0.1:${port}`;
      const phase = url.searchParams.get('activity'), preview = ['preparing', 'working', 'waiting', 'finishing', 'stopping'].includes(phase) ? { ...structuredClone(state), chat: { requestId: 'preview', provider: 'Codex', conversationKey: state.conversation.conversation.key, status: 'running', phase: phase === 'waiting' ? 'working' : phase, prompts: phase === 'waiting' ? [{ id: 'preview-prompt', title: 'Allow reading the attached file?', detail: 'Preview approval' }] : [] } } : structuredClone(state);
      if (url.searchParams.get('external') === '1') { preview.review = { ...preview.review, externalTracking: true, notice: 'External changes: saved workspace edits from any app are tracked. The writer is not inferred.' }; preview.screen = 'changes'; }
      if (url.searchParams.get('groups') === '1') {
        const claude = { ...conversation, key: 'Claude:preview-claude', id: 'preview-claude', provider: 'Claude', title: 'Fix authentication redirects' };
        preview.screen = 'changes'; preview.conversations = [conversation, claude];
        const owned = (source) => [{ from: 1, to: 2, conversations: [source] }];
        preview.review = { revision: 'groups-preview', busy: false, externalTracking: true, files: [
          { path: 'src/providers/models.ts', kind: 'modified', binary: false, additions: 24, deletions: 18, captures: owned(conversation) },
          { path: 'src/auth/session.ts', kind: 'modified', binary: false, additions: 12, deletions: 4, captures: owned(claude) },
          { path: 'src/core/config.ts', kind: 'modified', binary: false, additions: 3, deletions: 2, captures: [{ from: 1, to: 2, conversations: [conversation, claude] }] },
          { path: 'README.md', kind: 'modified', binary: false, additions: 6, deletions: 0 },
        ] };
      }
      const bootstrap = `window.previewState=${JSON.stringify(preview)};window.previewMessages=[];window.acquireVsCodeApi=()=>({postMessage(m){previewMessages.push(m);if(m.type==='setModel')previewState.selectedModels[m.selection.provider]=m.selection.model;if(m.type==='setReasoningEffort'){previewState.selectedEfforts??={Codex:{},Claude:{}};previewState.selectedEfforts[m.selection.provider][m.selection.model]=m.selection.effort}if(m.type==='setAccessMode')previewState.accessModes[m.selection.provider]=m.selection.mode;if(m.type==='previewRevert'){const r=m.selection;const matches=f=>(!r.file||r.file===f.path)&&(!r.group||r.group===((f.captures?.[0]?.conversations?.length===1)?f.captures[0].conversations[0].key:f.captures?.[0]?.conversations?.length?'shared':'unassigned'));previewState.revertPreview={token:'preview',request:r,files:previewState.review.files.filter(matches)};previewState.screen='changes'}if(m.type==='cancelRevert')previewState.revertPreview=undefined;if(m.type==='confirmRevert'&&previewState.revertPreview){window.previewUndo=previewState.revertPreview.files;previewState.review.files=previewState.review.files.filter(f=>!previewUndo.includes(f));previewState.review.undo={id:'undo',createdAt:Date.now(),files:previewUndo.map(f=>f.path)};previewState.revertPreview=undefined;previewState.review.revision+='r'}if(m.type==='undoRevert'){previewState.review.files.push(...previewUndo);previewState.review.undo=undefined;previewState.review.revision+='u'}if(m.type==='screen')previewState.screen=m.selection;if(m.type==='ready'||m.type==='setModel'||m.type==='setReasoningEffort'||m.type==='setAccessMode'||['previewRevert','cancelRevert','confirmRevert','undoRevert','screen'].includes(m.type))setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state:previewState}})),0)}});`;
      let html = panelHtml({ script: '/dist/webview.js', style: '/media/panel.css', icons: '/media/codicons/codicon.css', codex: '/media/codex.svg', claude: '/media/claude.svg', nonce: 'panel-preview', cspSource: base });
      html = html.replace('</head>', '<link rel="stylesheet" href="/theme.css"><script nonce="panel-preview">' + bootstrap + '</script></head>').replace('<body ', '<body class="vscode-dark" ');
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return;
    }
    if (pathname === '/theme.css') { response.setHeader('Content-Type', 'text/css'); response.end(theme); return; }
    if (!assets.has(pathname)) { response.writeHead(404).end(); return; }
    const contentType = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' }[path.extname(pathname)];
    response.setHeader('Content-Type', contentType); response.end(await readFile(assets.get(pathname)));
  } catch { response.writeHead(500).end(); }
});
server.listen(0, '127.0.0.1', () => console.log(`PANEL_PREVIEW http://127.0.0.1:${server.address().port}`));
