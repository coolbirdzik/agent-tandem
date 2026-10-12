import type { ContextUsage } from '../providers/context-usage';

const tokens = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export class ContextStatus {
  private usage?: ContextUsage;
  private timer?: number;
  constructor(private root: HTMLElement) {}
  render(usage?: ContextUsage, differentModel = false) {
    this.usage = differentModel ? undefined : usage;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = undefined;
    this.update();
    if (this.usage?.cacheExpiresAt && this.usage.cacheExpiresAt > Date.now()) this.timer = window.setInterval(() => this.update(), 1000);
  }
  private update() {
    const usage = this.usage;
    const context = this.root.querySelector<HTMLElement>('[data-context-label]')!;
    const cache = this.root.querySelector<HTMLElement>('[data-cache-label]')!;
    const meter = this.root.querySelector<HTMLProgressElement>('progress')!;
    const used = usage?.usedTokens, capacity = usage?.windowTokens;
    context.textContent = used === undefined ? 'Context —' : capacity ? `Context ${Math.round(used / capacity * 100)}%` : `Context ${tokens(used)}`;
    context.title = used === undefined ? 'Context usage has not been reported by this CLI for this conversation.' : `${used.toLocaleString()} tokens${capacity ? ` / ${capacity.toLocaleString()} context window` : ' · CLI has not reported the context window'}${usage?.model ? `\n${usage.model}` : ''}${usage?.updatedAt ? `\nLast measured ${new Date(usage.updatedAt).toLocaleString()}` : ''}`;
    meter.hidden = used === undefined || !capacity; meter.max = capacity ?? 1; meter.value = used ?? 0;
    meter.setAttribute('aria-label', context.textContent); this.root.dataset.full = String(!!capacity && used !== undefined && used >= capacity);
    const expiry = usage?.cacheExpiresAt;
    if (expiry !== undefined) {
      const remaining = Math.max(0, Math.ceil((expiry - Date.now()) / 1000));
      cache.textContent = remaining ? `TTL ~${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'TTL expired';
      cache.title = `Estimated from the CLI's reported ${usage?.cacheTtlMs === 3_600_000 ? '1-hour' : '5-minute'} cache TTL and last request.\nExpected expiry ${new Date(expiry).toLocaleTimeString()}. Cache hits refresh the timer; this is not a server expiry guarantee.`;
      if (!remaining && this.timer) { window.clearInterval(this.timer); this.timer = undefined; }
    } else {
      cache.textContent = 'TTL —'; cache.title = 'The selected CLI has not reported a cache expiry time or TTL. No countdown is assumed.';
    }
    context.setAttribute('aria-label', `${context.textContent}. ${context.title}`);
    if (usage?.cachedTokens !== undefined) cache.title += `\n${usage.cachedTokens.toLocaleString()} cached input tokens in the latest response.`;
    cache.setAttribute('aria-label', `Cache ${cache.textContent}. ${cache.title}`);
    this.root.dataset.cache = expiry === undefined ? 'unknown' : expiry > Date.now() ? 'warm-estimate' : 'expired-estimate';
  }
}
