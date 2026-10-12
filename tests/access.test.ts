import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccessModeStore } from '../src/core/access-store';
import { accessMode, accessSelection, codexAccess, claudeAccess } from '../src/providers/access';
import { chatRequest } from '../src/providers/chat';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('Native access modes', () => {
  it('maps full access to native unrestricted execution and default/read-only to their actual limits', () => {
    expect(codexAccess('full-access')).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
    expect(codexAccess()).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    expect(codexAccess('read-only')).toEqual({ approvalPolicy: 'never', sandbox: 'read-only' });
    expect(claudeAccess('full-access')).toEqual({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true });
    for (const [mode, permissionMode] of [['default', 'default'], ['accept-edits', 'acceptEdits'], ['plan', 'plan'], ['dont-ask', 'dontAsk'], ['auto', 'auto']] as const) expect(claudeAccess(mode)).toEqual({ permissionMode, allowDangerouslySkipPermissions: false });
  });
  it('rejects invalid modes and modes from the other provider at the host boundary', () => {
    expect(accessMode(undefined, 'Codex')).toBe('default');
    for (const mode of ['plan', 'auto', true, {}, null, 'danger-full-access']) expect(() => accessMode(mode, 'Codex')).toThrow();
    expect(() => claudeAccess('read-only')).toThrow();
    expect(() => codexAccess('accept-edits')).toThrow();
    for (const value of [null, {}, { project: '/project', provider: 'shell', mode: 'full-access' }, { project: '/project', provider: 'Codex' }]) expect(() => accessSelection(value)).toThrow();
    const request = { requestId: 'r1', project: '/project', provider: 'Claude', text: 'hello', accessMode: 'full-access' };
    expect(chatRequest(request)).toMatchObject(request);
    expect(() => chatRequest({ ...request, accessMode: 'read-only' })).toThrow();
  });
  it('persists choices by project/provider, including simultaneous writes and switching back to default', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentdock-access-')); roots.push(root);
    const store = new AccessModeStore(root), project = path.join(root, 'project');
    expect(await store.read(project)).toEqual({ Codex: 'default', Claude: 'default' });
    await Promise.all([store.save(project, 'Codex', 'full-access'), store.save(project, 'Claude', 'plan')]);
    expect(await new AccessModeStore(root).read(project)).toEqual({ Codex: 'full-access', Claude: 'plan' });
    expect(await store.read(path.join(root, 'other'))).toEqual({ Codex: 'default', Claude: 'default' });
    await store.save(project, 'Codex', 'default');
    expect(await store.read(project)).toEqual({ Codex: 'default', Claude: 'plan' });
  });
  it('invalid saved values fall back to default and failed validation never changes a stored choice', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentdock-access-')); roots.push(root);
    const store = new AccessModeStore(root), project = path.join(root, 'project');
    await store.save(project, 'Codex', 'full-access');
    const file = path.join(root, (await readdir(root))[0]!);
    await expect(store.save(project, 'Codex', 'plan')).rejects.toThrow();
    expect(JSON.parse(await readFile(file, 'utf8')).Codex).toBe('full-access');
    await writeFile(file, JSON.stringify({ Codex: 'bypassPermissions', Claude: 'read-only' }));
    expect(await store.read(project)).toEqual({ Codex: 'default', Claude: 'default' });
    await writeFile(file, '{invalid');
    expect(await store.read(project)).toEqual({ Codex: 'default', Claude: 'default' });
  });
});
