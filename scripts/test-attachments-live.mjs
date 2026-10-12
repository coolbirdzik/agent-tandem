import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { query, getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { providerTestHomes } from './provider-test-homes.mjs';
const root = process.cwd(), runtime = path.join(root, '.test-runtime', `attachments-live-${Date.now()}`), workspace = path.join(runtime, 'workspace');
await mkdir(workspace, { recursive: true }); Object.assign(process.env, await providerTestHomes(runtime));
const modules = {};
for (const name of ['codex-chat', 'claude-chat', 'account-status', 'conversations']) {
  const file = path.join(runtime, `${name}.mjs`);
  await build({ entryPoints: [`src/providers/${name}.ts`], outfile: file, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
  modules[name] = await import(pathToFileURL(file).href);
}
// A small lossless fixture, red on the left and blue on the right.
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, bytes) { const body = Buffer.concat([Buffer.from(type), bytes]), header = Buffer.alloc(4), crc = Buffer.alloc(4); header.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([header, body, crc]); }
const width = 80, height = 40, pixels = Buffer.alloc(height * (width * 3 + 1));
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * (width * 3 + 1) + 1 + x * 3 + (x < width / 2 ? 0 : 2)] = 255;
const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
await writeFile(path.join(runtime, 'colors.png'), png);
const checks = [];
const documentsOnly = process.argv.includes('--documents-only');
const sentinel = 'ATTACHMENT_NATIVE_DOCUMENT_OK';
const pdfStream = `BT /F1 14 Tf 50 740 Td (${sentinel}) Tj ET`;
const pdfObjects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(pdfStream)} >>\nstream\n${pdfStream}\nendstream`];
let pdfText = '%PDF-1.4\n', offsets = [0];
pdfObjects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdfText)); pdfText += `${index + 1} 0 obj\n${object}\nendobj\n`; });
const xref = Buffer.byteLength(pdfText);
pdfText += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const notes = { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from(sentinel).toString('base64'), path: path.join(runtime, 'notes.txt') };
await writeFile(notes.path, sentinel);
for (const provider of ['Codex', 'Claude']) {
  const check = { provider }; checks.push(check);
  try {
    const account = provider === 'Codex' ? await modules['account-status'].readCodexAccount(workspace) : await modules['account-status'].readClaudeAccount(workspace, query);
    if (account.quota?.windows.some(window => window.usedPercent >= 100 && (!window.resetsAt || window.resetsAt > Date.now()))) { check.status = 'skipped'; check.reason = 'Subscription quota exhausted'; continue; }
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 90000), messages = new Map(); let sessionId;
    const callbacks = { session(id) { sessionId = id; }, message(message, append) { if (message.role === 'assistant') messages.set(message.id, append ? (messages.get(message.id) ?? '') + message.text : message.text); }, async prompt() { throw new Error('The image test does not need tools or approval.'); } };
    const request = { requestId: `attachment-${provider}`, project: workspace, provider,
      text: documentsOnly ? 'Read the attached document and reply with its exact text. Do not change any files.' : 'Look at the attached image. State the color on its left half and right half, in that order. Reply only with those two color names. Do not use tools or read/change files.',
      attachments: documentsOnly ? provider === 'Codex' ? [notes] : [{ name: 'reference.pdf', mimeType: 'application/pdf', data: Buffer.from(pdfText).toString('base64') }] : [{ name: 'colors.png', mimeType: 'image/png', data: png.toString('base64') }],
      ...(documentsOnly && provider === 'Codex' ? { preparedAttachments: [notes] } : {}), accessMode: provider === 'Codex' ? documentsOnly ? 'full-access' : 'read-only' : 'default' };
    let result; try { result = provider === 'Codex' ? await modules['codex-chat'].runCodexChat(request, callbacks, abort.signal) : await modules['claude-chat'].runClaudeChat(request, callbacks, abort, query); } finally { clearTimeout(timer); }
    assert.equal(result, 'completed'); assert.ok(sessionId);
    const reply = [...messages.values()].join('\n'); assert.match(reply, documentsOnly ? new RegExp(sentinel) : /red[\s\S]*blue/i);
    const source = new modules.conversations.ProjectConversations(async () => ({ getSessionMessages, listSessions }));
    const index = await source.list(workspace), conversation = index.conversations.find(row => row.id === sessionId); assert.ok(conversation, 'Native conversation is recorded');
    const content = await source.read(conversation, workspace), user = content.messages.find(row => row.role === 'user');
    if (!documentsOnly || provider === 'Claude') assert.ok(user?.attachments?.length, 'Embedded bytes survive native history refresh');
    assert.equal(content.messages.filter(row => row.role === 'user').length, 1, 'Native attachment metadata does not create duplicate human messages');
    check.status = 'completed';
    if (documentsOnly) { check.documentRead = true; if (provider === 'Claude') check.historyDocumentPreserved = true; }
    else { check.visionRecognized = true; check.historyImagePreserved = true; }
  } catch (error) { check.status = 'failed'; check.error = error.message; }
  finally { console.log(`AGENT_DOCK_ATTACHMENTS_LIVE ${JSON.stringify(check)}`); }
}
const success = checks.every(check => check.status === 'completed');
await mkdir(path.join(root, 'artifacts'), { recursive: true }); await writeFile(path.join(root, 'artifacts', documentsOnly ? 'attachments-documents-live.json' : 'attachments-live.json'), JSON.stringify({ success, checks }, null, 2));
if (!success) process.exitCode = 1;
