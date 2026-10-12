export function marketplaceManifest(source, { publisher = source.publisher, repositoryUrl } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(publisher ?? '')) throw new Error('Provide a valid Marketplace publisher ID.');
  const manifest = structuredClone(source);
  manifest.publisher = publisher;
  delete manifest.private;
  delete manifest.enabledApiProposals;
  delete manifest.enableProposedApi;
  delete manifest.scripts;
  delete manifest.devDependencies;
  // All runtime dependencies are bundled by build.mjs.
  delete manifest.dependencies;
  delete manifest.contributes.menus['editor/content'];
  delete manifest.contributes.menus['multiDiffEditor/content'];
  manifest.contributes.menus['editor/title'] = [
    ...manifest.contributes.menus['editor/title'] ?? [],
    ...['previous', 'next'].map((direction, index) => ({
      command: `agentTandem.${direction}Change`, when: 'agentTandem.changeNavigation', group: `navigation@${index + 1}`,
    })),
  ];
  const settings = manifest.contributes.configuration.properties;
  settings['agentTandem.blockActionsStyle'].default = 'lens';
  settings['agentTandem.blockActionsStyle'].enumDescriptions[0] = 'Use the available review controls; the Marketplace build uses CodeLens.';
  settings['agentTandem.blockActionsStyle'].description = 'Show Accept, Reject and Next change actions above pending diff blocks using CodeLens.';
  settings['agentTandem.showFileCounterInEditor'].default = false;
  settings['agentTandem.showFileCounterInEditor'].description = 'Experimental local-build option. In the Marketplace build, use the file counter in the status bar to choose a changed file.';
  if (repositoryUrl) {
    const url = new URL(repositoryUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !/^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname)) {
      throw new Error('repositoryUrl must be an HTTPS GitHub repository URL.');
    }
    const clean = repositoryUrl.replace(/\/$/, '').replace(/\.git$/, '');
    manifest.repository = { type: 'git', url: `${clean}.git` };
    manifest.homepage = `${clean}#readme`;
    manifest.bugs = { url: `${clean}/issues` };
  }
  return manifest;
}
