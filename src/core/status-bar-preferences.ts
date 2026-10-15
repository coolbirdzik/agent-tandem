export const STATUS_BAR_PROVIDERS = ['both', 'active', 'codex', 'claude'] as const;
export const STATUS_BAR_FIELDS = ['quota', 'reset', 'bankedResets', 'account', 'plan'] as const;
export type StatusBarProviderMode = typeof STATUS_BAR_PROVIDERS[number];
export type StatusBarField = typeof STATUS_BAR_FIELDS[number];
export type StatusBarStyle = 'compact' | 'progress' | 'icons' | 'text';
export interface StatusBarPreferences {
  providers: StatusBarProviderMode;
  fields: StatusBarField[];
  quotaWindows: 'all' | 'main';
  alignment: 'left' | 'right';
  style: StatusBarStyle;
}
export const STATUS_BAR_CONFIGURATION = {
  providers: 'statusBarProviders', fields: 'statusBarFields', quotaWindows: 'statusBarQuotaWindows', alignment: 'statusBarAlignment', style: 'statusBarStyle',
} as const;
export function statusBarPreferences(value: Partial<StatusBarPreferences> = {}): StatusBarPreferences {
  return {
    providers: STATUS_BAR_PROVIDERS.includes(value.providers!) ? value.providers! : 'both',
    fields: Array.isArray(value.fields) ? [...new Set(value.fields.filter(field => STATUS_BAR_FIELDS.includes(field)))] : ['quota', 'bankedResets'],
    quotaWindows: value.quotaWindows === 'main' ? 'main' : 'all',
    alignment: value.alignment === 'left' ? 'left' : 'right',
    style: value.style === 'progress' || value.style === 'icons' || value.style === 'text' ? value.style : 'compact',
  };
}
/** Validate every setting before any preference is persisted. */
export function statusBarPreferenceChanges(value: unknown): Array<{ key: string; value: unknown }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid status bar preferences.');
  return Object.entries(value).map(([key, field]) => {
    const valid = key === 'providers' ? STATUS_BAR_PROVIDERS.includes(field as StatusBarProviderMode)
      : key === 'fields' ? Array.isArray(field) && field.every(item => STATUS_BAR_FIELDS.includes(item))
      : key === 'quotaWindows' ? ['all', 'main'].includes(field as string)
      : key === 'alignment' ? ['left', 'right'].includes(field as string)
      : key === 'style' ? ['compact', 'progress', 'icons', 'text'].includes(field as string) : false;
    if (!valid) throw new Error(`Invalid status bar preference: ${key}.`);
    return { key: STATUS_BAR_CONFIGURATION[key as keyof typeof STATUS_BAR_CONFIGURATION], value: key === 'fields' ? [...new Set(field as StatusBarField[])] : field };
  });
}
