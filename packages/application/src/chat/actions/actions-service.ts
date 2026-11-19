import { Cause, Context, Effect, Exit, Fiber, Layer, Scope, SubscriptionRef } from 'effect';
import { ChatConfig } from '../chat-config.ts';
import { describeChatFailure } from '../chat-errors.ts';
import { countAction, initialNotice, type ActionsState } from './actions.ts';

export type ChatActionsShape = {
  readonly state: SubscriptionRef.SubscriptionRef<ActionsState>;
  /** Whether new work may start: admissions are open and the chat isn't closing. */
  readonly accepting: Effect.Effect<boolean>;
  /**
   * Runs one of the chat's actions, for as long as the chat lives: it is listed in `active` while
   * it runs, clears the error shown when it starts, and shows its failure when it fails. A second
   * call of a running action is dropped unless `duplicate` is false. Nothing starts while the chat
   * isn't accepting. An interrupted action (superseded, or its connection gone) reports nothing.
   */
  readonly run: (
    name: string,
    work: Effect.Effect<void, unknown>,
    options?: { duplicate?: boolean },
  ) => Effect.Effect<void>;
  /** Runs work the chat owns in the background; closing the chat interrupts it. */
  readonly fork: (work: Effect.Effect<void, unknown>) => Effect.Effect<void>;
  /** Shows a failure as the chat's error; a closing chat or a cancellation shows nothing. */
  readonly report: (error: unknown) => Effect.Effect<void>;
  readonly setNotice: (notice: string) => Effect.Effect<void>;
  /** Composition fences admissions; admitted work and retained replies still settle. */
  readonly setAdmissionsOpen: (open: boolean) => Effect.Effect<void>;
};

/** The chat's running actions, the last failure and notice it shows, and its admissions. */
export class ChatActions extends Context.Service<ChatActions, ChatActionsShape>()(
  'moonbase/chat/ChatActions',
) {
  static readonly layer = Layer.effect(
    ChatActions,
    Effect.gen(function* () {
      const config = yield* ChatConfig;
      const state = yield* SubscriptionRef.make<ActionsState>({
        counts: {},
        error: null,
        notice: initialNotice(!!config.connection),
        admissionsOpen: true,
        closing: false,
      });
      // The chat's work runs in its own scope. Closing the chat stops admissions and reports, then
      // closes the scope, interrupting that work: each interrupted action settles its own count.
      const scope = yield* Scope.fork(yield* Effect.scope, 'parallel');
      yield* Effect.addFinalizer(() =>
        Effect.andThen(
          SubscriptionRef.update(state, (s) => ({ ...s, closing: true })),
          Scope.close(scope, Exit.void),
        ),
      );
      const own = <A, E>(work: Effect.Effect<A, E>) =>
        Effect.forkIn(work, scope, { startImmediately: true });
      const accepting = Effect.map(
        SubscriptionRef.get(state),
        (s) => s.admissionsOpen && !s.closing,
      );
      const report = (error: unknown) =>
        SubscriptionRef.update(state, (s) =>
          s.closing || (error as { _tag?: unknown } | null)?._tag === 'CancelledError'
            ? s
            : { ...s, error: describeChatFailure(error) },
        );
      const settle = (name: string) =>
        SubscriptionRef.update(state, (s) => ({ ...s, counts: countAction(s.counts, name, -1) }));
      return {
        state,
        accepting,
        run: (name, work, options) =>
          // Admission, counting and starting the work are one protected step; the work settles its
          // own bookkeeping, so a caller that stops waiting (a closing view) leaves it to the chat.
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              // Admission and counting are one step, so two calls can't both pass the check.
              const admitted = yield* SubscriptionRef.modify(state, (s) =>
                !s.admissionsOpen || s.closing || ((options?.duplicate ?? true) && s.counts[name])
                  ? [false, s]
                  : [true, { ...s, counts: countAction(s.counts, name, 1), error: null }],
              );
              if (!admitted) return;
              const settled = Effect.onExit(work, (exit) =>
                Effect.andThen(
                  settle(name),
                  Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                    ? report(Cause.squash(exit.cause))
                    : Effect.void,
                ),
              );
              const fiber = yield* own(settled);
              yield* restore(Fiber.await(fiber));
            }),
          ),
        fork: (work) => Effect.asVoid(own(Effect.ignore(work))),
        report,
        setNotice: (notice) => SubscriptionRef.update(state, (s) => ({ ...s, notice })),
        setAdmissionsOpen: (open) =>
          SubscriptionRef.update(state, (s) => (s.closing ? s : { ...s, admissionsOpen: open })),
      } satisfies ChatActionsShape;
    }),
  );
}
