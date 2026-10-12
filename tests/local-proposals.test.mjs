import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it, expect } from 'vitest';
import { parse } from 'jsonc-parser';
import { enableLocalProposals } from '../scripts/local-proposals.mjs';

it('preserves existing JSONC runtime arguments, scopes the grant and backs up once', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'agentdock-argv-')), 'argv.json');
  const original = '// Keep user settings\r\n{\r\n  "disable-hardware-acceleration": true,\r\n  "enable-proposed-api": ["existing.extension"],\r\n}\r\n';
  await writeFile(file, original);
  expect(await enableLocalProposals(file, 'agent-dock-local.agent-dock')).toBe(true);
  const updated = await readFile(file, 'utf8');
  expect(updated.startsWith('// Keep user settings\r\n')).toBe(true);
  expect(parse(updated)).toEqual({ 'disable-hardware-acceleration': true, 'enable-proposed-api': ['existing.extension', 'agent-dock-local.agent-dock'] });
  expect(await readFile(`${file}.agent-dock-backup`, 'utf8')).toBe(original);
  expect(await enableLocalProposals(file, 'agent-dock-local.agent-dock')).toBe(false);
  expect(await readFile(file, 'utf8')).toBe(updated);
  expect(await readFile(`${file}.agent-dock-backup`, 'utf8')).toBe(original);
});
it('leaves malformed user runtime arguments intact', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'agentdock-argv-')), 'argv.json');
  for (const content of ['{ broken', '{ "enable-proposed-api": true }']) {
    await writeFile(file, content);
    await expect(enableLocalProposals(file, 'agent-dock-local.agent-dock')).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(content);
  }
});
