import type { QuotaCycle } from '../core/quota-estimate';

type Metric = 'tokensPerPercent' | 'observedTokens' | 'capacityTokens' | 'changePercent';
const choices: Array<[Metric, string]> = [['tokensPerPercent', 'Tokens / 1%'], ['observedTokens', 'Recorded tokens'], ['capacityTokens', 'Full quota estimate'], ['changePercent', 'Change vs previous cycle']];
const selectedMetrics = new Map<string, Metric>();
const number = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const signedPercent = (value: number) => `${value > 0 ? '+' : ''}${number(value)}%`;
const date = (cycle: QuotaCycle) => new Date(cycle.cycleStartedAt ?? cycle.from).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  interval.append(element('figcaption', `${latest.active ? 'Current cycle recorded' : 'Latest recorded cycle'}${latest.cycleStartKnown === false ? ' · 100% start not observed' : ''}`, 'muted'));
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
  heading.append(element('span', 'Across quota cycles'));
  const control = element('label', 'Chart metric', 'quota-chart-control'), select = element('select');
  for (const [value, label] of choices) { const option = element('option', label); option.value = value; select.append(option); }
  select.value = selectedMetrics.get(scope) ?? 'tokensPerPercent'; control.append(select); heading.append(control);
  const viewport = element('div', undefined, 'quota-chart-viewport');
  const plot = element('div', undefined, 'quota-cycle-plot'), axis = element('div', undefined, 'quota-chart-axis quota-cycle-axis');
  const detail = element('output', undefined, 'quota-chart-detail'), caption = element('small', undefined, 'muted quota-chart-caption');
  viewport.append(plot, axis); history.append(heading, viewport, detail, caption); root.append(history);
  const shown = cycles.slice(-12);
  let selected = shown.length - 1;
  function draw() {
    const metric = select.value as Metric, rate = metric === 'tokensPerPercent', change = metric === 'changePercent'; selectedMetrics.set(scope, metric);
    const values = shown.flatMap(cycle => cycle[metric] === undefined ? [] : [cycle[metric]!]);
    const max = change ? Math.max(1, ...values.map(Math.abs)) : Math.max(1, ...(rate ? [weightedRate] : []), ...values);
    const min = change ? -max : 0;
    const width = Math.max(400, shown.length * 88), slot = width / shown.length;
    viewport.style.setProperty('--quota-plot-width', `${width + 45}px`);
    const svg = svgElement('svg', { viewBox: `0 0 ${width} 170`, preserveAspectRatio: 'none', role: 'group', 'aria-label': `${select.selectedOptions[0]!.textContent} by reset cycle` });
    // Equal slots keep nearby resets readable; dates on every slot retain the actual timing.
    const x = (index: number) => slot * (index + 0.5);
    const y = (value: number) => 155 - (value - min) / (max - min) * 130;
    for (const value of [min, (max + min) / 2, max]) svg.append(svgElement('line', { x1: 0, x2: width, y1: y(value), y2: y(value), class: `quota-chart-grid${value === 0 ? ' quota-chart-zero' : ''}` }));
    if (rate) {
      svg.append(svgElement('line', { x1: 0, x2: width, y1: y(weightedRate), y2: y(weightedRate), class: 'quota-chart-average' }));
      if (shown.length > 1) svg.append(svgElement('polyline', { points: shown.map((cycle, index) => `${x(index)},${y(cycle.tokensPerPercent)}`).join(' '), class: 'quota-chart-line' }));
    }
    const showDetail = (index: number) => {
      selected = index; const cycle = shown[index]!;
      detail.textContent = `${date(cycle)}${cycle.active ? ' · current' : ''} · ${range(cycle)} · ${number(cycle.observedTokens)} tokens · ≈ ${number(cycle.tokensPerPercent)} tokens / 1% · ≈ ${compact(cycle.capacityTokens)} full quota${cycle.changePercent === undefined ? ' · No previous cycle' : ` · ${signedPercent(cycle.changePercent)} tokens / 1% vs previous cycle`}`;
      svg.querySelectorAll('.quota-chart-point').forEach((point, i) => point.classList.toggle('is-selected', i === index));
    };
    for (const [index, cycle] of shown.entries()) {
      const value = cycle[metric], point = svgElement('g', { class: 'quota-chart-point', 'data-current': String(cycle.active) });
      const valueLabel = value === undefined ? '—' : change ? signedPercent(value) : compact(value);
      const label = `${date(cycle)}${cycle.active ? ' · current' : ''}: ${value === undefined ? 'No previous cycle' : `${change ? signedPercent(value) : number(value)} ${select.selectedOptions[0]!.textContent}`}; ${range(cycle)}; ${number(cycle.observedTokens)} recorded tokens`;
      const hit = svgElement('rect', { x: slot * index, y: 0, width: slot, height: 170, class: 'quota-chart-hit', tabindex: 0, role: 'img', 'aria-label': label });
      const title = svgElement('title', {}); title.textContent = label; hit.append(title); point.append(hit);
      if (value !== undefined) {
        const mark = rate ? svgElement('circle', { cx: x(index), cy: y(value), r: 4.5 })
          : svgElement('rect', { x: x(index) - Math.min(36, slot * 0.5) / 2, y: Math.min(y(value), y(0)), width: Math.min(36, slot * 0.5), height: Math.max(2, Math.abs(y(0) - y(value))), rx: 2 });
        mark.setAttribute('class', 'quota-chart-mark');
        if (change) mark.setAttribute('data-direction', value < 0 ? 'down' : 'up');
        point.append(mark);
      }
      const text = svgElement('text', { x: x(index), y: value !== undefined && value < 0 ? y(value) + 13 : y(value ?? 0) - 10, 'text-anchor': 'middle', class: 'quota-chart-value' });
      text.textContent = valueLabel; point.append(text);
      point.onpointerenter = () => showDetail(index); hit.onfocus = () => showDetail(index);
      hit.onkeydown = event => {
        const target = event.key === 'ArrowLeft' ? Math.max(0, index - 1) : event.key === 'ArrowRight' ? Math.min(shown.length - 1, index + 1) : event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1 : undefined;
        if (target !== undefined) { event.preventDefault(); svg.querySelectorAll<SVGRectElement>('.quota-chart-hit')[target]?.focus(); }
      };
      svg.append(point);
    }
    const scale = element('div', undefined, 'quota-chart-scale');
    scale.append(...[max, (max + min) / 2, min].map(value => element('span', change ? signedPercent(value) : compact(value))));
    plot.replaceChildren(scale, svg);
    axis.style.gridTemplateColumns = `repeat(${shown.length}, minmax(0, 1fr))`;
    axis.replaceChildren(...shown.map(cycle => {
      const label = element('span', date(cycle)); label.title = `${cycle.cycleStartKnown ? 'Last 100% reading' : 'Partial / legacy start'}: ${new Date(cycle.cycleStartedAt ?? cycle.from).toLocaleString()} · Expected reset: ${new Date(cycle.resetsAt).toLocaleString()}`;
      if (cycle.active) label.append(element('strong', 'Current'));
      return label;
    }));
    caption.textContent = `${shown.length < cycles.length ? `Latest ${shown.length} of ${cycles.length}` : shown.length} quota ${cycles.length === 1 ? 'cycle' : 'cycles'}${rate ? ` · dashed line: weighted average ${compact(weightedRate)} tokens / 1%` : change ? ' · change in tokens / 1% · compared with the previous recorded cycle' : metric === 'capacityTokens' ? ' · extrapolated from recorded usage' : ' · observed portion of each cycle'} · Cycle starts at the last 100% reading; partial starts are unconfirmed · Hover or use ← → to inspect`;
    showDetail(selected);
  }
  select.onchange = draw; draw();
  return root;
}
