import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deleteCodexThread } from '../src/providers/codex-history-mutation';

describe('Codex native deletion transport', () => {
  it('initializes the native protocol, deletes the exact thread and terminates the process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-delete-rpc-')), log = path.join(root, 'rpc.jsonl');
    const script = `const fs = require('node:fs'); const lines = require('node:readline').createInterface({input: process.stdin}); lines.on('line', line => { fs.appendFileSync(process.argv[1], line+'\\n'); const request=JSON.parse(line); if(request.id) process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n'); });`;
    const launch = () => spawn(process.execPath, ['-e', script, log], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let child: ReturnType<typeof launch> | undefined;
    try {
      await deleteCodexThread('unused', 'selected-thread', () => { child = launch(); return child; });
      const requests = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests.map(row => row.method)).toEqual(['initialize', 'initialized', 'thread/delete']);
      expect(requests[2].params).toEqual({ threadId: 'selected-thread' }); expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('reports unsupported native deletion without falling back to deleting files', async () => {
    const script = `require('node:readline').createInterface({input:process.stdin}).on('line', line => { const r=JSON.parse(line); if(r.id) process.stdout.write(JSON.stringify(r.method==='thread/delete'?{id:r.id,error:{code:-32601,message:'Method not found'}}:{id:r.id,result:{}})+'\\n'); });`;
    await expect(deleteCodexThread('unused', 'selected', () => spawn(process.execPath, ['-e', script], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }))).rejects.toThrow('Update the CLI');
  });
});
