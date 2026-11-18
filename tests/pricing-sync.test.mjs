import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { bundleLongContextRows, claudeModelId, mergePricing, parseClaudePricing, parseOpenAiPricing, readDataFile, renderDataFile, PricingParseError } from '../scripts/pricing-sync.mjs';

// Shapes copied from the live pages: Astro island props are [type, value] encoded and HTML-escaped.
const encode = value => Array.isArray(value) ? [1, value.map(encode)] : value && typeof value === 'object' ? [0, Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]))] : [0, value];
const island = (props, url = '/_astro/pricing.abc.js') =>
  `<astro-island uid="x" component-url="${url}" component-export="TextTokenPricingTables" props="${JSON.stringify(Object.fromEntries(Object.entries(props).map(([k, v]) => [k, encode(v)]))).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"></astro-island>`;
const openAiHtml = island({ tier: 'batch', rows: [['gpt-6.2-sol', 1, .05, 1.25, 5]] }) + island({ tier: 'standard', rows: [
  ['gpt-6.2-sol', 2, .1, 2.5, 10],
  ['gpt-5.5 (<272K context length)', 5, .5, '-', 30],
  ['gpt-5.5-pro (<272K context length)', 30, '-', '-', 180],
  ['gpt-5.4-mini', .75, .075, 4.5],
  [{ label: 'gpt-5', deprecated: true }, 1.25, .125, 10],
] });
const bundle = 'x={batch:{"gpt-6.2-sol":{input:2}},standard:{"gpt-6.2-sol":{input:4,cachedInput:.2,cacheWrite:5,output:15},"gpt-5.5":{input:10,output:45,cachedInput:1,cacheWrite:`-`},"gpt-5.5-pro":{input:60,output:270,cachedInput:`-`,cacheWrite:`-`},"gpt-5.4-mini":{input:`-`,output:`-`,cachedInput:`-`,cacheWrite:`-`}},fast:{}}';
const claudeHtml = `<table><thead><tr><th>Model</th><th>Base tokens</th><th>Prompt caching</th></tr>
<tr><th>Name</th><th>Input</th><th>Output</th><th>5m writes</th><th>1h writes</th><th>Hits and refreshes</th></tr></thead><tbody>
<tr><td><b>Claude Fable 5.2</b> <span>For demanding work</span></td><td>$8 / MTok</td><td>$40 / MTok</td><td>$10 / MTok</td><td>$16 / MTok</td><td>$0.20 / MTok</td></tr>
<tr><td rowspan="2">Claude Haiku 5.5</td><td>$0.10 / MTok for prompts up to 100,000 tokens</td><td>$0.50 / MTok</td><td>$0.125 / MTok</td><td>$0.20 / MTok</td><td>$0.01 / MTok</td></tr>
<tr><td>$0.50 / MTok for prompts over 100,000 tokens</td><td>$2.50 / MTok</td><td>$0.625 / MTok</td><td>$1 / MTok</td><td>$0.05 / MTok</td></tr>
<tr><td colspan="6">Additional models</td></tr>
<tr><td>Claude Opus 4.5</td><td>$5 / MTok</td><td>$25 / MTok</td><td>$6.25 / MTok</td><td>$10 / MTok</td><td>$0.50 / MTok</td></tr>
</tbody></table><table><tr><th>Model</th><th>Input</th><th>Output</th></tr><tr><td>Claude Fable 5.2</td><td>$16 USD / MTok</td><td>$80 USD / MTok</td></tr></table>`;

