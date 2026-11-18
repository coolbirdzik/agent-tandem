// Syncs src/core/api-pricing-data.ts with the published OpenAI and Claude API pricing pages.
//   node scripts/pricing-sync.mjs            print what differs, change nothing
//   node scripts/pricing-sync.mjs --check    same, but exit 1 when the published prices differ
//   node scripts/pricing-sync.mjs --write    rewrite the data file (models the pages no longer list are kept)
//   --summary <file>                         also write a Markdown summary (used as the pull request body)
// A page whose structure changed exits 2 instead of reporting "no changes".
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCES = {
  Codex: 'https://developers.openai.com/api/docs/pricing',
  Claude: 'https://platform.claude.com/docs/en/about-claude/pricing',
};
/** A page must yield at least this many models, some already known; otherwise the parser no longer understands it. */
const MIN_MODELS = 3;
const DATA_FILE = fileURLToPath(new URL('../src/core/api-pricing-data.ts', import.meta.url));
const FIELDS = ['input', 'read', 'write', 'output', 'write1h', 'longAfter', 'longInput', 'longOutput'];

export class PricingParseError extends Error {}
const fail = message => { throw new PricingParseError(message); };

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeEntities = text => text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (match, code) =>
  code[0] === '#' ? String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : entities[code.toLowerCase()] ?? match);
const cleanText = html => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const round = value => Math.round(value * 1e9) / 1e9;
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Astro island props encode every value as [type, value]: 0 = plain (objects hold encoded values), 1 = array. */
export function astroValue(value) {
  if (!Array.isArray(value)) return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, astroValue(item)])) : value;
  const [type, inner] = value;
  if (type === 1) return inner.map(astroValue);
  if (type === 0) return inner && typeof inner === 'object' && !Array.isArray(inner) ? astroValue(inner) : inner;
  return inner;
}
export function astroIslands(html, component) {
  const islands = [];
  for (const [tag] of html.matchAll(/<astro-island\b[^>]*>/g)) {
    if (!tag.includes(`component-export="${component}"`)) continue;
    const props = /\sprops="([^"]*)"/.exec(tag), url = /\scomponent-url="([^"]*)"/.exec(tag);
    if (!props) continue;
    islands.push({ props: astroValue(JSON.parse(decodeEntities(props[1]))), componentUrl: url ? decodeEntities(url[1]) : undefined });
  }
  return islands;
}

