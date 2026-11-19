import { Context, Effect, Exit, Layer, Queue, Semaphore, Stream, SubscriptionRef } from 'effect';
import type { RecoveryEdit, RecoveryEditInput, RecoveryLayout } from '@moonbase/contracts/recovery';
import type { FileDocument, FileTarget } from '@moonbase/contracts/workspace';
import { isRefusal, type EditorFailure } from '../editor-errors.ts';
import { EditorSession } from '../session/session-service.ts';
import {
  emptyOutbox,
  findNextEdit,
  isDraftPending,
  isStructural,
  isTabPending,
  maximumResyncs,
  queueDraft,
  queueLayout,
  type CloseRequest,
  type OpenRequest,
  type OutboxState,
  type RecoveryEditRequest,
} from './recovery-outbox.ts';

/** What sending needs from the editor around the outbox. */
export type OutboxSender = {
  /** Waits until edits may be sent (not while Git initializes a project). */
  readonly ready: Effect.Effect<void>;
  /** The layout as the editor shows it now. */
  readonly layout: Effect.Effect<RecoveryLayout>;
  readonly send: <K extends RecoveryEdit>(
    kind: K,
    input: RecoveryEditInput<K>,
  ) => Effect.Effect<void, EditorFailure>;
  /**
   * Takes in the store's state after it refused `edit` as given (its buffer is gone or another
   * holds its file), queueing whatever the store then needs to match the editor. Succeeds false
   * when the refusal stands: the edit is dropped and the flush fails with it.
   */
  readonly resync: (edit: RecoveryEditRequest) => Effect.Effect<boolean, EditorFailure>;
  /** Whether the store no longer holds the buffer: a close sent for it committed. */
  readonly settleClose: (bufferId: string) => Effect.Effect<boolean, EditorFailure>;
  /**
   * Finishes, in the editor, a close whose lost reply was settled only later, as committed: its
   * tab closes, or (`reopen`, a Discard that keeps the tab) its text goes back to disk.
   */
  readonly finishClose: (
    edit: CloseRequest,
    reopen: OpenRequest | undefined,
  ) => Effect.Effect<void>;
  /** Where the editor shows the buffer's tab, if it does. */
  readonly shownTab: (bufferId: string) => Effect.Effect<FileTarget | undefined>;
};

export type RecoveryOutboxShape = {
  readonly state: SubscriptionRef.SubscriptionRef<OutboxState>;
  readonly get: Effect.Effect<OutboxState>;
  readonly openTab: (bufferId: string, target: FileTarget) => Effect.Effect<void>;
  readonly closeTab: (bufferId: string, discard?: boolean) => Effect.Effect<void>;
  /** Drops a buffer's draft, keeping its tab: closed with its draft discarded, then reopened. */
  readonly discardDraft: (bufferId: string, target: FileTarget) => Effect.Effect<void>;
  readonly updateDraft: (bufferId: string, text: string, disk: FileDocument) => Effect.Effect<void>;
  readonly updateLayout: Effect.Effect<void>;
  /** Keeps the buffer's queued drafts unsent until `releaseDraft`, as a Save settles. */
  readonly holdDraft: (bufferId: string) => Effect.Effect<void>;
  /** Lets the buffer's drafts go, sending them a moment later. */
  readonly releaseDraft: (bufferId: string) => Effect.Effect<void>;
  /** Sends the next layout even if it is the one last committed: the store's may differ now. */
  readonly forgetLayout: Effect.Effect<void>;
  /** The layout changed: queue it and send once nothing has changed for a moment. */
  readonly changed: Effect.Effect<void>;
  /** Sends the edits once nothing has changed for a moment, while the editor is ready. */
  readonly schedule: Effect.Effect<void>;
  /** Each `schedule`, for the sender that debounces them. */
  readonly scheduled: Stream.Stream<void>;
  readonly isTabPending: (bufferId: string) => Effect.Effect<boolean>;
  readonly isDraftPending: (bufferId: string) => Effect.Effect<boolean>;
  /**
   * Sends every edit made so far, one at a time, in order; succeeds once each has committed. A
   * failed edit stays first and is not sent again on its own: the next change, flush or Retry
   * sends it. A `scheduled` send (the debounce's) clears a failure only by committing an edit
   * made since: with nothing to send, the failure stays shown.
   */
  readonly send: (scheduled: boolean, sender: OutboxSender) => Effect.Effect<void, EditorFailure>;
  /** Forgets what is queued; for an editor that is closing. */
  readonly clear: Effect.Effect<void>;
};

