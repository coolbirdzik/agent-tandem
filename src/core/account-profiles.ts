import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { isAccountProvider, isChatAccount, type AccountProvider } from './account-providers';
import { DesktopAccounts, desktopHome, validateDesktopSignIn, readDesktopSignIn } from './desktop-accounts';
import type { AccountIdentity } from '../providers/account-status';
import { usageAccount } from './usage-account';
import { withStorageLock } from './storage-lock';
import type { RollbackProgress } from './account-switch';

export interface AccountProfile { id: string; provider: AccountProvider; label: string; identity?: AccountIdentity; createdAt: number }
export interface ProfileRegistry { version: 1; profiles: AccountProfile[] }
export function nativeHome(provider: 'Codex' | 'Claude'): string;
export function nativeHome(provider: AccountProvider): string | Promise<string>;
export function nativeHome(provider: AccountProvider) { return !isChatAccount(provider) ? desktopHome(provider) : provider === 'Codex' ? process.env.CODEX_HOME || path.join(os.homedir(), '.codex') : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }
export const profileIdentityKey = (provider: AccountProvider, identity?: AccountIdentity) => isChatAccount(provider) ? usageAccount(provider, identity)?.id : identity?.signedIn && (identity.id || identity.email) ? `${provider}:${identity.id || identity.email!.trim().toLowerCase()}` : undefined;
const validId = (id: string) => /^[a-f0-9-]{36}$/i.test(id);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function optional(file: string) { try { return await readFile(file, 'utf8'); } catch (error) { if (missing(error)) return undefined; throw error; } }
async function atomic(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(() => undefined); }
}
function json(content: string) {
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('Account file is too large.');
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error('Invalid native account JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid account file.');
  return value as Record<string, unknown>;
}
const authFile = (provider: AccountProvider) => !isChatAccount(provider) ? 'sign-in.json' : provider === 'Codex' ? 'auth.json' : '.credentials.json';
const claudeMetadata = (home: string) => path.resolve(home) === path.resolve(path.join(os.homedir(), '.claude')) && !process.env.CLAUDE_CONFIG_DIR ? path.join(os.homedir(), '.claude.json') : path.join(home, '.claude.json');
/** Only native auth files live in private profile homes. The registry/webview never contains tokens. */
export class AccountProfiles {
  constructor(readonly root: string, private defaults: (provider: AccountProvider) => string | Promise<string> = nativeHome, readonly desktop = new DesktopAccounts()) {}
  home(id: string) { if (!validId(id)) throw new Error('Invalid account profile.'); return path.join(this.root, 'profiles', id); }
  environment(profile: AccountProfile): NodeJS.ProcessEnv {
    if (!isChatAccount(profile.provider)) throw new Error('Desktop accounts use the native app sign-in.');
    const env = { ...process.env, [profile.provider === 'Codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: this.home(profile.id) };
    // Environment credentials must not silently override the selected native sign-in.
    for (const key of profile.provider === 'Codex' ? ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'] : ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']) env[key] = undefined;
    return env;
  }
  async read(): Promise<ProfileRegistry> {
    const content = await optional(path.join(this.root, 'accounts.json'));
    if (!content) return { version: 1, profiles: [] };
    const value = json(content);
    if (value.version !== 1 || !Array.isArray(value.profiles)) throw new Error('Account registry is unreadable.');
    return { version: 1, profiles: value.profiles.map((row: any) => {
      if (!row || !validId(row.id) || !isAccountProvider(row.provider) || typeof row.label !== 'string' || !Number.isFinite(row.createdAt)) throw new Error('Invalid account registry.');
      const a = row.identity;
      return { id: row.id, provider: row.provider, label: row.label, createdAt: row.createdAt,
        ...(a && typeof a.method === 'string' ? { identity: { signedIn: a.signedIn === true, method: a.method, ...Object.fromEntries(['id', 'email', 'plan', 'organization'].filter(k => typeof a[k] === 'string').map(k => [k, a[k]])) } } : {}) };
    }) };
  }
  private save(value: ProfileRegistry) { return atomic(path.join(this.root, 'accounts.json'), JSON.stringify(value)); }
  async get(id: string) { const profile = (await this.read()).profiles.find(row => row.id === id); if (!profile) throw new Error('Account no longer exists.'); return profile; }
  async create(provider: AccountProvider, label = 'New account'): Promise<AccountProfile> {
    if (!isAccountProvider(provider)) throw new Error('Invalid provider.');
    return withStorageLock(this.root, async () => {
      const data = await this.read(), profile: AccountProfile = { id: randomUUID(), provider, label: label.slice(0, 120), createdAt: Date.now() };
      await mkdir(this.home(profile.id), { recursive: true, mode: 0o700 });
      if (provider === 'Codex') await atomic(path.join(this.home(profile.id), 'config.toml'), 'cli_auth_credentials_store = "file"\n');
      data.profiles.push(profile); await this.save(data); return profile;
    });
  }
  async identify(id: string, identity: AccountIdentity) {
    return withStorageLock(this.root, async () => {
      const data = await this.read(), profile = data.profiles.find(row => row.id === id);
      if (!profile) throw new Error('Account no longer exists.');
      profile.identity = { signedIn: identity.signedIn, method: identity.method, ...Object.fromEntries(['id', 'email', 'plan', 'organization'].filter(k => typeof identity[k as keyof AccountIdentity] === 'string').map(k => [k, identity[k as keyof AccountIdentity]])) };
      if (profile.label === 'New account') profile.label = identity.email || identity.method;
      await this.save(data);
    });
  }
  async importCurrent(provider: AccountProvider, identity?: AccountIdentity) {
    const home = await this.defaults(provider);
    if (!isChatAccount(provider)) {
      const snapshot = await this.desktop.snapshot(provider, home);
      return this.import(provider, JSON.stringify(snapshot), identity || await this.desktop.identity(snapshot));
    }
    const content = await optional(path.join(home, authFile(provider)));
    if (!content) throw new Error('No native sign-in file found. Use Add account to sign in.');
    return this.import(provider, content, identity, provider === 'Claude' ? await optional(claudeMetadata(home)) : undefined);
  }
  async import(provider: AccountProvider, content: string, identity?: AccountIdentity, metadata?: string) {
    if (!isAccountProvider(provider)) throw new Error('Invalid provider.');
    const auth = isChatAccount(provider) ? json(content) : validateDesktopSignIn(json(content), provider);
    if (isChatAccount(provider) && (provider === 'Codex' ? !(auth as Record<string, unknown>).tokens && !(auth as Record<string, unknown>).OPENAI_API_KEY : !(auth as Record<string, unknown>).claudeAiOauth)) throw new Error('Use the native CLI account JSON file.');
    if (!isChatAccount(provider)) identity = await this.desktop.identity(auth as import('./desktop-accounts').DesktopSignIn);
    const identityKey = profileIdentityKey(provider, identity);
    const existing = identityKey && (await this.read()).profiles.find(row => row.provider === provider && profileIdentityKey(provider, row.identity) === identityKey);
    const profile = existing || await this.create(provider, identity?.email || 'New account');
    await withStorageLock(this.home(profile.id), async () => {
      await atomic(path.join(this.home(profile.id), authFile(provider)), JSON.stringify(auth));
      if (metadata && provider === 'Claude') {
        const value = json(metadata), clean = Object.fromEntries(['oauthAccount', 'hasCompletedOnboarding'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
        await atomic(path.join(this.home(profile.id), '.claude.json'), JSON.stringify(clean));
      }
    });
    if (identity) await this.identify(profile.id, identity);
    return profile;
  }
  /** Reversible native switch; rollback is retained until the CLI verifies the new sign-in. */
  async apply(id: string, onRollback?: RollbackProgress): Promise<() => Promise<void>> {
    const profile = await this.get(id), home = await this.defaults(profile.provider);
    if (!isChatAccount(profile.provider)) return this.desktop.apply(await readDesktopSignIn(path.join(this.home(id), 'sign-in.json'), profile.provider), home, onRollback);
    const content = await optional(path.join(this.home(id), authFile(profile.provider)));
    if (!content) throw new Error('Finish signing in before switching.');
    json(content);
    const writes = new Map<string, string>([[path.join(home, authFile(profile.provider)), content]]);
    if (profile.provider === 'Claude') {
      const file = claudeMetadata(home), current = json(await optional(file) || '{}');
      const meta = json(await optional(path.join(this.home(id), '.claude.json')) || '{}');
      delete current.oauthAccount;
      Object.assign(current, meta); writes.set(file, JSON.stringify(current));
    } else {
      const file = path.join(home, 'config.toml'), current = await optional(file) || '';
      writes.set(file, 'cli_auth_credentials_store = "file"\n' + current.replace(/^cli_auth_credentials_store\s*=.*(?:\r?\n|$)/gm, ''));
    }
    const backups = new Map<string, string | undefined>();
    for (const file of writes.keys()) backups.set(file, await optional(file));
    const rollback = async () => {
      onRollback?.('running');
      try { for (const [file, old] of backups) { if (old === undefined) await unlink(file).catch(error => { if (!missing(error)) throw error; }); else await atomic(file, old); } onRollback?.('success'); }
      catch (error) { onRollback?.('error'); throw error; }
    };
    try { for (const [file, value] of writes) await atomic(file, value); } catch (error) { await rollback(); throw error; }
    return rollback;
  }
  async rename(id: string, label: string) {
    if (!label.trim() || label.length > 120) throw new Error('Enter an account name under 120 characters.');
    await withStorageLock(this.root, async () => { const data = await this.read(), row = data.profiles.find(p => p.id === id); if (!row) throw new Error('Account no longer exists.'); row.label = label.trim(); await this.save(data); });
  }
  async remove(id: string) {
    await withStorageLock(this.root, async () => {
      const profile = await this.get(id);
      for (const file of [authFile(profile.provider), '.claude.json']) await unlink(path.join(this.home(id), file)).catch(error => { if (!missing(error)) throw error; });
      const data = await this.read(); data.profiles = data.profiles.filter(row => row.id !== id); await this.save(data);
    });
  }
  async desktopStatus(profile: AccountProfile | 'Cursor' | 'Antigravity') {
    const provider = typeof profile === 'string' ? profile : profile.provider;
    if (isChatAccount(provider)) throw new Error('Choose a desktop provider.');
    const snapshot = typeof profile === 'string' ? await this.desktop.snapshot(provider, await this.defaults(provider)) : await readDesktopSignIn(path.join(this.home(profile.id), 'sign-in.json'), provider);
    return this.desktop.status(snapshot);
  }
  async importFile(provider: AccountProvider, file: string) {
    if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('Account file is too large.');
    return this.import(provider, await readFile(file, 'utf8'), undefined, provider === 'Claude' ? await optional(path.join(path.dirname(file), '.claude.json')) : undefined);
  }
}