/** Reads `<tier>:{"model":{input:…},…}` from the pricing component bundle, where long-context rows live. */
export function bundleLongContextRows(source, tier = 'standard') {
  const start = source.search(new RegExp(`\\b${tier}:\\{"gpt-`));
  if (start < 0) return undefined;
  let depth = 0, end = source.indexOf('{', start);
  for (let index = end; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) { end = index + 1; break; }
  }
  const literal = source.slice(source.indexOf('{', start), end)
    .replace(/`([^`]*)`/g, (_, text) => JSON.stringify(text))
    .replace(/([{,])([A-Za-z_$][\w$]*):/g, '$1"$2":')
    .replace(/([:,[])(-?)\.(\d)/g, '$1$20.$3');
  try { return JSON.parse(literal); } catch { fail(`OpenAI: cannot read the ${tier} long-context rows from the pricing bundle.`); }
}

/** Multipliers for prices above the long-context threshold; every input-side price must scale alike. */
function longMultipliers(model, short, long) {
  const pairs = [['input', 'input'], ['read', 'cachedInput'], ['write', 'cacheWrite']]
    .map(([ours, theirs]) => [num(short[ours]), num(long[theirs])]).filter(([a, b]) => a !== undefined && b !== undefined && a > 0);
  const output = num(long.output);
  if (!pairs.length || output === undefined) return undefined;
  const longInput = round(pairs[0][1] / pairs[0][0]);
  if (pairs.some(([a, b]) => Math.abs(b / a - longInput) > 1e-6)) fail(`OpenAI: ${model} long-context input prices do not share one multiplier.`);
  return { longInput, longOutput: round(output / short.output) };
}

export function parseOpenAiPricing(html, bundle) {
  const standard = astroIslands(html, 'TextTokenPricingTables').find(island => island.props?.tier === 'standard');
  if (!standard || !Array.isArray(standard.props.rows)) fail('OpenAI: the standard text-token pricing table was not found.');
  const longRows = standard.props.longContextRows ?? (bundle ? bundleLongContextRows(bundle) : undefined);
  if (!longRows) fail('OpenAI: long-context prices were not found.');
  const thresholds = new Set([...html.matchAll(/&lt;\s*(\d+)K context length|<\s*(\d+)K context length/g)].map(match => Number(match[1] ?? match[2]) * 1000));
  if (thresholds.size > 1) fail(`OpenAI: several long-context thresholds found (${[...thresholds].join(', ')}).`);
  const longAfter = [...thresholds][0];
  const rates = {};
  for (const row of standard.props.rows) {
    const label = typeof row[0] === 'string' ? row[0] : row[0]?.label;
    const model = String(label ?? '').replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(model)) fail(`OpenAI: unexpected model label ${JSON.stringify(label)}.`);
    // Rows with a cache-write column are [model, input, cached, write, output]; older ones are [model, input, cached, output].
    const [input, cached, write, output] = row.length >= 5 ? row.slice(1, 5) : [row[1], row[2], undefined, row[3]];
    if (num(input) === undefined || num(output) === undefined) continue;
    const rate = { input, read: num(cached) ?? input, write: num(write) ?? input, output };
    const long = longRows[model];
    const multipliers = long ? longMultipliers(model, rate, long) : undefined;
    if (multipliers) {
      if (!longAfter) fail(`OpenAI: ${model} has long-context prices but the threshold was not found.`);
      Object.assign(rate, { longAfter, ...multipliers });
    }
    rates[model] = rate;
  }
  return rates;
}

function tables(html) {
  return [...html.matchAll(/<table\b[\s\S]*?<\/table>/g)].map(([table]) =>
    [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map(([row]) => [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map(cell => cleanText(cell[1]))));
}
const dollars = text => { const match = /\$\s*([\d,]*\.?\d+)/.exec(text ?? ''); return match ? Number(match[1].replace(/,/g, '')) : undefined; };
export function claudeModelId(name) {
  const match = /^Claude ([A-Za-z]+) (\d+(?:\.\d+)*)\b/.exec(name);
  return match ? `claude-${match[1].toLowerCase()}-${match[2].replace(/\./g, '-')}` : undefined;
}

export function parseClaudePricing(html) {
  for (const rows of tables(html)) {
    const header = rows.find(cells => cells.includes('5m writes') && cells.includes('1h writes'));
    if (!header) continue;
    const column = name => { const index = header.findIndex(cell => cell.startsWith(name)); return index < 0 ? fail(`Claude: column ${name} is missing.`) : index; };
    const columns = { input: column('Input'), output: column('Output'), write: column('5m writes'), write1h: column('1h writes'), read: column('Hits') };
    const rates = {};
    let previous;
    for (const cells of rows) {
      if (cells === header) continue;
      const model = claudeModelId(cells[0] ?? '');
      if (model && cells.length === header.length) {
        const rate = Object.fromEntries(['input', 'read', 'write', 'output', 'write1h'].map(key => [key, dollars(cells[columns[key]])]));
        if (Object.values(rate).some(value => value === undefined)) fail(`Claude: ${model} has an unreadable price.`);
        rates[model] = rate; previous = { model, cells };
      } else if (previous && cells.length === header.length - 1 && cells[0].startsWith('$')) {
        // Continuation row: prices for prompts over the threshold stated in the row above.
        const threshold = /up to ([\d,]+) tokens/.exec(previous.cells[columns.input]);
        if (!threshold) fail(`Claude: ${previous.model} has a second price row without a prompt-length threshold.`);
        const short = rates[previous.model], value = key => dollars(cells[columns[key] - 1]);
        const longInput = round(value('input') / short.input);
        for (const key of ['read', 'write', 'write1h']) if (Math.abs(value(key) / short[key] - longInput) > 1e-6) fail(`Claude: ${previous.model} long-prompt ${key} price does not scale with input.`);
        Object.assign(short, { longAfter: Number(threshold[1].replace(/,/g, '')), longInput, longOutput: round(value('output') / short.output) });
      }
    }
    return rates;
  }
  fail('Claude: the model pricing table was not found.');
}

const sameRate = (a, b) => FIELDS.every(key => a?.[key] === b?.[key]);
/** Published rates replace or add entries; models a page no longer lists stay, so older usage keeps its price. */
export function mergePricing(current, published) {
  const rates = {}, changes = [];
  for (const provider of ['Codex', 'Claude']) {
    const before = current[provider] ?? {}, after = published[provider] ?? {};
    const known = Object.keys(after).filter(model => before[model]).length, count = Object.keys(after).length;
    if (count < MIN_MODELS || (Object.keys(before).length && !known)) fail(`${provider}: the page yielded ${count} models (${known} already known); its layout probably changed.`);
    rates[provider] = {};
    for (const [model, rate] of Object.entries(after)) {
      if (!before[model]) changes.push({ provider, model, kind: 'added', after: rate });
      else if (!sameRate(before[model], rate)) changes.push({ provider, model, kind: 'changed', before: before[model], after: rate });
      rates[provider][model] = rate;
    }
    for (const [model, rate] of Object.entries(before)) {
      if (rates[provider][model]) continue;
      rates[provider][model] = rate; changes.push({ provider, model, kind: 'unlisted', before: rate });
    }
  }
  return { rates, changes, changed: changes.some(change => change.kind !== 'unlisted') };
}

export function readDataFile(source) {
  const checkedAt = /PRICING_CHECKED_AT = '([^']+)'/.exec(source)?.[1];
  const body = /PRICING_RATES[^=]*=\s*(\{[\s\S]*\});\s*$/.exec(source)?.[1];
  if (!checkedAt || !body) throw new Error('src/core/api-pricing-data.ts is not in the generated format.');
  return { checkedAt, rates: JSON.parse(body) };
}
export function renderDataFile({ checkedAt, rates }) {
  const ordered = rate => Object.fromEntries(FIELDS.filter(key => rate[key] !== undefined).map(key => [key, rate[key]]));
  const providers = Object.entries(rates).map(([provider, models]) =>
    `  ${JSON.stringify(provider)}: {\n${Object.entries(models).map(([model, rate]) => `    ${JSON.stringify(model)}: ${JSON.stringify(ordered(rate))}`).join(',\n')}\n  }`);
  return `// Generated by scripts/pricing-sync.mjs from the published pricing pages: run \`npm run pricing:update\`.
