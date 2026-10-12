import { randomUUID } from 'node:crypto';
import type { HistoryStore } from './history';
import type { Session, Step } from './types';

/** Exact only for caller-owned, serialized operations. Provider notifications are not barriers. */
export class StepRecorder {
  private busy = false;
  constructor(private readonly history: HistoryStore, private readonly root: string,
    readonly session: Session, private readonly changed: () => void = () => undefined) {}

  async record(title: string, operation: () => Promise<string | void>, signal?: AbortSignal): Promise<Step> {
    if (this.busy) throw new Error('Another step is still writing.');
    signal?.throwIfAborted();
    this.busy = true;
    let step: Step | undefined;
    try {
      const before = await this.history.capture(this.root);
      step = { id: randomUUID(), title, status: 'running', before: before.id,
        changes: [], output: '', captureMode: 'exact' };
      this.session.steps.push(step);
      await this.history.saveSession(this.session);
      this.changed();
      try {
        step.output = (await operation()) ?? '';
        step.status = signal?.aborted ? 'interrupted' : 'completed';
      } catch (error) {
        step.status = signal?.aborted ? 'interrupted' : 'failed';
        step.output = error instanceof Error ? error.message : String(error);
      }
      // Even a failed operation can have partial code changes.
      const after = await this.history.capture(this.root);
      step.after = after.id;
      step.changes = await this.history.changes(before.id, after.id);
      await this.history.saveSession(this.session);
      this.changed();
      return step;
    } catch (error) {
      if (step) {
        step.status = 'failed';
        step.output = `Checkpoint failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.session.status = 'failed';
      await this.history.saveSession(this.session);
      this.changed();
      throw error;
    } finally { this.busy = false; }
  }
}
