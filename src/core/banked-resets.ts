import type { BankedResets } from '../providers/account-status';

export function bankedResetCountdown(expiresAt: number, now = Date.now()): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return 'Expired';
  if (remaining < 60000) return '<1m left';
  const totalMinutes = Math.floor(remaining / 60000);
  const days = Math.floor(totalMinutes / 1440), hours = Math.floor(totalMinutes % 1440 / 60), minutes = totalMinutes % 60;
  if (days) return `${days}d${hours ? ` ${hours}h` : ''} left`;
  if (hours) return `${hours}h${minutes ? ` ${minutes}m` : ''} left`;
  return `${minutes}m left`;
}

/** Shared display text for quota surfaces and status-bar hover. */
export function bankedResetDetails(resets: BankedResets | undefined, now = Date.now()): string[] {
  if (!resets) return [];
  const lines = [`Banked resets: ${resets.availableCount} available`];
  if (!resets.availableCount) return lines;
  for (const credit of resets.credits ?? []) {
    lines.push(`${credit.title || 'Banked reset'} · ${credit.expiresAt ? `Expires ${new Date(credit.expiresAt).toLocaleString()} · ${bankedResetCountdown(credit.expiresAt, now)}` : 'Expiry unavailable'}`);
  }
  if (!resets.credits?.length) lines.push('Expiry details unavailable');
  else if (resets.credits.length < resets.availableCount) lines.push('Expiry details shown for some resets');
  return lines;
}