// Models a page no longer lists are kept so older usage stays priced; only those entries should be edited by hand.
export interface PricingRate { input: number; read: number; write: number; output: number; write1h?: number; longAfter?: number; longInput?: number; longOutput?: number }
export const PRICING_CHECKED_AT = '${checkedAt}';
/** USD per million tokens. Standard global API rates, not subscription prices. */
export const PRICING_RATES: Record<'Codex' | 'Claude', Record<string, PricingRate>> = {
${providers.join(',\n')}
};
`;
}

const describeRate = rate => rate ? `$${rate.input} in · $${rate.read} cached · $${rate.write} write · $${rate.output} out${rate.longAfter ? ` · ×${rate.longInput}/×${rate.longOutput} over ${rate.longAfter / 1000}K` : ''}` : '';
export function summarize(changes) {
  const lines = [], section = (kind, title, render) => {
    const items = changes.filter(change => change.kind === kind);
    if (items.length) lines.push(`### ${title}`, '', ...items.map(render), '');
  };
  section('added', 'New models', c => `- **${c.provider}** \`${c.model}\`: ${describeRate(c.after)}`);
  section('changed', 'Changed prices', c => `- **${c.provider}** \`${c.model}\`: ${describeRate(c.before)} → ${describeRate(c.after)}`);
  section('unlisted', 'Kept unchanged (not in the standard pricing table)', c => `- **${c.provider}** \`${c.model}\``);
  return lines.join('\n') || 'No differences.';
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (pricing-sync)' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new PricingParseError(`${url} returned HTTP ${response.status}.`);
  return response.text();
}
export async function fetchPublishedPricing() {
  const [openAiHtml, claudeHtml] = await Promise.all([fetchText(SOURCES.Codex), fetchText(SOURCES.Claude)]);
  const island = astroIslands(openAiHtml, 'TextTokenPricingTables').find(item => item.props?.tier === 'standard');
  const bundle = island?.componentUrl && !island.props.longContextRows ? await fetchText(new URL(island.componentUrl, SOURCES.Codex).href) : undefined;
  return { Codex: parseOpenAiPricing(openAiHtml, bundle), Claude: parseClaudePricing(claudeHtml) };
}

/** Codex lists the models available to the signed-in account; warn about any still unpriced. */
async function localCodexGaps(rates) {
  try {
    const cache = JSON.parse(await readFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    return (cache.models ?? []).filter(model => model.visibility === 'list' && model.supported_in_api !== false && model.slug && !rates.Codex[model.slug.toLowerCase()]).map(model => model.slug);
  } catch { return []; }
}

async function main(args) {
  const write = args.includes('--write'), check = args.includes('--check');
  const summaryIndex = args.indexOf('--summary'), summaryFile = summaryIndex >= 0 ? args[summaryIndex + 1] : undefined;
  const current = readDataFile(await readFile(DATA_FILE, 'utf8'));
  const { rates, changes, changed } = mergePricing(current.rates, await fetchPublishedPricing());
  const summary = summarize(changes);
  console.log(summary);
  if (summaryFile) await writeFile(summaryFile, `Prices from ${SOURCES.Codex} and ${SOURCES.Claude}.\n\n${summary}\n`);
  if (!process.env.CI) for (const slug of await localCodexGaps(rates)) console.warn(`Warning: Codex offers ${slug} on this machine, but neither the page nor the data file prices it.`);
  if (write && changed) {
    await writeFile(DATA_FILE, renderDataFile({ checkedAt: new Date().toISOString().slice(0, 10), rates }));
    console.log(`Updated ${path.relative(process.cwd(), DATA_FILE)}.`);
  }
  if (check && changed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof PricingParseError ? `Pricing page could not be read: ${error.message}` : error);
    process.exitCode = 2;
  });
}
