import type { ConversationProvider } from '../providers/conversations';
import type { TokenTotals } from './usage-dashboard';
import { PRICING_RATES, type PricingRate } from './api-pricing-data';

export { PRICING_CHECKED_AT } from './api-pricing-data';
export const PRICING_SOURCES = {
  Codex: 'https://developers.openai.com/api/docs/pricing',
  Claude: 'https://platform.claude.com/docs/en/about-claude/pricing',
};
export interface ApiCost {
  usd: number; inputUsd: number; outputUsd: number; cacheReadUsd: number; cacheWriteUsd: number;
  pricedTokens: number; unpricedTokens: number;
}
export const emptyApiCost = (): ApiCost => ({ usd: 0, inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, pricedTokens: 0, unpricedTokens: 0 });
export function addApiCost(target: ApiCost, source: ApiCost) {
  for (const key of Object.keys(target) as Array<keyof ApiCost>) target[key] += source[key];
}
/** Rates live in a generated file; `npm run pricing:update` refreshes it from the published pricing pages. */
export function modelApiRate(provider: ConversationProvider, model: string): PricingRate | undefined {
  // Accept only exact IDs and dated snapshots; never price a new family by a loose prefix.
  const key = model.toLowerCase().replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '');
  const prices = PRICING_RATES[provider];
  return Object.hasOwn(prices, key) ? prices[key] : undefined;
}
export function apiCost(provider: ConversationProvider, model: string, usage: TokenTotals & { cacheWrite1h?: number }): ApiCost {
  const result = emptyApiCost(), prices = modelApiRate(provider, model);
  if (!prices) { result.unpricedTokens = usage.total; return result; }
  const read = Math.min(usage.input, usage.cacheRead), write = Math.min(usage.input - read, usage.cacheWrite);
  const oneHour = provider === 'Claude' ? Math.min(write, usage.cacheWrite1h ?? 0) : 0;
  const long = prices.longAfter !== undefined && usage.input > prices.longAfter;
  const inputMultiplier = long ? prices.longInput ?? 1 : 1, outputMultiplier = long ? prices.longOutput ?? 1 : 1;
  result.inputUsd = (usage.input - read - write) * prices.input * inputMultiplier / 1e6;
  result.cacheReadUsd = read * prices.read * inputMultiplier / 1e6;
  result.cacheWriteUsd = ((write - oneHour) * prices.write + oneHour * (prices.write1h ?? prices.input * 2)) * inputMultiplier / 1e6;
  // Reported reasoning tokens are already included in output.
  result.outputUsd = usage.output * prices.output * outputMultiplier / 1e6;
  result.usd = result.inputUsd + result.cacheReadUsd + result.cacheWriteUsd + result.outputUsd;
  result.pricedTokens = usage.total;
  return result;
}
