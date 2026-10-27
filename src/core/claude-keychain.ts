import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Claude Code on macOS keeps OAuth in the login Keychain; `.credentials.json` is only its fallback. */
export interface ClaudeKeychain {
  read(service: string): Promise<{ account: string; content: string } | undefined>;
  write(service: string, account: string, content: string): Promise<void>;
  remove(service: string, account: string): Promise<void>;
}
// Mirrors the CLI: the default config dir uses the bare name, any CLAUDE_CONFIG_DIR a hash suffix.
export const claudeKeychainService = (configDir?: string) => `Claude Code-credentials${configDir ? `-${createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}` : ''}`;
const NOT_FOUND = 44, TIMEOUT = 10_000, STDIN_LIMIT = 4000, CURRENT_ACCOUNT = 'claude-code-user';
function security(args: string[], input?: string) {
  return new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    const child = execFile('security', args, { encoding: 'utf8', timeout: TIMEOUT, windowsHide: true }, (error, stdout) => {
      if (error && typeof error.code !== 'number') return reject(error);
      resolve({ code: error ? error.code as number : 0, stdout });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}
// `security -w` prints non-printable secrets as hex.
const decode = (value: string) => { try { JSON.parse(value); return value; } catch { return /^(?:[0-9a-f]{2})+$/i.test(value) ? Buffer.from(value, 'hex').toString('utf8') : value; } };
export const macKeychain: ClaudeKeychain = {
  async read(service) {
    // Current CLIs read only `claude-code-user`; older ones used the login name, which may linger as a stale item.
    let item = await security(['find-generic-password', '-a', CURRENT_ACCOUNT, '-s', service]);
    if (item.code === NOT_FOUND) item = await security(['find-generic-password', '-s', service]);
    if (item.code === NOT_FOUND) return undefined;
    if (item.code !== 0) throw new Error(`Could not read the Claude sign-in from macOS Keychain (security exited ${item.code}).`);
    const account = /"acct"<blob>="((?:[^"\\]|\\.)*)"/.exec(item.stdout)?.[1];
    const secret = await security(['find-generic-password', ...(account ? ['-a', account] : []), '-s', service, '-w']);
    if (secret.code !== 0) throw new Error(`Could not read the Claude sign-in from macOS Keychain (security exited ${secret.code}).`);
    return { account: account || CURRENT_ACCOUNT, content: decode(secret.stdout.trim()) };
  },
  async write(service, account, content) {
    const hex = Buffer.from(content, 'utf8').toString('hex'), line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
    // Prefer stdin so tokens never appear in the process list.
    const { code } = line.length <= STDIN_LIMIT ? await security(['-i'], line) : await security(['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex]);
    if (code !== 0) throw new Error(`Could not update the Claude sign-in in macOS Keychain (security exited ${code}).`);
  },
  async remove(service, account) {
    const { code } = await security(['delete-generic-password', '-a', account, '-s', service]);
    if (code !== 0 && code !== NOT_FOUND) throw new Error(`Could not remove the Claude sign-in from macOS Keychain (security exited ${code}).`);
  },
};
