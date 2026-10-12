import { describe, expect, it } from 'vitest';
import { claudeUsage, codexUsage, codexHistoryUsage, claudeHistoryUsage } from '../src/providers/context-usage';

describe('native context usage', () => {
  it('uses the latest Codex response rather than cumulative totals and does not invent an expiry', () => {
    const usage = codexUsage({ last: { totalTokens: 42, cachedInputTokens: 30 }, total: { totalTokens: 90000 }, modelContextWindow: 100 }, 500);
    expect(usage).toEqual({ usedTokens: 42, cachedTokens: 30, windowTokens: 100, updatedAt: 500 });
    expect(usage).not.toHaveProperty('cacheExpiresAt'); expect(codexUsage({ last: { totalTokens: -1 } })).toBeUndefined();
  });
  it('reads context and cache hits from Codex rollouts, ignores missing usage and clears rolled-back usage', () => {
    const row = { type: 'event_msg', timestamp: '2026-10-08T10:00:00Z', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 4500, cached_input_tokens: 4000 }, total_token_usage: { total_tokens: 99000 }, model_context_window: 128000 } } };
    expect(codexHistoryUsage([row, { ...row, payload: { type: 'token_count', info: null } }])).toMatchObject({ usedTokens: 4500, cachedTokens: 4000, windowTokens: 128000, updatedAt: Date.parse(row.timestamp) });
    expect(codexHistoryUsage([row, { type: 'event_msg', payload: { type: 'thread_rolled_back' } }])).toBeUndefined();
  });
  it('counts Claude input/read/write/output once, estimates only reported TTL and refreshes on cache reads', () => {
    const usage = claudeUsage({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 100 } }, 'sonnet', 1000)!;
    expect(usage).toMatchObject({ usedTokens: 180, cachedTokens: 50, cacheTtlMs: 3600000, cacheExpiresAt: 3601000 });
    expect(claudeUsage({ input_tokens: 10, cache_read_input_tokens: 150 }, 'sonnet', 2000, usage)?.cacheExpiresAt).toBe(3602000);
    expect(claudeUsage({ input_tokens: 10, cache_read_input_tokens: 150 }, 'opus', 2000, usage)?.cacheExpiresAt).toBeUndefined();
    expect(claudeUsage({ input_tokens: 10, cache_creation_input_tokens: 100 }, 'sonnet', 2000)?.cacheExpiresAt).toBeUndefined();
    expect(claudeUsage({ input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 100 }, cache_creation_input_tokens: 105 }, 'sonnet', 2000)?.cacheTtlMs).toBe(300000);
  });
  it('never starts a new cache timer while reading old Claude history without timestamps', () => {
    const records = [{ type: 'assistant', message: { model: 'sonnet', usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 100 } } } }];
    expect(claudeHistoryUsage(records)).toMatchObject({ usedTokens: 110, cacheTtlMs: 300000 });
    expect(claudeHistoryUsage(records)?.cacheExpiresAt).toBeUndefined();
  });
});
