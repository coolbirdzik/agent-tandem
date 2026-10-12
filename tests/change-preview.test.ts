import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../src/core/history';
import { readChangePreview } from '../src/core/change-preview';
import type { Session } from '../src/core/types';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(before: Uint8Array, after: Uint8Array) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdock-preview-')); roots.push(root);
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const history = new HistoryStore(path.join(root, 'history'));
  await writeFile(path.join(workspace, 'file.ts'), before); const baseline = await history.capture(workspace);
  await writeFile(path.join(workspace, 'file.ts'), after); const snapshot = await history.capture(workspace);
  const id = randomUUID(), stepId = randomUUID();
  const session: Session = { version: 1, id, title: 'Fixture', source: 'demo', createdAt: new Date().toISOString(), status: 'completed', baseline: baseline.id,
    steps: [{ id: stepId, title: 'Edit', before: baseline.id, after: snapshot.id, status: 'completed', changes: await history.changes(baseline.id, snapshot.id), output: 'Saved', captureMode: 'exact' }] };
  return { history, workspace, session, selected: { sessionId: id, stepId } };
}
describe('Inline snapshot review', () => {
  it('generates a correct patch from saved snapshots even after live files change', async () => {
    const f = await fixture(Buffer.from('const value = 1;\n'), Buffer.from('const value = 2;\n'));
    await writeFile(path.join(f.workspace, 'file.ts'), 'unrelated current contents');
    const preview = await readChangePreview(f.history, [f.session], f.selected, false);
    expect(preview.file?.before).toBe('const value = 1;\n'); expect(preview.file?.after).toBe('const value = 2;\n');
    expect(preview.file?.patch).toContain('-const value = 1;'); expect(preview.file?.patch).toContain('+const value = 2;');
    expect(preview.output).toBe('Saved');
  });
  it('shows binary sizes rather than inventing a text diff', async () => {
    const f = await fixture(Buffer.from([0, 1]), Buffer.from([0, 2, 3]));
    const preview = await readChangePreview(f.history, [f.session], f.selected, false);
    expect(preview.file?.notice).toContain('Binary'); expect(preview.file?.patch).toBeUndefined();
    expect(preview.file?.before).toBe('2 bytes'); expect(preview.file?.after).toBe('3 bytes');
  });
  it('bounds inline text computation for large files while preserving editor snapshots', async () => {
    const f = await fixture(Buffer.from('a'.repeat(300_000)), Buffer.from('b'.repeat(300_000)));
    const preview = await readChangePreview(f.history, [f.session], f.selected, false);
    expect(preview.file?.notice).toContain('Large file'); expect(preview.file?.patch).toBeUndefined();
    expect((await f.history.readSnapshotFile(f.session.steps[0]!.after!, 'file.ts')).length).toBe(300_000);
  });
  it('rejects unrelated file selection and incomplete steps', async () => {
    const f = await fixture(Buffer.from('a'), Buffer.from('b'));
    await expect(readChangePreview(f.history, [f.session], { ...f.selected, file: 'outside.ts' }, false)).rejects.toThrow(/no changes/);
    f.session.steps[0]!.after = undefined;
    await expect(readChangePreview(f.history, [f.session], f.selected, false)).rejects.toThrow(/no complete after/);
  });
});
