import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
let redeemed = false;
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line), mode = process.env.RESET_CASE;
  appendFileSync(process.env.RESET_RPC_LOG, line + '\n');
  let result;
  if (request.method === 'initialize') result = {};
  if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: 'account@example.test' }, workspaceRouting: { chatgptAccountId: mode === 'mismatch' ? 'other' : 'fixture-account' } };
  if (request.method === 'account/rateLimits/read') {
    if (redeemed && mode === 'refresh-error') { process.stdout.write(JSON.stringify({ id: request.id, error: { message: 'secret' } }) + '\n'); return; }
    result = { rateLimits: { primary: { usedPercent: redeemed ? 0 : 95, windowDurationMins: 300 } }, rateLimitResetCredits: { availableCount: mode === 'empty' ? 0 : redeemed ? 1 : 2 } };
  }
  if (request.method === 'account/rateLimitResetCredit/consume') {
    if (mode === 'timeout') return;
    if (mode === 'unsupported') { process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32601, message: 'secret' } }) + '\n'); return; }
    redeemed = true; result = { outcome: ['alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(mode) ? mode : 'reset' };
  }
  if (result) process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
});
