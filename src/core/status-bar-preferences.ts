export const STATUS_BAR_PROVIDERS = ['both', 'active', 'codex', 'claude'] as const;
export const STATUS_BAR_FIELDS = ['quota', 'reset', 'bankedResets', 'account', 'plan'] as const;
export const STATUS_BAR_STYLES = ['compact', 'progress', 'rings', 'minimal', 'icons', 'text'] as const;
/** Theme colors offered for agent text (they follow the color theme); any #RRGGBB works too. '' keeps the quota status color. */
export const STATUS_BAR_THEME_COLORS = ['statusBar.foreground', 'charts.blue', 'charts.green', 'charts.orange', 'charts.purple', 'charts.red', 'charts.yellow'] as const;
export const isStatusBarColor = (value: unknown): value is string => typeof value === 'string' && (value === '' || STATUS_BAR_THEME_COLORS.includes(value as typeof STATUS_BAR_THEME_COLORS[number]) || /^#[0-9a-f]{6}$/i.test(value));
export type StatusBarProviderMode = typeof STATUS_BAR_PROVIDERS[number];
export type StatusBarField = typeof STATUS_BAR_FIELDS[number];
export type StatusBarStyle = typeof STATUS_BAR_STYLES[number];
export interface StatusBarPreferences {
  providers: StatusBarProviderMode;
  fields: StatusBarField[];
  quotaWindows: 'all' | 'main';
  alignment: 'left' | 'right';
  style: StatusBarStyle;
  codexColor: string;
  claudeColor: string;
}
export const STATUS_BAR_CONFIGURATION = {
  providers: 'statusBarProviders', fields: 'statusBarFields', quotaWindows: 'statusBarQuotaWindows', alignment: 'statusBarAlignment', style: 'statusBarStyle',
  codexColor: 'statusBarCodexColor', claudeColor: 'statusBarClaudeColor',
} as const;
export function statusBarPreferences(value: Partial<StatusBarPreferences> = {}): StatusBarPreferences {
  return {
    providers: STATUS_BAR_PROVIDERS.includes(value.providers!) ? value.providers! : 'both',
    fields: Array.isArray(value.fields) ? [...new Set(value.fields.filter(field => STATUS_BAR_FIELDS.includes(field)))] : ['quota', 'bankedResets'],
    quotaWindows: value.quotaWindows === 'main' ? 'main' : 'all',
    alignment: value.alignment === 'left' ? 'left' : 'right',
    style: STATUS_BAR_STYLES.includes(value.style!) ? value.style! : 'compact',
    codexColor: isStatusBarColor(value.codexColor) ? value.codexColor : '',
    claudeColor: isStatusBarColor(value.claudeColor) ? value.claudeColor : '',
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
      : key === 'style' ? STATUS_BAR_STYLES.includes(field as StatusBarStyle)
      : key === 'codexColor' || key === 'claudeColor' ? isStatusBarColor(field) : false;
    if (!valid) throw new Error(`Invalid status bar preference: ${key}.`);
    return { key: STATUS_BAR_CONFIGURATION[key as keyof typeof STATUS_BAR_CONFIGURATION], value: key === 'fields' ? [...new Set(field as StatusBarField[])] : field };
  });
}
