import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { joinPath: (base: unknown, ...parts: string[]) => ({ base, path: parts.join('/') }) },
}));
import { webviewResource } from '../src/host/webview-resource';

function resourceUri(authority: string, scheme = 'https') {
  return {
    scheme, authority,
    with: (change: { authority: string }) => resourceUri(change.authority, scheme),
    toString: () => `${scheme}://${authority}/root/extensions/agent/media/panel.css?version=1#asset`,
  };
}

describe('remote webview resources', () => {
  it.each(['wsl+Debian', 'wsl+Ubuntu-24.04', 'ssh-remote+MyHost'])('preserves %s through browser hostname normalization and VS Code decoding', remote => {
    const encoded = remote.replace(/[^a-z0-9]/gi, char => `-${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const uri = resourceUri(`vscode-remote+${encoded}.vscode-resource.vscode-cdn.net`);
    const asWebviewUri = vi.fn(() => uri);
    const url = new URL(webviewResource({ asWebviewUri } as any, {} as any, 'media', 'panel.css'));
    const authority = url.hostname.slice('vscode-remote+'.length).split('.vscode-resource.')[0]!;
    expect(authority.replace(/-([0-9a-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))).toBe(remote);
    expect(url.pathname).toBe('/root/extensions/agent/media/panel.css');
    expect(url.search).toBe('?version=1');
    expect(url.hash).toBe('#asset');
    expect(asWebviewUri).toHaveBeenCalledWith({ base: {}, path: 'media/panel.css' });
  });

  it('keeps local, CDN and already encoded remote resources unchanged', () => {
    for (const authority of ['file+.vscode-resource.vscode-cdn.net', 'cdn.example.com', 'vscode-remote+wsl-002b-0044ebian.vscode-resource.vscode-cdn.net']) {
      const uri = resourceUri(authority);
      expect(webviewResource({ asWebviewUri: () => uri } as any, {} as any, 'media', 'panel.css')).toBe(uri.toString());
    }
  });
});
