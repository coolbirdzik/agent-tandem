import { describe, expect, it } from 'vitest';
import { antivirusExclusionCommand, antivirusTip, windowsSecurityUrl } from '../src/core/antivirus';

describe('antivirus exclusion tip', () => {
  it('is offered on Windows only and carries the acknowledgement', () => {
    expect(antivirusTip('win32', 'C:\\data', undefined)).toEqual({ path: 'C:\\data', dismissed: false });
    expect(antivirusTip('win32', 'C:\\data', true)).toEqual({ path: 'C:\\data', dismissed: true });
    expect(antivirusTip('win32', 'C:\\data', 'yes')).toEqual({ path: 'C:\\data', dismissed: false });
    expect(antivirusTip('darwin', '/data', undefined)).toBeUndefined();
    expect(antivirusTip('linux', '/data', undefined)).toBeUndefined();
  });
  it('builds a single-quoted PowerShell command that survives quotes in the folder name', () => {
    expect(antivirusExclusionCommand('C:\\Users\\An\\AppData\\Roaming\\Code\\User\\globalStorage\\agent-tandem'))
      .toBe("Add-MpPreference -ExclusionPath 'C:\\Users\\An\\AppData\\Roaming\\Code\\User\\globalStorage\\agent-tandem'");
    expect(antivirusExclusionCommand("C:\\O'Brien\\$data")).toBe("Add-MpPreference -ExclusionPath 'C:\\O''Brien\\$data'");
  });
  it('opens the Windows Security threat settings page', () => {
    expect(windowsSecurityUrl).toBe('windowsdefender://threatsettings');
  });
});
