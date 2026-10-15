import { describe, expect, it } from 'vitest';
import { trackingStatus } from '../src/core/tracking-status';

describe('Tracking status bar', () => {
  it('explains availability and loading without claiming tracking is on', () => {
    expect(trackingStatus(undefined, true).text).toContain('unavailable');
    expect(trackingStatus('/project', false).tooltip).toContain('Trust');
    expect(trackingStatus('/project', true).text).toContain('Review…');
  });
  it('shows the saved mode, pending count and capture activity', () => {
    const review = { revision: 'r', busy: false, externalTracking: true, files: [{ path: 'a', kind: 'added' as const, binary: false }] };
    expect(trackingStatus('/project', true, review)).toMatchObject({ active: true, text: '$(diff) Review · 1 file' });
    expect(trackingStatus('/project', true, review).tooltip).toContain('manual edits');
    expect(trackingStatus('/project', true, review).tooltip).toContain('Workspace: /project');
    expect(trackingStatus('/project', true, review).tooltip).toContain('all pending changes in this workspace');
    expect(trackingStatus('/project', true, { ...review, externalTracking: false }).text).toContain('Review · 1 file');
    expect(trackingStatus('/project', true, review, true).text).toContain('sync~spin');
  });
});
