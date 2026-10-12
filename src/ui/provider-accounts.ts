import type { ConversationProvider } from '../providers/conversations';
import type { ProviderAccountStatus, QuotaWindow } from '../providers/account-status';
type Accounts = Partial<Record<ConversationProvider, ProviderAccountStatus>>;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element;
};
const remaining = (window: QuotaWindow) => `${Math.round(Math.max(0, 100 - window.usedPercent) * 10) / 10}% left`;
const planLabel = (value?: string) => value ? value.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase()) : '';
const resetLabel = (window: QuotaWindow) => window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString()}` : 'Reset time unavailable';

export class ProviderAccounts {
  private accounts: Accounts = {};
  private revision = '';
  private provider?: ConversationProvider;
  private popover = node('section', undefined, 'account-popover');
  constructor(private root: HTMLElement, private refresh: (provider: ConversationProvider) => void) {
    this.popover.hidden = true; this.popover.setAttribute('role', 'dialog'); this.popover.setAttribute('aria-label', 'Account and quota');
    document.body.append(this.popover);
    window.addEventListener('click', event => {
      if (!this.popover.hidden && !this.popover.contains(event.target as Node) && !this.root.contains(event.target as Node)) this.close();
    });
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !this.popover.hidden) { event.preventDefault(); event.stopImmediatePropagation(); this.close(true); }
    });
    window.addEventListener('resize', () => this.position());
  }
  render(accounts: Accounts | undefined, project: string | undefined, activeProvider: ConversationProvider, visible = true) {
    this.root.hidden = !project || !visible;
    if (!project || !visible) { this.close(); this.revision = ''; return; }
    const revision = JSON.stringify([project, activeProvider, accounts?.[activeProvider]]);
    if (revision === this.revision) return;
    if (this.provider && this.provider !== activeProvider) this.close();
    this.revision = revision; this.accounts = accounts ?? {};
    const focusProvider = (document.activeElement as HTMLElement | null)?.dataset.accountProvider;
    const refreshFocused = this.popover.contains(document.activeElement) && (document.activeElement as HTMLElement).dataset.accountRefresh !== undefined;
    const closeFocused = document.activeElement?.classList.contains('account-close');
    this.root.replaceChildren();
    for (const provider of [activeProvider]) {
      const status = this.accounts[provider], account = status?.account;
      const button = node('button', undefined, 'account-summary'); button.type = 'button'; button.dataset.accountProvider = provider;
      button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', String(this.provider === provider));
      const icon = node('img'); icon.src = document.body.dataset[provider === 'Claude' ? 'claudeIcon' : 'codexIcon']!; icon.alt = ''; icon.className = 'provider-icon'; icon.dataset.provider = provider;
      const identity = account ? account.email || account.method : status?.status === 'error' ? 'Account unavailable' : 'Loading account…';
      const quota = node('span', undefined, 'account-quota-summary');
      if (status?.status === 'loading') quota.append(node('span', 'Updating…'));
      else if (status?.quota?.windows.length) {
        for (const window of status.quota.windows.slice(0, 2)) {
          const label = node('span', undefined, 'quota-mini');
          const left = Math.min(100, Math.max(0, 100 - window.usedPercent));
          label.title = `API · ${window.label}: ${remaining(window)} · ${resetLabel(window)}`;
          label.dataset.level = left <= 10 ? 'critical' : left <= 25 ? 'low' : 'healthy';
          const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          ring.setAttribute('viewBox', '0 0 20 20'); ring.classList.add('quota-ring');
          ring.setAttribute('aria-hidden', 'true');
          for (const foreground of [false, true]) {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', '10'); circle.setAttribute('cy', '10'); circle.setAttribute('r', '7');
            circle.setAttribute('fill', 'none'); circle.setAttribute('stroke-width', '2.5');
            circle.classList.add(foreground ? 'quota-ring-value' : 'quota-ring-track');
            if (foreground) {
              circle.setAttribute('pathLength', '100'); circle.setAttribute('stroke-dasharray', `${left} 100`);
              circle.setAttribute('transform', 'rotate(-90 10 10)');
            }
            ring.append(circle);
          }
          label.append(ring, node('span', `${window.label} ${remaining(window).replace(' left', '')}`));
          quota.append(label);
        }
      } else quota.append(node('span', status?.quota?.credits || (status?.status === 'error' ? 'Refresh to retry' : 'Quota —')));
      button.title = `${provider} · ${identity}${account?.plan ? ` · ${planLabel(account.plan)}` : ''}\n${status?.quota?.windows.map(window => `${window.label}: ${remaining(window)}`).join(' · ') || 'Quota unavailable'}\nAPI quota remaining · Open account and quota details`;
      button.setAttribute('aria-label', button.title);
      button.append(icon, quota, node('span', undefined, 'codicon codicon-chevron-up')); button.lastElementChild!.setAttribute('aria-hidden', 'true');
      button.onclick = () => this.open(provider); this.root.append(button);
    }
    if (focusProvider) this.root.querySelector<HTMLButtonElement>(`[data-account-provider="${focusProvider}"]`)?.focus({ preventScroll: true });
    if (this.provider) {
      this.renderPopover();
      if (refreshFocused) this.popover.querySelector<HTMLButtonElement>('[data-account-refresh]')?.focus({ preventScroll: true });
      if (closeFocused) this.popover.querySelector<HTMLButtonElement>('.account-close')?.focus({ preventScroll: true });
    }
  }
  private open(provider: ConversationProvider) {
    this.provider = provider; this.root.querySelectorAll('[data-account-provider]').forEach(button => button.setAttribute('aria-expanded', String((button as HTMLElement).dataset.accountProvider === provider)));
    this.popover.hidden = false; this.renderPopover(); this.popover.querySelector<HTMLButtonElement>('.account-close')!.focus({ preventScroll: true });
  }
  private close(restoreFocus = false) {
    const provider = this.provider; this.provider = undefined; this.popover.hidden = true;
    this.root.querySelectorAll('[data-account-provider]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    if (restoreFocus && provider) this.root.querySelector<HTMLButtonElement>(`[data-account-provider="${provider}"]`)?.focus({ preventScroll: true });
  }
  private renderPopover() {
    const provider = this.provider!;
    const status = this.accounts[provider], account = status?.account;
    this.popover.replaceChildren(); this.popover.setAttribute('aria-label', `${provider === 'Claude' ? 'Claude Code' : provider} account and quota`);
    const heading = node('header', undefined, 'account-popover-heading'); heading.append(node('strong', `${provider === 'Claude' ? 'Claude Code' : provider} account`));
    const refresh = node('button', undefined, 'icon-button'); refresh.type = 'button'; refresh.title = 'Refresh account and quota'; refresh.setAttribute('aria-label', refresh.title); refresh.dataset.accountRefresh = ''; refresh.disabled = status?.status === 'loading'; refresh.append(node('span', undefined, 'codicon codicon-refresh')); refresh.onclick = () => this.refresh(provider);
    const close = node('button', undefined, 'icon-button account-close'); close.type = 'button'; close.title = 'Close account details'; close.setAttribute('aria-label', close.title); close.append(node('span', undefined, 'codicon codicon-close')); close.onclick = () => this.close(true);
    heading.append(refresh, close); this.popover.append(heading);
    if (account) {
      this.popover.append(node('p', account.email || account.method, 'account-detail-identity'));
      this.popover.append(node('p', [account.plan ? planLabel(account.plan) : undefined, account.method, account.organization].filter(Boolean).join(' · '), 'account-detail-meta'));
    }
    if (status?.status === 'loading') this.popover.append(node('p', 'Updating account and quota…', 'account-detail-meta'));
    if (status?.error) this.popover.append(node('p', status.error, 'account-detail-meta'));
    for (const window of status?.quota?.windows ?? []) {
      const row = node('div', undefined, 'quota-window'), label = node('div', undefined, 'quota-window-heading');
      label.append(node('span', window.label), node('span', remaining(window))); row.append(label);
      const meter = node('progress'); meter.max = 100; meter.value = Math.max(0, 100 - window.usedPercent); meter.setAttribute('aria-label', `${window.label} quota remaining`); meter.dataset.low = String(window.usedPercent >= 90);
      row.append(meter, node('span', resetLabel(window), 'account-detail-meta')); this.popover.append(row);
    }
    if (status?.quota?.credits) this.popover.append(node('p', status.quota.credits, 'account-detail-meta'));
    if (status?.quota?.detail) this.popover.append(node('p', status.quota.detail, 'account-detail-meta'));
    if (status?.updatedAt) this.popover.append(node('p', `Updated ${new Date(status.updatedAt).toLocaleTimeString()}`, 'account-detail-meta account-updated'));
    this.position();
  }
  private position() {
    if (this.popover.hidden) return;
    const anchor = this.root.getBoundingClientRect(), bounds = this.popover.getBoundingClientRect();
    this.popover.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`;
    this.popover.style.top = `${Math.max(8, anchor.top - bounds.height - 6)}px`;
  }
}
