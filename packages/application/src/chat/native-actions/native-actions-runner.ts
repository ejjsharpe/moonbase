import {
  Effect,
  Exit,
  FiberHandle,
  FiberSet,
  Option,
  type Scope,
  Semaphore,
  SubscriptionRef,
} from 'effect';
import {
  busyNotice,
  doneNotice,
  failedNotice,
  maxNativeActions,
  offlineNotice,
  pendingNotice,
  successNoticeMs,
  type NativeActionKind,
  type TranscriptNotice,
} from './native-actions.ts';

/** One transcript's native actions and the one notice they show. */
export type NativeActions = {
  readonly notice: SubscriptionRef.SubscriptionRef<TranscriptNotice | null>;
  /**
   * Runs `action`, at most `maxNativeActions` at once: one more is refused, not queued. Its
   * outcome shows unless it was cancelled.
   */
  readonly run: (
    action: Effect.Effect<void, unknown>,
    kind: NativeActionKind,
  ) => Effect.Effect<void>;
  /** Cancels the actions running, as the view goes offline, saying so if any were. */
  readonly cancel: Effect.Effect<void>;
  /** Shows a notice of the view's own, such as an action it can't offer. */
  readonly show: (notice: TranscriptNotice) => Effect.Effect<void>;
};

/** A transcript's native actions, for as long as `scope`: closing it cancels them. */
export const makeNativeActions: Effect.Effect<NativeActions, never, Scope.Scope> = Effect.gen(
  function* () {
    const notice = yield* SubscriptionRef.make<TranscriptNotice | null>(null);
    const permits = yield* Semaphore.make(maxNativeActions);
    const running = yield* FiberSet.make<void, never>();
    /** Clears a success notice after a while; any newer notice replaces it first. */
    const clearing = yield* FiberHandle.make<void, never>();
    const show = (next: TranscriptNotice) =>
      Effect.andThen(
        SubscriptionRef.set(notice, next),
        next.tone === 'success'
          ? FiberHandle.run(clearing)(
              Effect.sleep(successNoticeMs).pipe(
                Effect.andThen(
                  SubscriptionRef.update(notice, (current) => (current === next ? null : current)),
                ),
              ),
            )
          : FiberHandle.clear(clearing),
      );
    return {
      notice,
      show,
      run: (action, kind) =>
        FiberSet.run(running)(
          permits
            .withPermitsIfAvailable(1)(
              Effect.gen(function* () {
                yield* show(pendingNotice(kind));
                const exit = yield* Effect.exit(action);
                // A cancelled action reports nothing: the view said why it stopped.
                if (Exit.hasInterrupts(exit)) return;
                yield* show(
                  Exit.isSuccess(exit)
                    ? doneNotice(kind)
                    : failedNotice(Option.getOrUndefined(Exit.findErrorOption(exit))),
                );
              }),
            )
            .pipe(Effect.flatMap((ran) => (Option.isNone(ran) ? show(busyNotice) : Effect.void))),
        ).pipe(Effect.asVoid),
      cancel: Effect.gen(function* () {
        if ((yield* FiberSet.size(running)) === 0) return;
        yield* FiberSet.clear(running);
        yield* show(offlineNotice);
      }),
    } satisfies NativeActions;
  },
);
