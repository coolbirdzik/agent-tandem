export const shortcuts = {
  focusChat: 'mod+k mod+shift+t',
  newChat: 'mod+k mod+shift+n',
  history: 'mod+k mod+shift+h',
  chooseFile: 'mod+k mod+shift+j',
  quickAccounts: 'mod+k mod+shift+a',
  accept: 'alt+y',
  reject: 'alt+n',
  previous: 'alt+up',
  next: 'alt+down',
  previousFile: 'alt+pageup',
  nextFile: 'alt+pagedown',
  save: 'mod+s',
  send: 'enter',
  newline: 'shift+enter',
} as const;

type Shortcut = typeof shortcuts[keyof typeof shortcuts];
const names: Record<string, string> = { alt: 'Alt', mod: 'Ctrl', shift: 'Shift', up: 'Up', down: 'Down', pageup: 'Page Up', pagedown: 'Page Down', enter: 'Enter' };
const macNames: Record<string, string> = { alt: '⌥', mod: '⌘', shift: '⇧', up: '↑', down: '↓', pageup: '⇞', pagedown: '⇟', enter: '↩' };
const supported = new Set<string>(Object.values(shortcuts));

export const isMacKeyboard = (platform: string) => /^(mac|iphone|ipad)/i.test(platform);

/** Use the renderer's platform because the extension host can be remote. */
export function shortcutMarkup(shortcut: string, mac: boolean): string {
  if (!supported.has(shortcut)) return '';
  const chords = shortcut.split(' ').map(chord => chord.split('+'));
  const label = chords.map(keys => keys.map(key => mac && key === 'mod' ? 'Command' : mac && key === 'alt' ? 'Option' : names[key] ?? key.toUpperCase()).join('+')).join(', then ');
  return `<span class="tandem-keybinding" role="img" aria-label="${label}">${chords.map(keys =>
    `<span class="tandem-keybinding-chord" aria-hidden="true">${keys.map(key => `<kbd>${(mac ? macNames[key] : undefined) ?? names[key] ?? key.toUpperCase()}</kbd>`).join(mac ? '' : '<span>+</span>')}</span>`,
  ).join('')}</span>`;
}

export function shortcutAttributes(shortcut: Shortcut, alternative?: Shortcut): string {
  return `data-shortcut="${shortcut}"${alternative ? ` data-shortcut-alternative="${alternative}"` : ''}`;
}
