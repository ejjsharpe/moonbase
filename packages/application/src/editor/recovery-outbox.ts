import { normalizeApplicationError } from '@moonbase/effect';
import { Effect, FiberHandle, Semaphore } from 'effect';
import type { RecoveryEdit, RecoveryEditInput, RecoveryLayout } from '@moonbase/contracts/recovery';
import {
  ApplicationError,
  type FileDocument,
  type FileTarget,
} from '@moonbase/contracts/workspace';

/** One edit the editor has yet to see committed. */
export type RecoveryEditRequest =
  | { kind: 'openTab'; bufferId: string; target: FileTarget }
  | { kind: 'closeTab'; bufferId: string; discard: boolean }
  | { kind: 'updateDraft'; bufferId: string; text: string; disk: FileDocument }
  | { kind: 'updateLayout' };
type Run = <A>(effect: Effect.Effect<A, ApplicationError>) => Promise<A>;
type OutboxDependencies = {
  clientId: string;
  /** Runs work in the editor's runtime, not owned by its scope. */
  execute: Run;
  send<K extends RecoveryEdit>(kind: K, input: RecoveryEditInput<K>): Promise<void>;
  /** The layout as the editor shows it now. */
  layout(): RecoveryLayout;
  /** Resolves once edits may be sent (not while Git initializes a project). */
  ready(): Promise<void>;
  /**
   * Takes in the store's state after it refused `edit` as given (its buffer is gone or another
   * holds its file), queueing whatever the store then needs to match the editor. Resolves false
   * when the refusal stands: the edit is dropped and the flush fails with it.
   */
  resync(edit: RecoveryEditRequest, error: ApplicationError): Promise<boolean>;
  /** Reads the store's state and sends whatever it lacks of what the editor shows. */
  reassert(): Promise<void>;
  notify(): void;
  report(error: unknown): void;
};
/** Edits the store refuses as given, which a resync resolves; a repeat of one this many times stops. */
const maximumResyncs = 3;
const isRefusal = (error: unknown): error is ApplicationError =>
  ApplicationError.is(error) && error.code === 'InvalidInput';
const isStructural = (edit: RecoveryEditRequest, bufferId: string) =>
  (edit.kind === 'openTab' || edit.kind === 'closeTab') && edit.bufferId === bufferId;

/**
 * The editor's edits to the recovery store, sent one at a time in the order they were made: each
 * waits for the one before it to commit, since the store applies a client's edits in the order
 * they arrive. A buffer's newer text replaces its unsent text, and the layout is read when it is
 * sent. Edits are sent a quiet moment after the last change, or at once by `flush`, which resolves
 * when everything made before it has committed. A failed edit stays first, for the next flush.
 */
