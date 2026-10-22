import type { QuotaCycle } from '../core/quota-estimate';

type Metric = 'tokensPerPercent' | 'observedTokens' | 'capacityTokens';
const choices: Array<[Metric, string]> = [['tokensPerPercent', 'Tokens / 1%'], ['observedTokens', 'Recorded tokens'], ['capacityTokens', 'Full quota estimate']];
const selectedMetrics = new Map<string, Metric>();
const number = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const date = (cycle: QuotaCycle) => new Date(cycle.resetsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', ...(cycle.label === '5h' ? { hour: '2-digit', minute: '2-digit' } : {}) });
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value;
};
const svgElement = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>) => {
  const value = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, content] of Object.entries(attributes)) value.setAttribute(name, String(content));
  return value;
};
const range = (cycle: QuotaCycle) => cycle.remainingFrom === undefined ? `${number(cycle.usedPercent)} percentage points · start unknown` : `${number(cycle.remainingFrom)}% → ${number(cycle.remainingTo!)}% remaining`;

/** Each window keeps its own account/source-matched chart selection across refreshes. */
export function quotaCycleCharts(cycles: QuotaCycle[], weightedRate: number, scope: string): HTMLElement {
  const root = element('div', undefined, 'quota-cycle-charts');
  const latest = cycles.at(-1);
  if (!latest) return root;
  const interval = element('figure', undefined, 'quota-interval-chart');
  interval.append(element('figcaption', latest.active ? 'Current cycle recorded' : 'Latest recorded cycle', 'muted'));
  const facts = element('div', undefined, 'quota-interval-facts');
  facts.append(element('strong', range(latest)), element('span', `${number(latest.observedTokens)} tokens`)); interval.append(facts);
  if (latest.remainingFrom !== undefined) {
    const track = element('div', undefined, 'quota-interval-track'), fill = element('span');
    fill.style.left = `${100 - latest.remainingFrom}%`; fill.style.width = `${latest.usedPercent}%`; track.append(fill);
    track.setAttribute('role', 'img'); track.setAttribute('aria-label', `${range(latest)}: ${number(latest.observedTokens)} recorded tokens`);
    const axis = element('div', undefined, 'quota-chart-axis'); axis.append(element('span', '100%'), element('span', '0% remaining'));
    interval.append(track, axis);
  }
  interval.append(element('small', latest.source === 'API' ? 'API counter increase over this interval' : 'Local recorded subset · account usage may be higher', 'muted'));
  root.append(interval);

  const history = element('figure', undefined, 'quota-history-chart'), heading = element('figcaption', undefined, 'quota-chart-heading');
  heading.append(element('span', 'Across reset cycles'));
  const control = element('label', 'Chart metric', 'quota-chart-control'), select = element('select');
  for (const [value, label] of choices) { const option = element('option', label); option.value = value; select.append(option); }
  select.value = selectedMetrics.get(scope) ?? 'tokensPerPercent'; control.append(select); heading.append(control);
  const plot = element('div', undefined, 'quota-cycle-plot'), axis = element('div', undefined, 'quota-chart-axis');
  const detail = element('output', undefined, 'quota-chart-detail'), caption = element('small', undefined, 'muted quota-chart-caption');
  history.append(heading, plot, axis, detail, caption); root.append(history);
  const shown = cycles.slice(-12);
  function draw() {
    const metric = select.value as Metric, rate = metric === 'tokensPerPercent'; selectedMetrics.set(scope, metric);
    const max = Math.max(1, ...(rate ? [weightedRate] : []), ...shown.map(cycle => cycle[metric]));
    const svg = svgElement('svg', { viewBox: '0 0 400 150', preserveAspectRatio: 'none', role: 'group', 'aria-label': `${select.selectedOptions[0]!.textContent} by reset cycle` });
    const start = shown[0]!.resetsAt, span = latest!.resetsAt - start;
    const x = (cycle: QuotaCycle) => span ? 24 + (cycle.resetsAt - start) / span * 352 : 200;
    const y = (value: number) => 140 - value / max * 125;
    for (const level of [0, 0.5, 1]) svg.append(svgElement('line', { x1: 0, x2: 400, y1: y(level * max), y2: y(level * max), class: 'quota-chart-grid' }));
    if (rate) {
      svg.append(svgElement('line', { x1: 0, x2: 400, y1: y(weightedRate), y2: y(weightedRate), class: 'quota-chart-average' }));
      if (shown.length > 1) svg.append(svgElement('polyline', { points: shown.map(cycle => `${x(cycle)},${y(cycle[metric])}`).join(' '), class: 'quota-chart-line' }));
    }
    const showDetail = (cycle: QuotaCycle) => { detail.textContent = `${date(cycle)}${cycle.active ? ' · current' : ''} · ${range(cycle)} · ${number(cycle.observedTokens)} tokens · ≈ ${number(cycle.tokensPerPercent)} tokens / 1%`; };
    const gap = Math.min(40, ...shown.slice(1).map((cycle, index) => x(cycle) - x(shown[index]!)));
    for (const cycle of shown) {
      const mark = rate ? svgElement('circle', { cx: x(cycle), cy: y(cycle[metric]), r: 4.5 })
        : svgElement('rect', { x: x(cycle) - gap * 0.3, y: y(cycle[metric]), width: gap * 0.6, height: 140 - y(cycle[metric]), rx: 2 });
      mark.setAttribute('class', 'quota-chart-mark'); mark.setAttribute('tabindex', '0'); mark.setAttribute('role', 'img');
      const label = `${date(cycle)}: ${number(cycle[metric])} ${select.selectedOptions[0]!.textContent}; ${range(cycle)}; ${number(cycle.observedTokens)} recorded tokens`;
      mark.setAttribute('aria-label', label); const title = svgElement('title', {}); title.textContent = label; mark.append(title);
      mark.onpointerenter = () => showDetail(cycle); mark.onfocus = () => showDetail(cycle); svg.append(mark);
    }
    const scale = element('div', undefined, 'quota-chart-scale'); scale.append(element('span', compact(max)), element('span', '0'));
    plot.replaceChildren(scale, svg); axis.replaceChildren(element('span', date(shown[0]!)), element('span', shown.length > 1 ? date(latest!) : '1 cycle'));
    caption.textContent = `${shown.length < cycles.length ? `Latest ${shown.length} of ${cycles.length}` : shown.length} reset ${cycles.length === 1 ? 'cycle' : 'cycles'}${rate ? ` · dashed line: weighted average ${compact(weightedRate)} tokens / 1%` : metric === 'capacityTokens' ? ' · extrapolated from recorded usage' : ' · observed portion of each cycle'}`;
    showDetail(latest!);
  }
  select.onchange = draw; draw();
  return root;
}
