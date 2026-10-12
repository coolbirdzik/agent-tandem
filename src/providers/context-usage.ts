/** Usage of the latest main-thread response, never lifetime/cumulative totals. */
export interface ContextUsage {
  usedTokens?: number;
  windowTokens?: number;
  cachedTokens?: number;
  model?: string;
  selectedModel?: string;
  updatedAt?: number;
  cacheTtlMs?: number;
  cacheExpiresAt?: number;
}
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const object = (value: any): Record<string, any> => value && typeof value === 'object' ? value : {};
export function codexUsage(value: unknown, updatedAt?: number): ContextUsage | undefined {
  const usage = object(value), last = object(usage.last ?? usage.last_token_usage);
  const usedTokens = count(last.totalTokens ?? last.total_tokens), windowTokens = count(usage.modelContextWindow ?? usage.model_context_window);
  if (usedTokens === undefined) return;
  return { usedTokens, ...(windowTokens ? { windowTokens } : {}), cachedTokens: count(last.cachedInputTokens ?? last.cached_input_tokens), updatedAt };
}
export function claudeUsage(value: unknown, model?: string, updatedAt?: number, previous?: ContextUsage): ContextUsage | undefined {
  const usage = object(value), input = count(usage.input_tokens);
  if (input === undefined) return;
  const cachedTokens = count(usage.cache_read_input_tokens), written = count(usage.cache_creation_input_tokens);
  const created = object(usage.cache_creation);
  // Only TTLs actually reported in cache-write usage can start an estimate.
  // With mixed TTLs, display the shortest reported lifetime.
  const reportedTtl = count(created.ephemeral_5m_input_tokens) ? 300_000 : count(created.ephemeral_1h_input_tokens) ? 3_600_000 : undefined;
  const compatible = !previous?.model || !model || previous.model === model;
  const cacheTtlMs = reportedTtl ?? (cachedTokens && compatible ? previous?.cacheTtlMs : undefined);
  const cacheExpiresAt = cacheTtlMs && updatedAt !== undefined && (cachedTokens || written) ? updatedAt + cacheTtlMs : undefined;
  return {
    usedTokens: input + (cachedTokens ?? 0) + (written ?? 0) + (count(usage.output_tokens) ?? 0),
    ...(compatible && previous?.windowTokens ? { windowTokens: previous.windowTokens } : {}),
    cachedTokens, model, updatedAt, cacheTtlMs, cacheExpiresAt,
  };
}
export function codexHistoryUsage(records: unknown[]): ContextUsage | undefined {
  let usage: ContextUsage | undefined;
  for (const raw of records) {
    const row = object(raw), payload = object(row.payload);
    if (row.type === 'event_msg' && payload.type === 'token_count') {
      const timestamp = Date.parse(row.timestamp);
      usage = codexUsage(payload.info, Number.isFinite(timestamp) ? timestamp : undefined) ?? usage;
    }
    // Rollback removes turns whose usage must not survive as current context.
    if (row.type === 'event_msg' && payload.type === 'thread_rolled_back') usage = undefined;
  }
  return usage;
}
export function claudeHistoryUsage(records: Array<{ type: string; message: unknown; timestamp?: string }>): ContextUsage | undefined {
  let usage: ContextUsage | undefined;
  for (const row of records) {
    const message = object(row.message);
    if (row.type !== 'assistant') continue;
    const timestamp = Date.parse(row.timestamp ?? '');
    usage = claudeUsage(message.usage, message.model, Number.isFinite(timestamp) ? timestamp : undefined, usage) ?? usage;
  }
  return usage;
}
