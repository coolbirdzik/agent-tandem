import { describe, it, expect, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DesktopAccounts, desktopDatabase, validateDesktopSignIn, type DesktopSignIn } from '../src/core/desktop-accounts';
import { AccountProfiles } from '../src/core/account-profiles';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(entries: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-desktop-auth-')); roots.push(root);
  await mkdir(path.dirname(desktopDatabase(root)), { recursive: true });
  const db = new DatabaseSync(desktopDatabase(root)); db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE, value TEXT)');
  for (const [key, value] of Object.entries(entries)) db.prepare('INSERT INTO ItemTable (key,value) VALUES (?,?)').run(key, value); db.close(); return root;
}
function read(home: string, key: string) { const db = new DatabaseSync(desktopDatabase(home)); try { return db.prepare('SELECT value FROM ItemTable WHERE key=?').get(key)?.value; } finally { db.close(); } }
const cursor = (email: string): DesktopSignIn => ({ version: 1, provider: 'Cursor', entries: { 'cursorAuth/cachedEmail': email, 'cursorAuth/accessToken': `secret-${email}`, 'cursorAuth/refreshToken': `refresh-${email}` } });
describe('Native desktop sign-ins', () => {
  it('reads Antigravity unified-state display identity and keeps identity stable across token rotation', async () => {
    const field = (id: number, value: string | Buffer) => { const bytes = Buffer.from(value); return Buffer.concat([Buffer.from([id * 8 + 2, bytes.length]), bytes]); };
    const topic = (sentinel: string, payload: Buffer) => field(1, Buffer.concat([field(1, sentinel), field(2, field(1, payload.toString('base64')))] )).toString('base64');
    const snapshot = (token: string): DesktopSignIn => ({ version: 1, provider: 'Antigravity', entries: { 'antigravityUnifiedStateSync.userStatus': topic('userStatusSentinelKey', field(3, 'person@example.test')), 'antigravityUnifiedStateSync.oauthToken': topic('oauthTokenInfoSentinelKey', Buffer.concat([field(1, token), field(3, 'stable-refresh')])) } });
    const adapter = new DesktopAccounts(); const first = await adapter.identity(snapshot('first')), second = await adapter.identity(snapshot('rotated'));
    expect(first.email).toBe('person@example.test'); expect(second.id).toBe(first.id); expect(JSON.stringify(first)).not.toContain('refresh');
  });
  it('switches Cursor auth transactionally, clears previous optional fields and leaves all other IDE state unchanged', async () => {
    const original = { ...cursor('old@test').entries, 'cursorAuth/stripeMembershipType': 'pro', 'workbench.layout': 'keep-layout', 'storage.serviceMachineId': 'keep-machine', 'history.workspace': 'keep-history' };
    const home = await fixture(original), adapter = new DesktopAccounts(undefined, async () => false);
    const snapshot = await adapter.snapshot('Cursor', home); expect(snapshot.entries).not.toHaveProperty('workbench.layout');
    const rollback = await adapter.apply(cursor('new@test'), home);
    expect(read(home, 'cursorAuth/cachedEmail')).toBe('new@test'); expect(read(home, 'cursorAuth/stripeMembershipType')).toBeUndefined();
    for (const key of ['workbench.layout', 'storage.serviceMachineId', 'history.workspace']) expect(read(home, key)).toBe(original[key as keyof typeof original]);
    await rollback(); for (const [key, value] of Object.entries(original)) expect(read(home, key)).toBe(value);
  });
  it('rejects a running app before any database or system credential write', async () => {
    const home = await fixture(cursor('old@test').entries), credential = vi.fn();
    const adapter = new DesktopAccounts(credential, async () => true);
    await expect(adapter.apply(cursor('new@test'), home)).rejects.toThrow('Close all Cursor windows');
    expect(credential).not.toHaveBeenCalled(); expect(read(home, 'cursorAuth/cachedEmail')).toBe('old@test');
  });
  it('switches Antigravity 2 vault credentials and rolls back both vault and sqlite on failure', async () => {
    const auth = (secret: string) => JSON.stringify({ token: { access_token: secret, refresh_token: `${secret}-refresh` }, auth_method: 'consumer' });
    let vault: string | undefined = auth('old-secret'), fail = true;
    const bridge = vi.fn(async (action: string, value?: string) => { if (action === 'read') return vault; if (action === 'write' && fail && value === auth('new-secret')) throw new Error('vault failure'); vault = action === 'write' ? value : undefined; return undefined; });
    const oldEntries = { 'antigravityAuthStatus': JSON.stringify({ email: 'old@example.test' }), 'antigravityUnifiedStateSync.oauthToken': 'old-protobuf', 'workbench.layout': 'keep-layout' };
    const home = await fixture(oldEntries), adapter = new DesktopAccounts(bridge, async () => false);
    const selected: DesktopSignIn = { version: 1, provider: 'Antigravity', entries: { 'antigravityAuthStatus': JSON.stringify({ email: 'new@example.test' }) }, credential: auth('new-secret') };
    await expect(adapter.apply(selected, home)).rejects.toThrow('vault failure'); expect(vault).toBe(auth('old-secret')); expect(read(home, 'antigravityUnifiedStateSync.oauthToken')).toBe('old-protobuf');
    fail = false; const rollback = await adapter.apply(selected, home); expect(vault).toBe(auth('new-secret')); expect(read(home, 'antigravityUnifiedStateSync.oauthToken')).toBeUndefined(); expect(read(home, 'workbench.layout')).toBe('keep-layout');
    expect((await adapter.status(selected)).account?.email).toBe('new@example.test'); await rollback(); expect(vault).toBe(auth('old-secret'));
  });
  it('saves and deduplicates desktop profiles without exposing credentials in the registry, and removes only saved auth', async () => {
    const home = await fixture(cursor('one@test').entries), adapter = new DesktopAccounts(undefined, async () => false), store = new AccountProfiles(path.join(home, 'accounts'), () => home, adapter);
    const first = await store.importCurrent('Cursor'), second = await store.importCurrent('Cursor'); expect(second.id).toBe(first.id); expect((await store.read()).profiles).toHaveLength(1);
    expect((await store.desktopStatus(first)).account?.email).toBe('one@test'); expect(await readFile(path.join(store.root, 'accounts.json'), 'utf8')).not.toContain('secret');
    const selected = await store.import('Cursor', JSON.stringify(cursor('two@test'))); const rollback = await store.apply(selected.id); expect(read(home, 'cursorAuth/cachedEmail')).toBe('two@test'); await rollback();
    await store.remove(first.id); await expect(access(path.join(store.home(first.id), 'sign-in.json'))).rejects.toThrow(); expect(read(home, 'cursorAuth/cachedEmail')).toBe('one@test');
  });
  it('allows only known auth fields and checks provider-specific sign-in payloads', () => {
    expect(() => validateDesktopSignIn({ ...cursor('one@test'), entries: { ...cursor('one@test').entries, 'storage.serviceMachineId': 'fake' } }, 'Cursor')).toThrow('Invalid desktop sign-in');
    expect(() => validateDesktopSignIn(cursor('one@test'), 'Antigravity')).toThrow('Import a saved Antigravity');
    expect(() => validateDesktopSignIn({ version: 1, provider: 'Antigravity', entries: {}, credential: '{"token":{}}' }, 'Antigravity')).toThrow('Invalid Antigravity');
    expect(() => validateDesktopSignIn({ version: 1, provider: 'Antigravity', entries: {} }, 'Antigravity')).toThrow('No Antigravity sign-in');
  });
});
