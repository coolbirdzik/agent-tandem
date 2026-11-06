import type { QuotaCycle } from '../core/quota-estimate';

type Metric = 'tokensPerPercent' | 'observedTokens' | 'capacityTokens' | 'changePercent';
type Field = 'start' | 'remaining' | 'tokens' | 'used' | 'rate' | 'capacity' | 'change';
const choices: Array<[Metric, string]> = [['tokensPerPercent', 'Tokens / 1%'], ['observedTokens', 'Recorded tokens'], ['capacityTokens', 'Full quota estimate'], ['changePercent', 'Change vs previous cycle']];
/** Each line of the table under the chart, in reading order; `metric` ties it to the chart selector. */
const fields: Array<{ key: Field; label: string; metric?: Metric }> = [
  { key: 'start', label: 'Cycle start' }, { key: 'remaining', label: 'Remaining' }, { key: 'tokens', label: 'Tokens', metric: 'observedTokens' },
  { key: 'used', label: 'Used (pp)' }, { key: 'rate', label: '≈ Tokens / 1%', metric: 'tokensPerPercent' }, { key: 'capacity', label: '≈ Full quota', metric: 'capacityTokens' },
  { key: 'change', label: 'vs prev.', metric: 'changePercent' },
];
const selectedMetrics = new Map<string, Metric>(), expandedCycles = new Set<string>();
/** Width of the label column shared by the chart scale and the table; every cycle then gets one slot of equal width. */
const gutter = 108, minSlot = 88, maxSlot = 320, recentCycles = 12, olderCycles = 30;
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

