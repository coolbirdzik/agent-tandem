import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { marketplaceManifest } from '../scripts/marketplace-manifest.mjs';

const source = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
describe('Marketplace packaging', () => {
  it('uses stable review contributions without modifying the local development manifest', () => {
    const original = structuredClone(source);
    const result = marketplaceManifest(source, { publisher: 'my-publisher' });
    expect(source).toEqual(original);
    expect(result.publisher).toBe('my-publisher');
    expect(result.extensionKind).toEqual(['workspace']);
    expect(result).not.toHaveProperty('enabledApiProposals');
    expect(result).not.toHaveProperty('enableProposedApi');
    expect(result.contributes.menus).not.toHaveProperty('editor/content');
    expect(result.contributes.menus).not.toHaveProperty('multiDiffEditor/content');
    expect(result.contributes.menus['editor/title'].map(item => item.command)).toContain('agentTandem.nextChange');
    for (const command of ['agentTandem.previousFile', 'agentTandem.nextFile', 'agentTandem.chooseChangedFile']) {
      expect(source.contributes.menus['editor/title'].filter(item => item.command === command)).toHaveLength(1);
      expect(result.contributes.menus['editor/title'].filter(item => item.command === command)).toHaveLength(1);
    }
    expect(result.contributes.configuration.properties['agentTandem.blockActionsStyle'].default).toBe('lens');
    expect(result.contributes.configuration.properties['agentTandem.reviewEditor'].default).toBe('webview');
    expect(source.contributes.configuration.properties['agentTandem.blockActionsStyle'].default).toBe('lens');
    expect(result.contributes.configuration.properties['agentTandem.reviewEditor']).toEqual(source.contributes.configuration.properties['agentTandem.reviewEditor']);
    expect(result.contributes.configuration.properties['agentTandem.showFileCounterInEditor'].default).toBe(false);
    expect(result).not.toHaveProperty('scripts');
    expect(result).not.toHaveProperty('dependencies');
  });
  it('sets public content URLs and rejects invalid publisher or repository values', () => {
    const result = marketplaceManifest(source, { repositoryUrl: 'https://github.com/example/agent-tandem.git/' });
    expect(result.repository.url).toBe('https://github.com/example/agent-tandem.git');
    expect(result.bugs.url).toBe('https://github.com/example/agent-tandem/issues');
    expect(() => marketplaceManifest(source, { publisher: 'Display Name' })).toThrow();
    expect(() => marketplaceManifest(source, { repositoryUrl: 'http://github.com/example/agent-tandem' })).toThrow();
    expect(() => marketplaceManifest(source, { repositoryUrl: 'https://example.com/repo' })).toThrow();
  });
});
