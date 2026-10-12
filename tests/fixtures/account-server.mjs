import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  appendFileSync(process.env.ACCOUNT_RPC_LOG, line + '\n');
  const mode = process.env.ACCOUNT_CASE;
  if (mode === 'hang') return;
  let result;
  if (message.method === 'initialize') result = {};
  if (message.method === 'account/read') result = { account: mode === 'signed-out' || (mode === 'refresh-sensitive' && message.params.refreshToken) ? null : mode === 'api' ? { type: 'apiKey' } : { type: 'chatgpt', email: 'account@example.test', planType: 'plus', accessToken: 'never-expose-this' }, workspaceRouting: { chatgptAccountId: 'workspace-fixture', backendOrigin: 'https://example.test', secret: 'never-expose-this' } };
  if (message.method === 'account/rateLimits/read') {
    if (mode === 'quota-exit') { process.exit(1); return; }
    if (mode === 'quota-error') { process.stdout.write(JSON.stringify({ id: message.id, error: { message: 'secret-token-from-provider' } }) + '\n'); return; }
    result = { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1791580550 }, secondary: { usedPercent: 50, windowDurationMins: 10080 } } };
  }
  if (message.method === 'account/usage/read') {
    if (mode === 'usage-error') { process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'secret-server-error' } }) + '\n'); return; }
    result = mode === 'usage-null' ? { summary: { lifetimeTokens: null }, dailyUsageBuckets: null } : { summary: { lifetimeTokens: 1000000, peakDailyTokens: 400000, currentStreakDays: 3 }, dailyUsageBuckets: [{ startDate: '2026-10-09', tokens: 200000 }], accessToken: 'never-expose-this' };
  }
  if (result) process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
});
