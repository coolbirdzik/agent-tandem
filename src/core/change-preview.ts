import { createTwoFilesPatch } from 'diff';
import { decodeText, type HistoryStore } from './history';
import type { FileChange, Session } from './types';
export interface Selection { sessionId: string; stepId: string; file?: string }
export interface ChangePreview {
  selection: Selection; cumulative: boolean; title: string; files: FileChange[]; output: string;
  file?: { change: FileChange; before: string; after: string; patch?: string; notice?: string };
}
export async function readChangePreview(history: HistoryStore, sessions: Session[], selected: Selection, cumulative: boolean): Promise<ChangePreview> {
  const session = sessions.find(item => item.id === selected.sessionId);
  const step = session?.steps.find(item => item.id === selected.stepId);
  if (!session || !step?.after) throw new Error('This step has no complete after-snapshot.');
  const beforeId = cumulative ? session.baseline : step.before;
  const files = await history.changes(beforeId, step.after);
  const change = selected.file ? files.find(file => file.path === selected.file) : files[0];
  if (selected.file && !change) throw new Error('This file has no changes at the selected step.');
  const preview: ChangePreview = { selection: selected, cumulative, title: `${cumulative ? 'Cumulative' : 'Step'} · ${step.title}`, files, output: step.output };
  if (!change) return preview;
  const [left, right] = await Promise.all([change.before ? history.readBlob(change.before) : Buffer.alloc(0), change.after ? history.readBlob(change.after) : Buffer.alloc(0)]);
  const before = decodeText(left), after = decodeText(right);
  const metadata = (bytes: Buffer) => `${bytes.length} bytes`;
  if (before === undefined || after === undefined) {
    preview.file = { change, before: metadata(left), after: metadata(right), notice: 'Binary file · snapshots are preserved; showing sizes.' };
  } else if (left.length + right.length > 512 * 1024) {
    preview.file = { change, before: metadata(left), after: metadata(right), notice: 'Large file · use Open diff in editor to inspect the complete snapshots.' };
  } else {
    const patch = createTwoFilesPatch(`before/${change.path}`, `after/${change.path}`, before, after, '', '', { context: 3, timeout: 1000 });
    preview.file = { change, before, after, patch, notice: patch === undefined ? 'Diff exceeded the inline calculation limit. Open diff in editor to compare the snapshots.' : undefined };
  }
  return preview;
}
