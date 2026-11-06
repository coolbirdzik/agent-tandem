/** Opens Windows Security at "Virus & threat protection settings", where Exclusions are managed. */
export const windowsSecurityUrl = 'windowsdefender://threatsettings';

/** Folder-only exclusion for Microsoft Defender. It needs an administrator PowerShell window. */
export function antivirusExclusionCommand(folder: string): string {
  return `Add-MpPreference -ExclusionPath '${folder.replace(/'/g, "''")}'`;
}

export type AntivirusTipAction = 'copyPath' | 'copyCommand' | 'openSecurity' | 'dismiss';
export const antivirusTipActions: readonly AntivirusTipAction[] = ['copyPath', 'copyCommand', 'openSecurity', 'dismiss'];

/** Real-time scanning of the many small snapshot files is a Windows concern; other platforms get no tip. */
export function antivirusTip(platform: string, folder: string, dismissed: unknown): { path: string; dismissed: boolean } | undefined {
  return platform === 'win32' ? { path: folder, dismissed: dismissed === true } : undefined;
}