/**
 * The editor's edits to the recovery store, sent one at a time in the order they were made: each
 * waits for the one before it to commit, since the store applies a client's edits in the order
 * they arrive. A buffer's newer text replaces its unsent text, and the layout is read when sent.
 */
export class RecoveryOutbox extends Context.Service<RecoveryOutbox, RecoveryOutboxShape>()(
  'moonbase/editor/RecoveryOutbox',
) {
  static readonly layer = Layer.effect(
    RecoveryOutbox,
    Effect.gen(function* () {
      const session = yield* EditorSession;
      const state = yield* SubscriptionRef.make(emptyOutbox);
      const wakes = yield* Queue.unbounded<void>();
      const lock = yield* Semaphore.make(1);
      const update = (f: (state: OutboxState) => OutboxState) => SubscriptionRef.update(state, f);
      const get = SubscriptionRef.get(state);
      const queue = (f: (queue: readonly RecoveryEditRequest[]) => RecoveryEditRequest[]) =>
        update((s) => ({ ...s, queue: f(s.queue) }));
      const openTab = (bufferId: string, target: FileTarget) =>
        queue((q) => [...q, { kind: 'openTab', bufferId, target: structuredClone(target) }]);
      const closeTab = (bufferId: string, discard = false) =>
        queue((q) => [...q, { kind: 'closeTab', bufferId, discard }]);
      const updateLayout = queue(queueLayout);
      // Once the editor closes, nothing takes a wake: its sends ended with its scope.
      const schedule = Effect.flatMap(session.get, ({ ready, loading }) =>
        !ready || loading ? Effect.void : Queue.offer(wakes, undefined),
      );

      const drain = (scheduled: boolean, sender: OutboxSender) =>
        Effect.gen(function* () {
          const { clientId } = session;
          let resyncs = 0,
            sent = false;
          const refuse = (error: EditorFailure) =>
            Effect.andThen(
              update((s) => ({ ...s, failure: error })),
              Effect.fail(error),
            );
          const { unsettled } = yield* get;
          if (unsettled) {
            // A close whose outcome is unknown: the store says whether it committed.
            yield* sender.ready;
            const { edit, reopen } = unsettled;
            if (yield* sender.settleClose(edit.bufferId)) {
              // The close was vetoed and its draft stayed shown, so text typed since is newer than
              // the Discard: the buffer opens again in the store ahead of that text.
              const shown =
                isDraftPending(yield* get, edit.bufferId) &&
                (yield* sender.shownTab(edit.bufferId));
              if (shown) {
                yield* queue((q) => [
                  { kind: 'openTab', bufferId: edit.bufferId, target: shown },
                  ...q,
                ]);
                yield* updateLayout;
              } else yield* sender.finishClose(edit, reopen);
            }
            yield* update((s) => ({
              ...s,
              unsettled: undefined,
              failure: scheduled ? s.failure : undefined,
            }));
          }
          for (;;) {
            if (findNextEdit(yield* get) < 0) break;
            yield* sender.ready;
            // Once taken, an edit is sent and recorded, or goes back first if interrupted.
            const outcome = yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const edit = yield* SubscriptionRef.modify(state, (s) => {
                  const index = findNextEdit(s);
                  if (index < 0) return [undefined, s];
                  const next = s.queue[index];
                  return [
                    next,
                    { ...s, queue: s.queue.filter((_, at) => at !== index), sending: next },
                  ];
                });
                if (!edit) return undefined;
                const exit = yield* Effect.exit(
                  restore(
                    Effect.gen(function* () {
                      if (edit.kind === 'updateLayout') {
                        const layout = yield* sender.layout,
                          written = JSON.stringify(layout);
                        if (written === (yield* get).committedLayout) return;
                        yield* sender.send('updateLayout', { clientId, layout });
                        yield* update((s) => ({ ...s, committedLayout: written }));
                      } else {
                        const { kind: _kind, ...input } = edit;
                        yield* sender.send(edit.kind, {
                          clientId,
                          ...input,
                        } as RecoveryEditInput<typeof edit.kind>);
                        // The store moved the tab (a reopened one goes last): send the layout again.
                        if (edit.kind !== 'updateDraft')
                          yield* update((s) => ({ ...s, committedLayout: undefined }));
                      }
                      sent = true;
                    }),
                  ),
                );
                if (Exit.isFailure(exit) && !Exit.hasFails(exit)) {
                  // Interrupted or a defect: the edit goes back first, and is sent again later.
                  yield* update((s) => ({ ...s, sending: undefined, queue: [edit, ...s.queue] }));
                  return yield* exit;
                }
                yield* update((s) => ({
                  ...s,
                  sending: undefined,
                  failure: Exit.isSuccess(exit) && (sent || !scheduled) ? undefined : s.failure,
                }));
                return { edit, exit };
              }),
            );
            if (!outcome) break;
            const { edit, exit } = outcome;
            if (Exit.isSuccess(exit)) continue;
            const error = exit.cause.reasons.find((reason) => reason._tag === 'Fail')!
              .error as EditorFailure;
            if (edit.kind === 'closeTab') {
              // A close is part of the action that made it (a Close, a Discard, a Reload) and is
              // never sent again behind the editor's back: the tab edits queued after it go too.
              // The edit that followed the close for its buffer: another buffer's held draft may be
              // first in the queue, since the close can be taken from behind it.
              const next = (yield* get).queue.find((queued) => isStructural(queued, edit.bufferId));
              const reopen =
                next?.kind === 'openTab' && next.bufferId === edit.bufferId ? next : undefined;
              yield* queue((q) => q.filter((queued) => !isStructural(queued, edit.bufferId)));
              if (isRefusal(error)) {
                if (resyncs++ < maximumResyncs) yield* sender.resync(edit);
                return yield* refuse(error);
              }
              // Its reply was lost: the store says whether it committed. One that did stands (the
              // action goes on); one that didn't leaves the draft where the editor shows it.
              const settled = yield* Effect.exit(sender.settleClose(edit.bufferId));
              if (Exit.isFailure(settled)) {
                yield* update((s) => ({ ...s, unsettled: { edit, reopen } }));
                return yield* refuse(error);
              }
              if (!settled.value) return yield* refuse(error);
              if (reopen) yield* queue((q) => [reopen, ...q]);
              continue;
            }
            if (isRefusal(error)) {
              if (resyncs++ < maximumResyncs && (yield* sender.resync(edit))) continue;
              return yield* refuse(error);
            }
            yield* queue((q) => [edit, ...q]);
            return yield* refuse(error);
          }
          // Everything made so far has committed, or was abandoned with the action that made it.
          if (sent || !scheduled) yield* update((s) => ({ ...s, failure: undefined }));
        });

      return {
        state,
        get,
        openTab,
        closeTab,
        discardDraft: (bufferId, target) =>
          Effect.andThen(closeTab(bufferId, true), openTab(bufferId, target)),
        updateDraft: (bufferId, text, disk) => queue((q) => queueDraft(q, bufferId, text, disk)),
        updateLayout,
        holdDraft: (bufferId) =>
          update((s) => (s.held.includes(bufferId) ? s : { ...s, held: [...s.held, bufferId] })),
        releaseDraft: (bufferId) =>
          Effect.flatMap(
            SubscriptionRef.modify(state, (s) =>
              s.held.includes(bufferId)
                ? [true, { ...s, held: s.held.filter((id) => id !== bufferId) }]
                : [false, s],
            ),
            (released) => (released ? schedule : Effect.void),
          ),
        forgetLayout: update((s) => ({ ...s, committedLayout: undefined })),
        changed: Effect.andThen(updateLayout, schedule),
        schedule,
        scheduled: Stream.fromQueue(wakes),
        isTabPending: (bufferId) => Effect.map(get, (s) => isTabPending(s, bufferId)),
        isDraftPending: (bufferId) => Effect.map(get, (s) => isDraftPending(s, bufferId)),
        send: (scheduled, sender) => lock.withPermits(1)(drain(scheduled, sender)),
        clear: update((s) => ({ ...s, queue: [] })),
      } satisfies RecoveryOutboxShape;
    }),
  );
}
