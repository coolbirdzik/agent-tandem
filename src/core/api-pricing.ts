import type { ConversationProvider } from '../providers/conversations';
import type { TokenTotals } from './usage-dashboard';

export const PRICING_CHECKED_AT = '2026-10-10';
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
interface Rate { input: number; read: number; write: number; output: number; longAfter?: number; longInput?: number; longOutput?: number }
const rate = (input: number, read: number, output: number, write = input, longAfter?: number, longInput = 2, longOutput = 1.5): Rate => ({ input, read, output, write, longAfter, longInput, longOutput });
/** USD per million tokens. Standard global API rates, not subscription prices. */
const codex: Record<string, Rate> = {
  'gpt-6-astra': rate(10, 1, 50, 12.5, 272000),
  'gpt-6.1-sol': rate(2, .1, 10, 2.5, 272000),
  'gpt-6-sol': rate(2, .2, 10, 2.5, 272000),
  'gpt-6-luna': rate(.1, .01, .5, .125, 272000),
  'gpt-5.6-sol': rate(4, .4, 20, 5, 272000),
  'gpt-5.6-terra': rate(2, .2, 12, 2.5, 272000),
  'gpt-5.6-luna': rate(.2, .02, 1.2, .25, 272000),
  'gpt-5.5': rate(5, .5, 30, 5, 272000),
  'gpt-5.4': rate(2.5, .25, 15, 2.5, 272000),
  'gpt-5.4-mini': rate(.75, .075, 4.5),
  'gpt-5.3-codex': rate(1.75, .175, 14),
  'gpt-5.2-codex': rate(1.75, .175, 14),
  'gpt-5.2': rate(1.75, .175, 14),
  'gpt-5.1': rate(1.25, .125, 10),
  'gpt-5.1-codex': rate(1.25, .125, 10),
  'gpt-5.1-codex-max': rate(1.25, .125, 10),
  'gpt-5.1-codex-mini': rate(.25, .025, 2),
  'gpt-5': rate(1.25, .125, 10),
  'gpt-5-codex': rate(1.25, .125, 10),
};
const claude: Record<string, Rate> = {
  'claude-fable-5-1': rate(10, .25, 50, 12.5),
  'claude-mythos-5-1': rate(10, .25, 50, 12.5),
  'claude-fable-5': rate(10, 1, 50, 12.5),
  'claude-mythos-5': rate(10, 1, 50, 12.5),
  'claude-opus-5-5': rate(4, .2, 20, 5),
  'claude-sonnet-5-5': rate(2, .1, 10, 2.5),
  'claude-haiku-5-5': rate(.1, .01, .5, .125, 100000, 5, 5),
  'claude-opus-5': rate(5, .5, 25, 6.25),
  'claude-opus-4-8': rate(5, .5, 25, 6.25),
  'claude-opus-4-7': rate(5, .5, 25, 6.25),
  'claude-opus-4-6': rate(5, .5, 25, 6.25),
  'claude-opus-4-5': rate(5, .5, 25, 6.25),
  'claude-opus-4-1': rate(15, 1.5, 75, 18.75),
  'claude-opus-4': rate(15, 1.5, 75, 18.75),
  'claude-sonnet-5': rate(2, .2, 10, 2.5),
  'claude-sonnet-4-6': rate(3, .3, 15, 3.75),
  'claude-sonnet-4-5': rate(3, .3, 15, 3.75),
  'claude-sonnet-4': rate(3, .3, 15, 3.75),
  'claude-haiku-4-5': rate(1, .1, 5, 1.25),
  'claude-3-5-haiku': rate(.8, .08, 4, 1),
};
export function modelApiRate(provider: ConversationProvider, model: string): Rate | undefined {
  // Accept only exact IDs and dated snapshots; never price a new family by a loose prefix.
  const key = model.toLowerCase().replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '');
  const prices = provider === 'Codex' ? codex : claude;
  return Object.hasOwn(prices, key) ? prices[key] : undefined;
}
export function apiCost(provider: ConversationProvider, model: string, usage: TokenTotals & { cacheWrite1h?: number }): ApiCost {
  const result = emptyApiCost(), prices = modelApiRate(provider, model);
  if (!prices) { result.unpricedTokens = usage.total; return result; }
  const read = Math.min(usage.input, usage.cacheRead), write = Math.min(usage.input - read, usage.cacheWrite);
  const oneHour = provider === 'Claude' ? Math.min(write, usage.cacheWrite1h ?? 0) : 0;
  const long = prices.longAfter !== undefined && usage.input > prices.longAfter;
  const inputMultiplier = long ? prices.longInput! : 1, outputMultiplier = long ? prices.longOutput! : 1;
  result.inputUsd = (usage.input - read - write) * prices.input * inputMultiplier / 1e6;
  result.cacheReadUsd = read * prices.read * inputMultiplier / 1e6;
  result.cacheWriteUsd = ((write - oneHour) * prices.write + oneHour * prices.input * 2) * inputMultiplier / 1e6;
  // Reported reasoning tokens are already included in output.
  result.outputUsd = usage.output * prices.output * outputMultiplier / 1e6;
  result.usd = result.inputUsd + result.cacheReadUsd + result.cacheWriteUsd + result.outputUsd;
  result.pricedTokens = usage.total;
  return result;
}