describe('pricing page sync', () => {
  it('reads OpenAI standard rows, both row shapes and long-context multipliers from the bundle', () => {
    const rates = parseOpenAiPricing(openAiHtml, bundle);
    expect(rates['gpt-6.2-sol']).toEqual({ input: 2, read: .1, write: 2.5, output: 10, longAfter: 272000, longInput: 2, longOutput: 1.5 });
    expect(rates['gpt-5.5']).toEqual({ input: 5, read: .5, write: 5, output: 30, longAfter: 272000, longInput: 2, longOutput: 1.5 });
    expect(rates['gpt-5.5-pro']).toMatchObject({ input: 30, read: 30, output: 180, longInput: 2, longOutput: 1.5 });
    expect(rates['gpt-5.4-mini']).toEqual({ input: .75, read: .075, write: .75, output: 4.5 });
    expect(rates['gpt-5']).toEqual({ input: 1.25, read: .125, write: 1.25, output: 10 });
  });
  it('rejects long-context rows whose input-side prices do not scale together', () => {
    const skewed = bundle.replace('cachedInput:.2,', 'cachedInput:.3,');
    expect(() => parseOpenAiPricing(openAiHtml, skewed)).toThrow(PricingParseError);
    expect(() => parseOpenAiPricing('<html></html>', bundle)).toThrow(/standard text-token pricing table/);
    expect(bundleLongContextRows('nothing here')).toBeUndefined();
  });
  it('reads the Claude model table, names and the prompt-length continuation row only', () => {
    const rates = parseClaudePricing(claudeHtml);
    expect(Object.keys(rates)).toEqual(['claude-fable-5-2', 'claude-haiku-5-5', 'claude-opus-4-5']);
    expect(rates['claude-fable-5-2']).toEqual({ input: 8, read: .2, write: 10, output: 40, write1h: 16 });
    expect(rates['claude-haiku-5-5']).toEqual({ input: .1, read: .01, write: .125, output: .5, write1h: .2, longAfter: 100000, longInput: 5, longOutput: 5 });
    expect(claudeModelId('Claude Opus 5 / Claude Opus 4.8')).toBe('claude-opus-5');
    expect(() => parseClaudePricing('<table><tr><td>Claude</td></tr></table>')).toThrow(/model pricing table/);
  });
  it('adds and updates published models, keeps unlisted ones and fails when anchors vanish', () => {
    const published = {
      Codex: { 'gpt-6.1-sol': { input: 2, read: .1, write: 2.5, output: 10 }, 'gpt-5.5': { input: 5, read: .5, write: 5, output: 30 }, 'gpt-6.2-sol': { input: 2, read: .1, write: 2.5, output: 10 } },
      Claude: { 'claude-opus-5-5': { input: 4, read: .2, write: 5, output: 20, write1h: 8 }, 'claude-sonnet-4-6': { input: 3, read: .3, write: 3.75, output: 15, write1h: 6 }, 'claude-haiku-4-5': { input: 1, read: .1, write: 1.25, output: 5, write1h: 2 } },
    };
    const current = { Codex: { 'gpt-6.1-sol': published.Codex['gpt-6.1-sol'], 'gpt-5.5': { ...published.Codex['gpt-5.5'], output: 25 }, 'gpt-5-codex': { input: 1.25, read: .125, write: 1.25, output: 10 } }, Claude: published.Claude };
    const result = mergePricing(current, published);
    expect(result.changed).toBe(true);
    expect(result.changes.map(({ provider, model, kind }) => `${provider}:${model}:${kind}`)).toEqual(['Codex:gpt-5.5:changed', 'Codex:gpt-6.2-sol:added', 'Codex:gpt-5-codex:unlisted']);
    expect(result.rates.Codex['gpt-5-codex']).toEqual(current.Codex['gpt-5-codex']);
    expect(mergePricing(result.rates, published).changed).toBe(false);
    expect(() => mergePricing(current, { ...published, Claude: {} })).toThrow(/Claude: the page yielded 0 models/);
    expect(() => mergePricing(current, { ...published, Codex: { a: published.Codex['gpt-6.2-sol'], b: published.Codex['gpt-6.2-sol'], c: published.Codex['gpt-6.2-sol'] } })).toThrow(/0 already known/);
  });
  it('round-trips the generated data file', async () => {
    const source = await readFile(new URL('../src/core/api-pricing-data.ts', import.meta.url), 'utf8');
    const data = readDataFile(source);
    expect(data.rates.Codex['gpt-6.2-astra']).toMatchObject({ input: 8, read: .4, write: 10, output: 40, longAfter: 272000 });
    expect(renderDataFile(data).replace(/\r\n/g, '\n')).toBe(source.replace(/\r\n/g, '\n'));
  });
});
