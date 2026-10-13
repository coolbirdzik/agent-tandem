import { access, readFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { DesktopAccountProvider } from './account-providers';
import type { AccountIdentity, ProviderAccountStatus } from '../providers/account-status';
import type { RollbackProgress } from './account-switch';

const execute = promisify(execFile);
const exists = async (file: string) => access(file).then(() => true, () => false);
export const desktopDatabase = (home: string) => path.join(home, 'User', 'globalStorage', 'state.vscdb');
const cursorKeys = ['cursorAuth/accessToken', 'cursorAuth/refreshToken', 'cursorAuth/cachedEmail', 'cursorAuth/authId', 'cursorAuth/stripeMembershipType', 'cursorAuth/stripeSubscriptionStatus', 'cursorAuth/cachedSignUpType', 'cursor.email'];
const antigravityKeys = ['antigravityUnifiedStateSync.oauthToken', 'antigravityUnifiedStateSync.userStatus', 'antigravityUnifiedStateSync.enterprisePreferences', 'antigravityAuthStatus', 'antigravityOnboarding'];
const keysFor = (provider: DesktopAccountProvider) => provider === 'Cursor' ? cursorKeys : antigravityKeys;
export interface DesktopSignIn { version: 1; provider: DesktopAccountProvider; entries: Record<string, string>; credential?: string; identity?: AccountIdentity }

export async function desktopHome(provider: DesktopAccountProvider): Promise<string> {
  const base = process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const names = provider === 'Cursor' ? ['Cursor'] : ['Antigravity IDE', 'Antigravity'];
  for (const name of names) if (await exists(desktopDatabase(path.join(base, name)))) return path.join(base, name);
  return path.join(base, names[0]!);
}
export function validateDesktopSignIn(value: unknown, provider: DesktopAccountProvider): DesktopSignIn {
  const data = value as DesktopSignIn;
  if (!data || data.version !== 1 || data.provider !== provider || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw new Error(`Import a saved ${provider} sign-in JSON.`);
  if (Object.entries(data.entries).some(([key, value]) => !keysFor(provider).includes(key) || typeof value !== 'string' || value.length > 1024 * 1024)) throw new Error('Invalid desktop sign-in fields.');
  if (data.credential !== undefined && (provider !== 'Antigravity' || typeof data.credential !== 'string')) throw new Error('Invalid desktop credential.');
  if (data.credential) {
    try { const token = JSON.parse(data.credential).token; if (typeof token?.refresh_token !== 'string' || !token.refresh_token || (token.access_token !== undefined && typeof token.access_token !== 'string')) throw new Error(); } catch { throw new Error('Invalid Antigravity system credential.'); }
  }
  if (provider === 'Cursor' ? !data.entries['cursorAuth/accessToken'] || !data.entries['cursorAuth/cachedEmail'] : !data.entries['antigravityUnifiedStateSync.oauthToken'] && !data.credential) throw new Error(`No ${provider} sign-in found. Sign in in the app first.`);
  return { version: 1, provider, entries: { ...data.entries }, ...(data.credential ? { credential: data.credential } : {}) };
}
/** Read length-delimited protobuf fields without depending on editor-specific schemas. */
function protobufFields(data: Buffer) {
  const result = new Map<number, Buffer[]>(); let offset = 0;
  const integer = () => { let value = 0; for (let shift = 0; shift <= 49 && offset < data.length; shift += 7) { const byte = data[offset++]!; value += (byte & 127) * 2 ** shift; if (!(byte & 128) && Number.isSafeInteger(value)) return value; } throw new Error(); };
  try {
    while (offset < data.length) {
      const tag = integer(), field = Math.floor(tag / 8), wire = tag % 8; if (!field) throw new Error();
      if (wire === 2) { const length = integer(); if (offset + length > data.length) throw new Error(); result.set(field, [...(result.get(field) || []), data.subarray(offset, offset + length)]); offset += length; }
      else if (wire === 0) integer(); else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4; else throw new Error();
      if (offset > data.length) throw new Error();
    }
  } catch { return new Map<number, Buffer[]>(); }
  return result;
}
function unifiedPayload(value: string | undefined, sentinel: string) {
  if (!value) return undefined;
  for (const entry of protobufFields(Buffer.from(value, 'base64')).get(1) || []) {
    const fields = protobufFields(entry); if (fields.get(1)?.[0]?.toString() !== sentinel) continue;
    const row = fields.get(2)?.[0], encoded = row && protobufFields(row).get(1)?.[0]?.toString();
    if (encoded && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return Buffer.from(encoded, 'base64');
  }
  return undefined;
}
function identityFrom(data: DesktopSignIn): AccountIdentity {
  let email = data.entries['cursorAuth/cachedEmail'];
  if (data.provider === 'Antigravity') {
    // Auth status/user status contain display metadata; never expose their raw payloads.
    for (const key of ['antigravityAuthStatus', 'antigravityUnifiedStateSync.userStatus']) {
      const value = data.entries[key]; if (!value) continue;
      const text = key.endsWith('userStatus') ? (unifiedPayload(value, 'userStatusSentinelKey') || Buffer.from(value, 'base64')).toString('utf8') : value;
      email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]; if (email) break;
    }
  }
  const oauth = unifiedPayload(data.entries['antigravityUnifiedStateSync.oauthToken'], 'oauthTokenInfoSentinelKey');
  const stable = data.entries['cursorAuth/authId'] || email?.toLowerCase() || (data.credential ? JSON.parse(data.credential).token.refresh_token : oauth && protobufFields(oauth).get(3)?.[0]?.toString()) || data.entries['cursorAuth/refreshToken'] || data.entries['antigravityUnifiedStateSync.oauthToken'] || data.entries['cursorAuth/accessToken'];
  return { signedIn: true, id: createHash('sha256').update(stable || '').digest('hex'), method: `${data.provider} account`, ...(email ? { email } : {}), ...(data.provider === 'Cursor' && data.entries['cursorAuth/stripeMembershipType'] ? { plan: data.entries['cursorAuth/stripeMembershipType'] } : {}) };
}
/** A narrow OS credential bridge: only Antigravity's named credential, secrets through stdin. */
export async function windowsAntigravityCredential(script: string, action: 'read' | 'write' | 'remove', value?: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); reject(new Error('Antigravity credential operation timed out.')); }, 15000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 2 * 1024 * 1024) { failed = true; child.kill(); } });
    child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error('Could not access Antigravity system sign-in.')); });
    child.once('close', code => { clearTimeout(timer); if (code || failed) { reject(new Error('Could not access Antigravity system sign-in.')); return; } try { resolve(JSON.parse(output).value ?? undefined); } catch { reject(new Error('Invalid system credential response.')); } });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ action, value }));
  });
}
export class DesktopAccounts {
  constructor(private credential?: (action: 'read' | 'write' | 'remove', value?: string) => Promise<string | undefined>, private running = desktopRunning) {}
  async snapshot(provider: DesktopAccountProvider, home: string, system = true): Promise<DesktopSignIn> {
    const entries: Record<string, string> = {}, file = desktopDatabase(home);
    if (await exists(file)) {
      const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(file, { readOnly: true });
      try { const query = db.prepare('SELECT value FROM ItemTable WHERE key = ?'); for (const key of keysFor(provider)) { const row = query.get(key); if (typeof row?.value === 'string') entries[key] = row.value; } } finally { db.close(); }
    }
    const credential = system && provider === 'Antigravity' ? await this.credential?.('read') : undefined;
    return validateDesktopSignIn({ version: 1, provider, entries, ...(credential ? { credential } : {}) }, provider);
  }
  async identity(data: DesktopSignIn): Promise<AccountIdentity> {
    const identity = identityFrom(data);
    if (!identity.email && data.credential) {
      // Antigravity 2 stores Google tokens in the OS vault, not in the editor DB.
      const token = JSON.parse(data.credential).token?.access_token;
      if (token) try { const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) }); if (response.ok) { const body = await response.json() as { email?: unknown }; if (typeof body.email === 'string') identity.email = body.email; } } catch { /* Saved auth can still be managed offline. */ }
    }
    return identity;
  }
  async status(data: DesktopSignIn): Promise<ProviderAccountStatus> { return { status: 'ready', account: await this.identity(data), updatedAt: Date.now(), quota: { status: 'unavailable', windows: [], detail: 'View quota in the app. Sign-in is read from native storage.' } }; }
  async apply(data: DesktopSignIn, home: string, onRollback?: RollbackProgress): Promise<() => Promise<void>> {
    validateDesktopSignIn(data, data.provider);
    if (await this.running(data.provider)) throw new Error(`Close all ${data.provider} windows before switching, then reopen the app.`);
    if (data.credential && !this.credential) throw new Error('Antigravity system credential switching is available on Windows.');
    const file = desktopDatabase(home); if (!await exists(file)) throw new Error(`Open ${data.provider} once before switching its default sign-in.`);
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(file);
    const old = new Map<string, string | undefined>();
    try { for (const key of keysFor(data.provider)) { const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key); old.set(key, row?.value as string | undefined); } } finally { db.close(); }
    const oldCredential = data.provider === 'Antigravity' ? await this.credential?.('read') : undefined;
    const write = (entries: Map<string, string | undefined>) => {
      const database = new DatabaseSync(file);
      try { database.exec('BEGIN IMMEDIATE'); for (const [key, value] of entries) { if (value === undefined) database.prepare('DELETE FROM ItemTable WHERE key = ?').run(key); else database.prepare('INSERT OR REPLACE INTO ItemTable (key,value) VALUES (?,?)').run(key, value); } database.exec('COMMIT'); }
      catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; } finally { database.close(); }
    };
    const rollback = async () => {
      onRollback?.('running');
      try { write(old); if (data.provider === 'Antigravity' && this.credential) await this.credential(oldCredential ? 'write' : 'remove', oldCredential); onRollback?.('success'); }
      catch (error) { onRollback?.('error'); throw error; }
    };
    try {
      write(new Map(keysFor(data.provider).map(key => [key, data.entries[key]])));
      if (data.provider === 'Antigravity' && this.credential) await this.credential(data.credential ? 'write' : 'remove', data.credential);
      const actual = await this.snapshot(data.provider, home);
      if (keysFor(data.provider).some(key => actual.entries[key] !== data.entries[key]) || actual.credential !== data.credential) throw new Error('Desktop sign-in verification failed.');
    } catch (error) { await rollback(); throw error; }
    return rollback;
  }
}
export async function desktopRunning(provider: DesktopAccountProvider): Promise<boolean> {
  if (process.platform === 'win32') {
    const result = await execute('tasklist.exe', ['/FI', `IMAGENAME eq ${provider}.exe`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000 });
    return result.stdout.toLowerCase().includes(`"${provider.toLowerCase()}.exe"`);
  }
  const result = await execute('ps', ['-A', '-o', 'comm='], { timeout: 8000 });
  return result.stdout.split('\n').some(line => {
    const command = line.trim().toLowerCase(), name = path.basename(command);
    return name === provider.toLowerCase() || name === `${provider.toLowerCase()}-bin` || command.includes(`/${provider.toLowerCase()}.app/contents/`);
  });
}
export async function desktopExecutable(provider: DesktopAccountProvider): Promise<string | undefined> {
  const candidates = process.platform === 'win32' ? [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', provider === 'Cursor' ? 'cursor' : 'Antigravity', `${provider}.exe`),
    path.join(process.env.ProgramFiles || '', provider, `${provider}.exe`),
    ...(process.env.PATH || '').split(path.delimiter).map(folder => path.join(folder, `${provider}.exe`)),
  ] : process.platform === 'darwin' ? [`/Applications/${provider}.app/Contents/MacOS/Electron`] : (process.env.PATH || '').split(path.delimiter).map(folder => path.join(folder, provider.toLowerCase()));
  for (const file of candidates) if (path.isAbsolute(file) && await exists(file)) return file;
  return undefined;
}
export async function readDesktopSignIn(file: string, provider: DesktopAccountProvider) {
  const content = await readFile(file, 'utf8'); if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('Account file is too large.');
  let value: unknown; try { value = JSON.parse(content); } catch { throw new Error('Invalid desktop sign-in JSON.'); }
  return validateDesktopSignIn(value, provider);
}
