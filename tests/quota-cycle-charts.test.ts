// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { quotaCycles, type QuotaObservation } from '../src/core/quota-estimate';
import { quotaCycleCharts } from '../src/ui/quota-cycle-charts';

const now = Date.now(), duration = 5 * 3600000;
const observation = (index: number, tokens = 200000, used = 2): QuotaObservation => ({ provider: 'Codex', accountId: 'one', plan: 'plus', label: '5h',
  from: now + (index - 1) * duration, to: now + index * duration, resetsAt: now + index * duration + 3600000,
  observedTokens: tokens, usedPercent: used, startUsedPercent: 16, source: 'API' });

describe('Quota cycle charts', () => {
  it('shows the measured interval and lets keyboard users inspect individual cycles', () => {
    const root = quotaCycleCharts(quotaCycles([observation(-1, 100000), observation(0)]), 75000, 'keyboard');
    expect(root.querySelector('.quota-interval-facts')?.textContent).toBe('84% → 82% remaining200,000 tokens');
    expect(root.querySelector<HTMLElement>('.quota-interval-track span')?.style.width).toBe('2%');
    expect(root.querySelector<HTMLElement>('.quota-interval-track span')?.style.left).toBe('16%');
    const marks = root.querySelectorAll('.quota-chart-mark'); expect(marks).toHaveLength(2);
    expect(marks[0]?.getAttribute('tabindex')).toBe('0');
    marks[0]!.dispatchEvent(new FocusEvent('focus'));
    expect(root.querySelector('output')?.textContent).toContain('100,000 tokens');
    expect(root.querySelector('output')?.textContent).toContain('50,000 tokens / 1%');
    expect(root.querySelector('.quota-chart-caption')?.textContent).toContain('weighted average 75');
  });
  it('switches from a rate line to token bars and preserves only the same account selection', () => {
    const cycles = quotaCycles([observation(-1), observation(0, 400000)]);
    const root = quotaCycleCharts(cycles, 150000, 'one-account');
    expect(root.querySelector('polyline')).not.toBeNull();
    const select = root.querySelector('select')!; select.value = 'observedTokens'; select.dispatchEvent(new Event('change'));
    expect(root.querySelector('polyline')).toBeNull(); expect(root.querySelectorAll('rect')).toHaveLength(2);
    expect(root.querySelector('rect')?.getAttribute('aria-label')).toContain('200,000 Recorded tokens');
    expect(quotaCycleCharts(cycles, 150000, 'one-account').querySelector('select')?.value).toBe('observedTokens');
    expect(quotaCycleCharts(cycles, 150000, 'another-account').querySelector('select')?.value).toBe('tokensPerPercent');
    select.value = 'capacityTokens'; select.dispatchEvent(new Event('change'));
    expect(root.querySelector('rect')?.getAttribute('aria-label')).toContain('10,000,000 Full quota estimate');
    expect(root.querySelector('.quota-chart-caption')?.textContent).toContain('extrapolated');
  });
  it('does not invent unknown endpoints or a line for a single sample', () => {
    const root = quotaCycleCharts(quotaCycles([{ ...observation(0), startUsedPercent: undefined }]), 100000, 'legacy');
    expect(root.textContent).toContain('2 percentage points · start unknown');
    expect(root.querySelector('.quota-interval-track')).toBeNull(); expect(root.querySelector('polyline')).toBeNull();
    expect(root.querySelectorAll('circle')).toHaveLength(1); expect(root.innerHTML).not.toMatch(/NaN|Infinity/);
  });
  it('limits plotted cycles while keeping the weighted average from all history', () => {
    const cycles = quotaCycles(Array.from({ length: 20 }, (_, index) => observation(index - 19)));
    const root = quotaCycleCharts(cycles, 80000, 'long-history');
    expect(root.querySelectorAll('.quota-chart-mark')).toHaveLength(12);
    expect(root.textContent).toContain('Latest 12 of 20 reset cycles');
    expect(root.textContent).toContain('weighted average 80');
    const local = quotaCycleCharts(quotaCycles([{ ...observation(0), source: 'Local', startUsedPercent: undefined }]), 100000, 'local');
    expect(local.textContent).toContain('100% → 98%'); expect(local.textContent).toContain('Local recorded subset');
  });
});
