import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { trackingStatus } from '../src/core/tracking-status';
import type { ViewState } from '../src/core/types';
import { TrackingStatusBar } from '../src/host/tracking-status-bar';

const item = vi.hoisted(() => ({ show: vi.fn(), dispose: vi.fn() }));
vi.mock('vscode', () => ({
  window: { createStatusBarItem: () => item },
  workspace: { isTrusted: true },
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class {},
  MarkdownString: class {
    constructor(public value: string, public supportThemeIcons: boolean) {}
    appendMarkdown(text: string) { this.value += text; return this; }
  },
}));

describe('Tracking status bar', () => {
  it('explains availability and loading without claiming tracking is on', () => {
    expect(trackingStatus(undefined, true).text).toContain('unavailable');
    expect(trackingStatus('/project', false).hover.scope).toContain('Trust');
    expect(trackingStatus('/project', true).text).toContain('Review…');
  });
  it('shows the saved mode, pending count and capture activity', () => {
    const review = { revision: 'r', busy: false, externalTracking: true, files: [{ path: 'a', kind: 'added' as const, binary: false }] };
    expect(trackingStatus('/project', true, review)).toMatchObject({ active: true, text: '$(diff) Review · 1 file' });
    expect(trackingStatus('/project', true, review).hover).toMatchObject({
      title: '1 file pending review', workspace: '/project', scope: expect.stringContaining('manual edits'),
    });
    expect(trackingStatus('/project', true, { ...review, externalTracking: false }).text).toContain('Review · 1 file');
    expect(trackingStatus('/project', true, review, true).text).toContain('sync~spin');
  });
  it('puts the review action above workspace details and renders paths and notices literally', () => {
    const bar = new TrackingStatusBar();
    bar.update({ project: '/my [project]', review: { revision: 'r', busy: false, externalTracking: true,
      files: [{ path: 'a', kind: 'added', binary: false }], notice: 'Skipped file $(zap) <test>.' },
    } as ViewState);
    const status = vi.mocked(vscode.window.createStatusBarItem)();
    expect(status.tooltip).toMatchObject({ supportThemeIcons: true });
    expect((status.tooltip as vscode.MarkdownString).value.split('\n\n')).toEqual([
      '$(diff) **1 file pending review**',
      'Click to review workspace changes.',
      '---',
      '**Workspace**  \n/my &#91;project&#93;',
      expect.stringMatching(/^\*\*Change tracking\*\*/),
      'Skipped file &#36;&#40;zap&#41; &#60;test&#62;&#46;',
      'Tracking controls are in the Review view.',
    ]);
    expect(status.accessibilityInformation?.label).toContain('Skipped file $(zap) <test>.');
    expect(status.command).toBe('agentTandem.reviewLatest');
  });
});