export class RecoveryOutbox {
  private queue: RecoveryEditRequest[] = [];
  private sending: RecoveryEditRequest | undefined;
  private failure: unknown;
  /**
   * A tab edit failed, so it may or may not have committed: the store has to be read again and
   * given what the editor shows before anything else is sent.
   */
  private uncertain = false;
  /** The layout last committed, so an unchanged layout is not sent again. */
  private committedLayout: string | undefined;
  private lock = Semaphore.makeUnsafe(1);
  private debounce: FiberHandle.FiberHandle<void, never>;
  private dependencies: OutboxDependencies;
  constructor(debounce: FiberHandle.FiberHandle<void, never>, dependencies: OutboxDependencies) {
    this.debounce = debounce;
    this.dependencies = dependencies;
  }
  /** Whether every edit made so far has committed. */
  get idle() {
    return !this.queue.length && !this.sending && this.failure === undefined && !this.uncertain;
  }
  /** Whether the last edit sent failed, so edits wait for the next flush. */
  get failed() {
    return this.failure !== undefined;
  }
  /** Whether an edit not yet committed opens or closes the buffer. */
  isTabPending(bufferId: string) {
    return [this.sending, ...this.queue].some((edit) => edit && isStructural(edit, bufferId));
  }
  /** The text not yet committed for a buffer, if any. */
  pendingDraft(bufferId: string) {
    return this.queue.findLast(
      (edit): edit is Extract<RecoveryEditRequest, { kind: 'updateDraft' }> =>
        edit.kind === 'updateDraft' && edit.bufferId === bufferId,
    );
  }
  openTab(bufferId: string, target: FileTarget) {
    this.queue.push({ kind: 'openTab', bufferId, target: structuredClone(target) });
    this.dependencies.notify();
  }
  closeTab(bufferId: string, discard = false) {
    this.queue.push({ kind: 'closeTab', bufferId, discard });
    this.dependencies.notify();
  }
  /** Drops a buffer's draft, keeping its tab: closed with its draft discarded, then reopened. */
  discardDraft(bufferId: string, target: FileTarget) {
    this.closeTab(bufferId, true);
    this.openTab(bufferId, target);
  }
  updateDraft(bufferId: string, text: string, disk: FileDocument) {
    // Newer text replaces text not yet sent, unless the buffer was opened or closed since.
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const edit = this.queue[index];
      if (isStructural(edit, bufferId)) break;
      if (edit.kind === 'updateDraft' && edit.bufferId === bufferId) {
        this.queue[index] = { ...edit, text, disk: structuredClone(disk) };
        return;
      }
    }
    this.queue.push({ kind: 'updateDraft', bufferId, text, disk: structuredClone(disk) });
    this.dependencies.notify();
  }
  updateLayout() {
    this.queue = this.queue.filter((edit) => edit.kind !== 'updateLayout');
    this.queue.push({ kind: 'updateLayout' });
    this.dependencies.notify();
  }
  /** Sends the next layout even if it is the one last committed: the store's may differ now. */
  forgetLayout() {
    this.committedLayout = undefined;
  }
  /** Sends the edits once nothing has changed for a moment. */
  schedule() {
    const { execute, report } = this.dependencies;
    void execute(
      FiberHandle.run(
        this.debounce,
        Effect.sleep('150 millis').pipe(
          Effect.andThen(Effect.tryPromise({ try: () => this.flush(), catch: (error) => error })),
          Effect.catch((error) => Effect.sync(() => report(error))),
        ),
      ),
    ).catch(report);
  }
  /** Sends every edit made so far; resolves once each has committed. */
  flush(): Promise<void> {
    return this.dependencies.execute(
      this.lock.withPermits(1)(
        Effect.tryPromise({ try: () => this.drain(), catch: normalizeApplicationError }),
      ),
    );
  }
  private async drain() {
    const { clientId, send, ready, resync, notify } = this.dependencies;
    let resyncs = 0;
    if (this.uncertain) {
      await ready();
      await this.dependencies.reassert();
      this.uncertain = false;
      this.failure = undefined;
      notify();
    }
    while (this.queue.length) {
      await ready();
      const edit = this.queue.shift()!;
      this.sending = edit;
      notify();
      try {
        if (edit.kind === 'updateLayout') {
          const layout = this.dependencies.layout(),
            written = JSON.stringify(layout);
          if (written !== this.committedLayout) {
            await send('updateLayout', { clientId, layout });
            this.committedLayout = written;
          }
        } else {
          const { kind: _kind, ...input } = edit;
          await send(edit.kind, { clientId, ...input } as RecoveryEditInput<typeof edit.kind>);
          // The store moved the tab (a reopened one goes last): the next layout is sent again.
          if (edit.kind !== 'updateDraft') this.committedLayout = undefined;
        }
        this.failure = undefined;
      } catch (error) {
        this.sending = undefined;
        if (edit.kind === 'openTab' || edit.kind === 'closeTab') {
          // A failed close or discard is abandoned with the action that made it, never retried
          // later behind the editor's back: the tab edits queued for its buffer go too.
          this.queue = this.queue.filter((queued) => !isStructural(queued, edit.bufferId));
          if (isRefusal(error) && (await resync(edit, error))) continue;
          // An answer refusing it proves nothing committed; any other failure may hide a commit,
          // so the store is read again and given the draft the editor still shows.
          if (!isRefusal(error)) {
            this.uncertain = true;
            this.failure = error;
          }
          throw error;
        }
        if (isRefusal(error) && resyncs++ < maximumResyncs) {
          if (await resync(edit, error)) continue;
          throw error;
        }
        this.queue.unshift(edit);
        this.failure = error;
        throw error;
      } finally {
        this.sending = undefined;
        notify();
      }
    }
  }
  /** Forgets what is queued; for an editor that is closing. */
  clear() {
    this.queue = [];
  }
}