/** Fill one cell of the cycle table. Long text lives in the tooltip so a column stays narrow. */
function fillCell(cell: HTMLElement, field: Field, cycle: QuotaCycle) {
  switch (field) {
    case 'start': {
      cell.append(element('span', date(cycle), 'quota-cycle-date'));
      const tags = [cycle.active ? 'Current' : '', cycle.cycleStartKnown === false ? 'Partial' : cycle.cycleStartedAt === undefined ? 'Legacy' : ''].filter(Boolean);
      if (tags.length) { const flag = element('small', tags.join(' · '), 'quota-cycle-tag'); flag.dataset.kind = cycle.active ? 'current' : 'other'; cell.append(flag); }
      cell.title = `Reset ${new Date(cycle.resetsAt).toLocaleString()} · ${cycle.partial ? 'Partial observation' : 'Full cycle'} · ${number(cycle.usedPercent)}% quota observed\n${new Date(cycle.cycleStartedAt ?? cycle.from).toLocaleString()} – ${new Date(cycle.to).toLocaleString()}`;
      break;
    }
    case 'remaining':
      cell.textContent = cycle.remainingFrom === undefined ? 'Start unknown' : `${number(cycle.remainingFrom)}% → ${number(cycle.remainingTo!)}%`;
      cell.title = 'Quota remaining at the first and last readings; recorded local tokens may be incomplete'; break;
    case 'tokens': cell.textContent = number(cycle.observedTokens); cell.title = number(cycle.observedTokens); break;
    case 'used': cell.textContent = number(cycle.usedPercent); break;
    case 'rate': cell.textContent = number(Math.round(cycle.tokensPerPercent)); cell.title = `${number(cycle.observedTokens)} tokens ÷ ${number(cycle.usedPercent)} percentage points`; break;
    case 'capacity': cell.textContent = compact(cycle.capacityTokens); cell.title = number(Math.round(cycle.capacityTokens)); break;
    case 'change':
      cell.textContent = cycle.changePercent === undefined ? '—' : signedPercent(Math.round(cycle.changePercent * 10) / 10);
      if (cycle.changePercent !== undefined && cycle.changePercent !== 0) cell.dataset.direction = cycle.changePercent > 0 ? 'up' : 'down';
      break;
  }
}

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
  const plot = element('div', undefined, 'quota-cycle-plot'), sheet = element('div', undefined, 'quota-cycle-sheet'), caption = element('small', undefined, 'muted quota-chart-caption');
  viewport.append(plot, sheet); history.append(heading, viewport, caption); root.append(history);
  // The latest twelve fit comfortably; older ones are one click away.
  let limit = expandedCycles.has(scope) && cycles.length > recentCycles ? olderCycles : recentCycles, shown = cycles.slice(-limit), selected = shown.length - 1, slot = minSlot;
  const older = cycles.length > recentCycles ? element('button', undefined, 'quiet quota-chart-more') : undefined;
  if (older) heading.insertBefore(older, control);
  /** Columns stretch to the panel up to a cap, never below a readable width; the chart and the table share them. */
  const slotWidth = () => Math.min(maxSlot, Math.max(minSlot, viewport.clientWidth > gutter ? Math.floor((viewport.clientWidth - gutter) / shown.length) : minSlot));
  function draw() {
    const metric = select.value as Metric, rate = metric === 'tokensPerPercent', change = metric === 'changePercent'; selectedMetrics.set(scope, metric);
    shown = cycles.slice(-limit); selected = Math.min(selected, shown.length - 1); slot = slotWidth();
    if (older) older.textContent = limit === recentCycles ? `Show all ${Math.min(cycles.length, olderCycles)} cycles` : `Show latest ${recentCycles}`;
    const values = shown.flatMap(cycle => cycle[metric] === undefined ? [] : [cycle[metric]!]);
    const max = change ? Math.max(1, ...values.map(Math.abs)) : Math.max(1, ...(rate ? [weightedRate] : []), ...values);
    const min = change ? -max : 0;
    const width = slot * shown.length;
    viewport.style.setProperty('--quota-gutter', `${gutter}px`); viewport.style.setProperty('--quota-sheet-width', `${gutter + width}px`);
    const svg = svgElement('svg', { viewBox: `0 0 ${width} 170`, preserveAspectRatio: 'none', role: 'group', 'aria-label': `${select.selectedOptions[0]!.textContent} by reset cycle` });
    // Equal slots keep nearby resets readable; the table under each column carries the actual dates.
    const x = (index: number) => slot * (index + 0.5);
    const y = (value: number) => 155 - (value - min) / (max - min) * 130;
    for (const value of [min, (max + min) / 2, max]) svg.append(svgElement('line', { x1: 0, x2: width, y1: y(value), y2: y(value), class: `quota-chart-grid${value === 0 ? ' quota-chart-zero' : ''}` }));
    if (rate) {
      svg.append(svgElement('line', { x1: 0, x2: width, y1: y(weightedRate), y2: y(weightedRate), class: 'quota-chart-average' }));
      if (shown.length > 1) svg.append(svgElement('polyline', { points: shown.map((cycle, index) => `${x(index)},${y(cycle.tokensPerPercent)}`).join(' '), class: 'quota-chart-line' }));
    }
    const showCycle = (index: number) => {
      selected = index;
      svg.querySelectorAll('.quota-chart-point').forEach((point, i) => point.classList.toggle('is-selected', i === index));
      sheet.querySelectorAll<HTMLElement>('[data-index]').forEach(cell => cell.classList.toggle('is-selected', Number(cell.dataset.index) === index));
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
      point.onpointerenter = () => showCycle(index); hit.onfocus = () => showCycle(index);
      hit.onkeydown = event => {
        const target = event.key === 'ArrowLeft' ? Math.max(0, index - 1) : event.key === 'ArrowRight' ? Math.min(shown.length - 1, index + 1) : event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1 : undefined;
        if (target !== undefined) { event.preventDefault(); svg.querySelectorAll<SVGRectElement>('.quota-chart-hit')[target]?.focus(); }
      };
      svg.append(point);
    }
    const scale = element('div', undefined, 'quota-chart-scale');
    scale.append(...[max, (max + min) / 2, min].map(value => element('span', change ? signedPercent(value) : compact(value))));
    plot.replaceChildren(scale, svg);
    // One table row per figure and one column per cycle, aligned under the chart.
    const table = element('table', undefined, 'quota-cycle-table'), group = element('colgroup'), body = element('tbody');
    const first = element('col'); first.style.width = `${gutter}px`; group.append(first);
    for (let index = 0; index < shown.length; index++) { const column = element('col'); column.style.width = `${slot}px`; group.append(column); }
    for (const { key, label, metric: chosen } of fields) {
      const line = element('tr'), header = element('th', label); header.scope = 'row'; line.dataset.field = key; line.append(header);
      line.classList.toggle('is-metric', chosen === metric);
      for (const [index, cycle] of shown.entries()) {
        // The cycle start is each column's header, so a screen reader announces it with every figure below.
        const cell = element(key === 'start' ? 'th' : 'td', undefined, 'quota-cycle-cell'); if (key === 'start') cell.setAttribute('scope', 'col'); cell.dataset.index = String(index); cell.dataset.field = key; fillCell(cell, key, cycle);
        cell.onpointerenter = () => showCycle(index); line.append(cell);
      }
      body.append(line);
    }
    table.append(group, body); sheet.replaceChildren(table);
    caption.textContent = `${shown.length < cycles.length ? `Latest ${shown.length} of ${cycles.length}` : shown.length} quota ${cycles.length === 1 ? 'cycle' : 'cycles'}${rate ? ` · dashed line: weighted average ${compact(weightedRate)} tokens / 1%` : change ? ' · change in tokens / 1% · compared with the previous recorded cycle' : metric === 'capacityTokens' ? ' · extrapolated from recorded usage' : ' · observed portion of each cycle'} · A cycle starts at the last 100% reading; partial starts are unconfirmed`;
    showCycle(selected);
  }
  select.onchange = draw;
  if (older) older.onclick = () => { limit = limit === recentCycles ? olderCycles : recentCycles; if (limit === olderCycles) expandedCycles.add(scope); else expandedCycles.delete(scope); selected = Math.min(selected, cycles.slice(-limit).length - 1); draw(); };
  draw();
  // The panel width is only known once it is on screen, and changes with the window.
  if (typeof ResizeObserver !== 'undefined') {
    const watcher = new ResizeObserver(() => {
      // A re-rendered panel replaces this chart; stop watching it once it has left the page.
      if (!viewport.isConnected) { if (attached) watcher.disconnect(); return; }
      attached = true; if (slotWidth() !== slot) draw();
    });
    let attached = false; watcher.observe(viewport);
  }
  return root;
}
