$ErrorActionPreference = 'Stop'
# Only the named native Antigravity credential is accessible through this bridge.
# Requests and secrets use stdin/stdout; error output never contains the payload.
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AntigravityCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr ptr);
  [DllImport("advapi32", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref Credential value, UInt32 flags);
  [DllImport("advapi32", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32")] public static extern void CredFree(IntPtr ptr);
}
'@
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $target = 'gemini:antigravity'
  $result = $null
  switch ($request.action) {
    'read' {
      $ptr = [IntPtr]::Zero
      if ([AntigravityCredential]::CredRead($target, 1, 0, [ref]$ptr)) {
        try {
          $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][AntigravityCredential+Credential])
          $bytes = New-Object byte[] $credential.CredentialBlobSize
          [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
          $result = [Text.Encoding]::UTF8.GetString($bytes)
        } finally { [AntigravityCredential]::CredFree($ptr) }
      } elseif ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'Credential read failed' }
    }
    'write' {
      if (-not ($request.value | ConvertFrom-Json).token.refresh_token) { throw 'Invalid credential' }
      $bytes = [Text.Encoding]::UTF8.GetBytes([string]$request.value)
      $ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
      try {
        [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
        $credential = New-Object AntigravityCredential+Credential
        $credential.Type = 1; $credential.TargetName = $target; $credential.UserName = 'antigravity'; $credential.Persist = 2
        $credential.CredentialBlob = $ptr; $credential.CredentialBlobSize = $bytes.Length
        if (-not [AntigravityCredential]::CredWrite([ref]$credential, 0)) { throw 'Credential write failed' }
      } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr) }
    }
    'remove' { if (-not [AntigravityCredential]::CredDelete($target, 1, 0) -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'Credential removal failed' } }
    default { throw 'Invalid operation' }
  }
  [Console]::Out.Write((@{value=$result} | ConvertTo-Json -Compress))
} catch { [Console]::Error.Write('Antigravity credential operation failed.'); exit 1 }
