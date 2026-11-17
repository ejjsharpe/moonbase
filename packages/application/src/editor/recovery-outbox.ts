import { Effect, Semaphore } from 'effect';
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
type CloseRequest = Extract<RecoveryEditRequest, { kind: 'closeTab' }>;
type OpenRequest = Extract<RecoveryEditRequest, { kind: 'openTab' }>;
/** Runs an effect as the one debounce fiber, owned by the editor's scope, replacing the last. */
export type DebounceRunner = (effect: Effect.Effect<void>) => unknown;
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
  /** Whether the store no longer holds the buffer: a close sent for it committed. */
  settleClose(bufferId: string): Promise<boolean>;
  /**
   * Finishes, in the editor, a close whose lost reply was settled only later, as committed:
   * its tab closes, or (`reopen`, a Discard that keeps the tab) its text goes back to disk.
   */
  finishClose(edit: CloseRequest, reopen: OpenRequest | undefined): void;
  /** Where the editor shows the buffer's tab, if it does. */
  shownTab(bufferId: string): FileTarget | undefined;
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
  /** A close whose reply was lost and whose outcome the store could not be asked for yet. */
  private unsettled: { edit: CloseRequest; reopen: OpenRequest | undefined } | undefined;
  /** The layout last committed, so an unchanged layout is not sent again. */
  private committedLayout: string | undefined;
  /** Buffers whose queued drafts wait for a Save to settle. */
  private held = new Set<string>();
  private lock = Semaphore.makeUnsafe(1);
  private debounce: DebounceRunner;
  private dependencies: OutboxDependencies;
  constructor(debounce: DebounceRunner, dependencies: OutboxDependencies) {
    this.debounce = debounce;
    this.dependencies = dependencies;
  }
  /** Whether every edit made so far has committed. */
  get idle() {
    return !this.queue.length && !this.sending && this.failure === undefined && !this.unsettled;
  }
  /** Whether the last edit sent failed, so edits wait for the next flush. */
  get failed() {
    return this.failure !== undefined;
  }
  /** Whether an edit not yet committed opens or closes the buffer. */
  isTabPending(bufferId: string) {
    return [this.sending, ...this.queue].some((edit) => edit && isStructural(edit, bufferId));
  }
  /** Whether text for the buffer is queued or being sent. */
  isDraftPending(bufferId: string) {
    return [this.sending, ...this.queue].some(
      (edit) => edit?.kind === 'updateDraft' && edit.bufferId === bufferId,
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
  /** Keeps the buffer's queued draft unsent until `releaseDraft`, which sends it. */
  holdDraft(bufferId: string) {
    this.held.add(bufferId);
  }
  releaseDraft(bufferId: string) {
    if (this.held.delete(bufferId)) this.schedule();
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
    const { report } = this.dependencies;
    // The debounce fiber belongs to the editor's scope; a newer change replaces it.
    this.debounce(
      Effect.sleep('150 millis').pipe(
        Effect.andThen(
          Effect.tryPromise({ try: () => this.sendQueued(true), catch: (error) => error }),
        ),
        Effect.catch((error) => Effect.sync(() => report(error))),
      ),
    );
  }
  /**
   * Sends every edit made so far; resolves once each has committed. A failed edit is not sent
   * again on its own: the next change, flush or Retry sends it.
   */
  flush(): Promise<void> {
    return this.sendQueued(false);
  }
  /**
   * A `scheduled` send (the debounce's, not a flush or a Retry) clears a failure only by
   * committing an edit made since: with nothing to send, the failure stays shown.
   */
  private sendQueued(scheduled: boolean): Promise<void> {
    return this.dependencies.execute(
      this.lock.withPermits(1)(
        Effect.tryPromise({
          try: () => this.drain(scheduled),
          catch: (error) => error as ApplicationError,
        }),
      ),
    );
  }
  private async drain(scheduled: boolean) {
    const { clientId, send, ready, resync, settleClose, finishClose, shownTab, notify } =
      this.dependencies;
    let resyncs = 0,
      sent = false;
    const refuse = (error: ApplicationError) => {
      // A refusal that a resync can't resolve ends here, with the failure shown.
      this.failure = error;
      throw error;
    };
    if (this.unsettled) {
      // A close whose outcome is unknown: the store says whether it committed.
      await ready();
      const { edit, reopen } = this.unsettled;
      if (await settleClose(edit.bufferId)) {
        // The close was vetoed and its draft stayed shown, so text typed since is newer than the
        // Discard: the buffer opens again in the store ahead of that text, rather than losing it.
        const shown = this.isDraftPending(edit.bufferId) && shownTab(edit.bufferId);
        if (shown) {
          this.queue.unshift({ kind: 'openTab', bufferId: edit.bufferId, target: shown });
          this.updateLayout();
        } else finishClose(edit, reopen);
      }
      this.unsettled = undefined;
      if (!scheduled) this.failure = undefined;
      notify();
    }
    for (;;) {
      await ready();
      const index = this.queue.findIndex((edit, at) => !this.isHeld(edit, at));
      if (index < 0) break;
      const [edit] = this.queue.splice(index, 1);
      this.sending = edit;
      notify();
      try {
        if (edit.kind === 'updateLayout') {
          const layout = this.dependencies.layout(),
            written = JSON.stringify(layout);
          if (written !== this.committedLayout) {
            await send('updateLayout', { clientId, layout });
            this.committedLayout = written;
            sent = true;
          }
        } else {
          const { kind: _kind, ...input } = edit;
          await send(edit.kind, { clientId, ...input } as RecoveryEditInput<typeof edit.kind>);
          // The store moved the tab (a reopened one goes last): the next layout is sent again.
          if (edit.kind !== 'updateDraft') this.committedLayout = undefined;
          sent = true;
        }
        if (sent || !scheduled) this.failure = undefined;
      } catch (caught) {
        const error = caught as ApplicationError;
        this.sending = undefined;
        if (edit.kind === 'closeTab') {
          // A close is part of the action that made it (a Close, a Discard, a Reload) and is
          // never sent again behind the editor's back: the tab edits queued after it go too.
          const next = this.queue[0];
          const reopen =
            next?.kind === 'openTab' && next.bufferId === edit.bufferId ? next : undefined;
          this.queue = this.queue.filter((queued) => !isStructural(queued, edit.bufferId));
          if (isRefusal(error)) {
            if (resyncs++ < maximumResyncs) await resync(edit, error);
            refuse(error);
          }
          // Its reply was lost: the store says whether it committed. One that did stands (the
          // action goes on); one that didn't leaves the draft where the editor shows it.
          let committed: boolean;
          try {
            committed = await settleClose(edit.bufferId);
          } catch {
            this.unsettled = { edit, reopen };
            refuse(error);
          }
          if (!committed!) refuse(error);
          if (reopen) this.queue.unshift(reopen);
          continue;
        }
        if (isRefusal(error)) {
          if (resyncs++ < maximumResyncs && (await resync(edit, error))) continue;
          refuse(error);
        }
        this.queue.unshift(edit);
        refuse(error);
      } finally {
        this.sending = undefined;
        notify();
      }
    }
    // Everything made so far has committed, or was abandoned with the action that made it.
    if (sent || !scheduled) this.failure = undefined;
    notify();
  }
  /** A held draft waits, unless the buffer's tab opens or closes after it in the queue. */
  private isHeld(edit: RecoveryEditRequest, at: number) {
    if (edit.kind !== 'updateDraft' || !this.held.has(edit.bufferId)) return false;
    return !this.queue.slice(at + 1).some((later) => isStructural(later, edit.bufferId));
  }
  /** Forgets what is queued; for an editor that is closing. */
  clear() {
    this.queue = [];
  }
}
