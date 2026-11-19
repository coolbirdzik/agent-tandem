import type { ReviewState } from './review';

export function trackingStatus(project: string | undefined, trusted: boolean, review?: ReviewState, busy = false) {
  const count = review?.files.length ?? 0;
  const files = `${count} ${count === 1 ? 'file' : 'files'}`;
  const scope = !project ? 'Open a local workspace to track changes.' : !trusted ? 'Trust this workspace to track saved changes.' : !review ? 'Preparing the workspace baseline.' : review.externalTracking ? 'Saved changes from Codex, Claude, AgentTandem and manual edits are tracked.' : 'Tracking is paused for this workspace. Pending changes remain available.';
  const title = count ? `${files} pending review` : !project || !trusted ? 'Tracking unavailable' : !review ? 'Preparing change tracking' : 'No files pending review';
  const action = count ? 'Click to review workspace changes.' : review?.undo ? 'Click to open Review and undo the last revert.' : 'Click to open tracking options.';
  return {
    text: !project || !trusted ? '$(eye-closed) Tracking unavailable' : !review || busy || review.busy ? '$(sync~spin) Review…' : count ? `$(diff) Review · ${files}` : review.undo ? '$(history) Review · Undo' : review.externalTracking ? '$(eye) Tracking on' : '$(eye-closed) Tracking off',
    hover: { title, action, workspace: project, scope, notice: review?.notice, controls: count ? 'Tracking controls are in the Review view.' : undefined },
    active: !!project && trusted && !!review?.externalTracking,
  };
}
