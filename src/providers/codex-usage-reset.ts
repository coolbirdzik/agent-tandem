import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { codexAccount, codexQuota, type AccountIdentity, type AccountQuota } from './account-status';
import { profileIdentityKey } from '../core/account-profiles';
import { terminateProcessTree } from './process';

export type ResetOutcome = 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit';
export interface CodexResetResult { outcome: ResetOutcome; account: AccountIdentity; quota: AccountQuota; updatedAt: number }
/** Redeem once, against the expected native sign-in; never infer new quota locally. */
export async function resetCodexUsage(project: string, executable: string, expected: AccountIdentity, idempotencyKey: string,
  launch: () => ChildProcessWithoutNullStreams = () => spawn(executable, ['app-server'], { cwd: project, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }), timeoutMs = 30000): Promise<CodexResetResult> {
  const expectedKey = profileIdentityKey('Codex', expected);
  if (!expectedKey || expected.method !== 'ChatGPT' || !idempotencyKey.trim()) throw new Error('Choose a signed-in Codex ChatGPT account before resetting usage.');
  const child = launch(), lines = createInterface({ input: child.stdout }); child.stderr.on('data', () => undefined);
  let next = 0, failure: Error | undefined;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const fail = (error: Error) => { failure = error; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on('error', () => fail(new Error('Could not start Codex usage reset.')));
  child.stdin.on('error', () => fail(new Error('Codex reset connection closed. Refresh quota before retrying.')));
  child.on('exit', () => fail(new Error('Codex closed before confirming the reset. Refresh quota before retrying.')));
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const item = pending.get(message.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.code === -32601 ? 'This Codex CLI does not support usage resets. Update the selected CLI.' : 'Codex could not confirm the reset. Refresh quota before retrying.'));
    else if (Object.hasOwn(message, 'result')) item.resolve(message.result);
    else item.reject(new Error('Invalid Codex reset response. Refresh quota before retrying.'));
  });
  const call = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex reset timed out. Refresh quota before retrying.')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await call('initialize', { clientInfo: { name: 'agent_tandem', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const identity = await call('account/read', { refreshToken: false }), account = codexAccount(identity?.account, identity?.workspaceRouting);
    if (profileIdentityKey('Codex', account) !== expectedKey) throw new Error('The Codex sign-in changed. Refresh accounts before resetting usage.');
    const quota = codexQuota(await call('account/rateLimits/read', {}));
    if (quota.bankedResets?.availableCount === 0) return { outcome: 'noCredit', account, quota, updatedAt: Date.now() };
    if (!quota.bankedResets) throw new Error('Codex did not report earned resets for this account. Refresh quota or update the selected CLI.');
    const result = await call('account/rateLimitResetCredit/consume', { idempotencyKey });
    if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(result?.outcome)) throw new Error('Unknown Codex reset result. Refresh quota before retrying.');
    let updated: AccountQuota;
    try { updated = codexQuota(await call('account/rateLimits/read', {})); }
    catch { updated = { status: 'error', windows: [], detail: 'Reset result received, but quota refresh failed. Refresh quota to see the new limits.' }; }
    return { outcome: result.outcome, account, quota: updated, updatedAt: Date.now() };
  } finally { fail(new Error('Reset transport closed.')); lines.close(); await terminateProcessTree(child); }
}
