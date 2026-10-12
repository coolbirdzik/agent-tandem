import type { ReviewState } from './review';

export function trackingStatus(project: string | undefined, trusted: boolean, review?: ReviewState, busy = false) {
  const count = review?.files.length ?? 0;
  const scope = !project ? 'Open a local workspace to track changes.' : !trusted ? 'Trust this workspace to track saved changes.' : !review ? 'Preparing the workspace baseline.' : review.externalTracking ? 'Saved changes from Codex, Claude, AgentDock and manual edits are tracked.' : 'Tracking is paused for this workspace. Pending changes remain available.';
  return {
    text: !project || !trusted ? '$(eye-closed) Tracking unavailable' : !review || busy || review.busy ? '$(sync~spin) Review…' : count ? `$(diff) Review · ${count} ${count === 1 ? 'file' : 'files'}` : review.undo ? '$(history) Review · Undo' : review.externalTracking ? '$(eye) Tracking on' : '$(eye-closed) Tracking off',
    tooltip: `${scope}${review?.notice ? `\n${review.notice}` : ''}\n${count} ${count === 1 ? 'file' : 'files'} pending review.\n${count ? 'Click to open the latest conversation changes in the editor. Tracking controls are in the Review view.' : review?.undo ? 'Click to open Review and Undo the last Revert.' : 'Click to pause/resume tracking or open the getting started guide.'}`,
    active: !!project && trusted && !!review?.externalTracking,
  };
}
