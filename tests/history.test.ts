import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPath, decodeText, HistoryStore } from '../src/core/history';
import { StepRecorder } from '../src/core/recorder';
import { runDemo } from '../src/core/demo';
import type { Session } from '../src/core/types';

const directories: string[] = [];
async function fixture(maxBytes?: number) {
  const parent = await mkdtemp(path.join(tmpdir(), 'agent-dock-test-')); directories.push(parent);
  const root = path.join(parent, 'work'); await mkdir(root);
  const history = new HistoryStore(path.join(parent, 'history'), maxBytes);
  await writeFile(path.join(root, 'login.ts'), 'return value.length > 0;\r\n');
  const baseline = await history.capture(root);
  const session: Session = { version: 1, id: randomUUID(), title: 'Test', source: 'demo', createdAt: new Date().toISOString(), status: 'running', baseline: baseline.id, steps: [] };
  return { parent, root, history, session, recorder: new StepRecorder(history, root, session) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('immutable step snapshots', () => {
  it('keeps 0 → 1 and 1 → 2 when the same file changes twice', async () => {
    const { root, history, recorder } = await fixture();
    const first = await recorder.record('trim', () => writeFile(path.join(root, 'login.ts'), 'return value.trim().length > 0;\r\n'));
    const second = await recorder.record('length', () => writeFile(path.join(root, 'login.ts'), 'return value.trim().length >= 3;\r\n'));
    expect((await history.readSnapshotFile(first.before, 'login.ts')).toString()).toBe('return value.length > 0;\r\n');
    expect((await history.readSnapshotFile(first.after!, 'login.ts')).toString()).toBe('return value.trim().length > 0;\r\n');
    expect((await history.readSnapshotFile(second.before, 'login.ts')).toString()).toBe('return value.trim().length > 0;\r\n');
    expect((await history.readSnapshotFile(second.after!, 'login.ts')).toString()).toBe('return value.trim().length >= 3;\r\n');
    expect(first.changes.map(change => change.kind)).toEqual(['modified']);
  });

  it('distinguishes own-step changes from cumulative changes', async () => {
    const { root, history, recorder, session } = await fixture();
    await recorder.record('first', () => writeFile(path.join(root, 'login.ts'), 'trim'));
    const second = await recorder.record('new file', () => writeFile(path.join(root, 'new.ts'), 'test'));
    expect(second.changes.map(change => change.path)).toEqual(['new.ts']);
    expect((await history.changes(session.baseline, second.after!)).map(change => change.path)).toEqual(['login.ts', 'new.ts']);
  });

  it('captures added and deleted files including empty files', async () => {
    const { root, recorder } = await fixture();
    const added = await recorder.record('add', () => writeFile(path.join(root, 'empty.ts'), ''));
    expect(added.changes[0]).toMatchObject({ path: 'empty.ts', kind: 'added', binary: false });
    const deleted = await recorder.record('delete', () => unlink(path.join(root, 'login.ts')));
    expect(deleted.changes[0]).toMatchObject({ path: 'login.ts', kind: 'deleted' });
  });

  it('preserves Unicode paths, UTF-8 BOM and CRLF bytes', async () => {
    const { root, history, recorder } = await fixture();
    const bytes = Buffer.from('\ufeffHello 🌍\r\n');
    const step = await recorder.record('unicode', () => writeFile(path.join(root, 'file name 🌍.ts'), bytes));
    expect(await history.readSnapshotFile(step.after!, 'file name 🌍.ts')).toEqual(bytes);
    expect(decodeText(bytes)).toBe('\ufeffHello 🌍\r\n');
  });

  it('captures binary bytes without coercing them into text', async () => {
    const { root, recorder, history } = await fixture();
    const bytes = Buffer.from([0, 255, 13, 10]);
    const step = await recorder.record('binary', () => writeFile(path.join(root, 'file.bin'), bytes));
    expect(step.changes[0]?.binary).toBe(true);
    expect(await history.readSnapshotFile(step.after!, 'file.bin')).toEqual(bytes);
  });

  it('records no changes for a read-only operation', async () => {
    const { root, recorder } = await fixture();
    const step = await recorder.record('read', async () => (await readFile(path.join(root, 'login.ts'))).toString());
    expect(step.changes).toEqual([]); expect(step.status).toBe('completed');
  });

  it('retains partial changes when an operation fails', async () => {
    const { root, recorder, history } = await fixture();
    const step = await recorder.record('failure', async () => { await writeFile(path.join(root, 'login.ts'), 'partial'); throw new Error('Tool failed'); });
    expect(step.status).toBe('failed'); expect(step.output).toBe('Tool failed');
    expect((await history.readSnapshotFile(step.after!, 'login.ts')).toString()).toBe('partial');
  });

  it('rejects a concurrent writer instead of claiming exact snapshots', async () => {
    const { recorder } = await fixture();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const first = recorder.record('slow', async () => { started(); await wait; });
    await ready;
    await expect(recorder.record('concurrent', async () => undefined)).rejects.toThrow('still writing');
    release(); await first;
  });

  it('records an interrupted operation and blocks the next one', async () => {
    const { root, recorder } = await fixture();
    const controller = new AbortController();
    const step = await recorder.record('stop', async () => { await writeFile(path.join(root, 'login.ts'), 'partial'); controller.abort(); }, controller.signal);
    expect(step.status).toBe('interrupted'); expect(step.changes).toHaveLength(1);
    await expect(recorder.record('next', async () => undefined, controller.signal)).rejects.toThrow();
  });

  it('reopens completed session history and blobs from disk', async () => {
    const { root, history, recorder, session } = await fixture();
    const step = await recorder.record('update', () => writeFile(path.join(root, 'login.ts'), 'updated'));
    session.status = 'completed'; await history.saveSession(session);
    const reopened = new HistoryStore(history.directory);
    expect((await reopened.sessions())[0]).toEqual(session);
    expect((await reopened.readSnapshotFile(step.after!, 'login.ts')).toString()).toBe('updated');
  });

  it('marks an unfinished session interrupted without inventing an after snapshot', async () => {
    const { history, session } = await fixture();
    session.steps.push({ id: randomUUID(), title: 'unfinished', status: 'running', before: session.baseline, output: '', changes: [], captureMode: 'exact' });
    await history.saveSession(session);
    const restored = (await history.sessions())[0]!;
    expect(restored.status).toBe('interrupted'); expect(restored.steps[0]?.after).toBeUndefined();
    expect(restored.steps[0]?.status).toBe('interrupted');
  });

  it('reports corrupt or missing blobs rather than showing current workspace data', async () => {
    const { root, recorder, history } = await fixture();
    const step = await recorder.record('change', () => writeFile(path.join(root, 'login.ts'), 'new'));
    const hash = step.changes[0]!.after!;
    await writeFile(path.join(history.directory, 'blobs', hash), 'corrupt');
    await expect(history.readSnapshotFile(step.after!, 'login.ts')).rejects.toThrow('corrupt');
    await unlink(path.join(history.directory, 'blobs', hash));
    await expect(history.readSnapshotFile(step.after!, 'login.ts')).rejects.toThrow();
  });

  it('fails before claiming a complete after snapshot when quota is exceeded', async () => {
    const { root, history, recorder, session } = await fixture(100);
    await expect(recorder.record('large', () => writeFile(path.join(root, 'large.ts'), 'x'.repeat(200)))).rejects.toThrow('limit');
    expect(session.status).toBe('failed'); expect(session.steps[0]?.after).toBeUndefined();
    expect((await history.sessions())[0]?.status).toBe('failed');
  });

  it('refuses links that escape the isolated fixture', async () => {
    const { parent, root, history } = await fixture();
    const outside = path.join(parent, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'secret.ts'), 'secret');
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(history.capture(root)).rejects.toThrow('Linked');
    expect((await readFile(path.join(outside, 'secret.ts'))).toString()).toBe('secret');
  });

  it('runs the actual isolated file demo and leaves other files untouched', async () => {
    const { parent, root, history } = await fixture();
    const controller = new AbortController();
    const states: string[] = [];
    const session = await runDemo(history, path.join(parent, 'demo'), controller.signal, value => states.push(value.status), 0);
    expect(session.status).toBe('completed'); expect(session.steps).toHaveLength(5);
    expect(session.steps.map(step => step.changes.length)).toEqual([0, 1, 2, 1, 0]);
    expect(states).toContain('running'); expect(states.at(-1)).toBe('completed');
    expect((await readFile(path.join(root, 'login.ts'))).toString()).toBe('return value.length > 0;\r\n');
  });
});

describe('snapshot inputs', () => {
  it('streams blobs beyond the demo quota, verifies copies and rejects corrupt duplicate blobs', async () => {
    const { root, history } = await fixture(32);
    const source = path.join(root, 'large.txt'), content = 'x'.repeat(1024 * 1024) + 'Hello 🌍';
    await writeFile(source, content);
    const hash = await history.putFileBlob(source);
    expect(await history.inspectBlob(hash)).toEqual({ size: Buffer.byteLength(content), binary: false, text: undefined });
    const restored = path.join(root, 'restored.txt'); await history.copyBlob(hash, restored);
    expect(await readFile(restored, 'utf8')).toBe(content);
    expect(await history.putFileBlob(source)).toBe(hash);
    expect(await Promise.all(Array.from({ length: 8 }, () => history.putFileBlob(source)))).toEqual(Array(8).fill(hash));
    await writeFile(path.join(history.directory, 'blobs', hash), 'corrupt');
    await expect(history.inspectBlob(hash)).rejects.toThrow('corrupt');
    await expect(history.putFileBlob(source)).rejects.toThrow('corrupt');
  });
  it('classifies streamed UTF-16 and incomplete UTF-8 correctly and supports cancellation', async () => {
    const { root, history } = await fixture(); const source = path.join(root, 'stream.txt');
    await writeFile(source, Buffer.from('\ufeffhello\r\n', 'utf16le'));
    expect(await history.inspectBlob(await history.putFileBlob(source))).toEqual({ size: 16, binary: false, text: 'hello\r\n' });
    await writeFile(source, Buffer.concat([Buffer.alloc(1024 * 1024, 120), Buffer.from([0xe2, 0x82])]));
    expect((await history.inspectBlob(await history.putFileBlob(source))).binary).toBe(true);
    const abort = new AbortController(); abort.abort();
    await expect(history.putFileBlob(source, abort.signal)).rejects.toThrow();
    expect((await readdir(path.join(history.directory, 'blobs'))).some(name => name.endsWith('.tmp'))).toBe(false);
  });
  it.each(['../file.ts', 'a/../b', '/absolute', 'a\\b', 'C:/file', 'a//b', 'a/./b', ''])('rejects unsafe path %s', value => {
    expect(() => assertPath(value)).toThrow();
  });
  it('distinguishes invalid text and supports UTF-16', () => {
    expect(decodeText(Buffer.from([0xff, 0x80]))).toBeUndefined();
    expect(decodeText(Buffer.from('\ufeffhello\r\n', 'utf16le'))).toBe('hello\r\n');
  });
});
