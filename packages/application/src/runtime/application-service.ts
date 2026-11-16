import { Context, Deferred, Effect, Exit, Layer, Option, SubscriptionRef } from 'effect';
import { EditorPreservation } from '../editor/preservation/preservation-service.ts';
import { EditorSession } from '../editor/session/session-service.ts';
import { ChatHost, type ChatHostOptions, type ChatHostState } from './chat-host-service.ts';
import {
  ApplicationLifecycleError,
  areChatTargetsValid,
  type ApplicationPhase,
  type MoonbaseApplicationSnapshot,
} from './application.ts';

export type MoonbaseApplicationShape = {
  readonly phase: SubscriptionRef.SubscriptionRef<ApplicationPhase>;
  readonly chat: ChatHost['Service'];
  /**
   * Whether the document may unload now without asking: Quit consented, or nothing is pending
   * and the chat's drafts and the editor's recovery are kept. Runs synchronously.
   */
  readonly canUnload: Effect.Effect<boolean>;
  /**
   * Prepares Quit: keeps the chat's drafts, asks about each editor buffer with unsaved changes and
   * fences every admission once all is kept. Succeeds false, restoring admissions, on a veto.
   */
  readonly prepareQuit: Effect.Effect<boolean>;
  /** Releases the chat and fences the editor, as the document goes. */
  readonly release: Effect.Effect<void, ApplicationLifecycleError | Error>;
  readonly reportCleanup: (error: unknown) => Effect.Effect<void>;
};

/** Reads the application's snapshot from its phase and the chat it shows. */
export const toApplicationSnapshot = (
  phase: ApplicationPhase,
  chat: ChatHostState,
  targets: readonly { id: string; label: string }[],
): MoonbaseApplicationSnapshot => ({
  phase,
  chat: { state: chat.status, error: chat.error },
  chatTargets: targets,
  chatTargetId: chat.targetId,
  cleanup: { pending: chat.cleanupPending ? ['chat'] : [], errors: chat.cleanupErrors },
});

/**
 * The application around one optional editor and one optional chat: Quit and unload, which keep
 * every draft first, and the order they are released in.
 */
export class MoonbaseApplication extends Context.Service<
  MoonbaseApplication,
  MoonbaseApplicationShape
>()('moonbase/application/MoonbaseApplication') {
  static readonly layer = (options: ChatHostOptions) => {
    const application = Layer.effect(
      MoonbaseApplication,
      Effect.gen(function* () {
        const chat = yield* ChatHost;
        const session = yield* Effect.serviceOption(EditorSession);
        const preservation = yield* Effect.serviceOption(EditorPreservation);
        const phase = yield* SubscriptionRef.make<ApplicationPhase>('live');
        let consented = false,
          checkingUnload = false;
        let preparation: Deferred.Deferred<boolean> | undefined;
        const getPhase = SubscriptionRef.get(phase);
        const recoveryReady = Option.match(preservation, {
          onNone: () => Effect.succeed(true),
          onSome: (editor) => editor.recoveryReady,
        });
        const fence = (open: boolean) =>
          Effect.gen(function* () {
            if (Option.isSome(session))
              yield* session.value.update((s) =>
                s.closing ? s : { ...s, admissionsOpen: open },
              );
            yield* chat.fence(open);
          });
        const restore = Effect.gen(function* () {
          if ((yield* getPhase) !== 'preparing') return;
          yield* fence(true);
          yield* SubscriptionRef.set(phase, 'live');
        });

        const prepare = Effect.gen(function* () {
          yield* chat.settle;
          if ((yield* getPhase) !== 'preparing') return false;
          yield* chat.fence(false);
          const preserved = yield* chat.preserve;
          if ((yield* getPhase) === 'preparing') yield* chat.fence(true);
          if ((yield* SubscriptionRef.get(chat.state)).status === 'initialization-failed' || !preserved) {
            yield* restore;
            return false;
          }
          if (Option.isSome(preservation) && Option.isSome(session)) {
            if ((yield* getPhase) !== 'preparing' || !(yield* preservation.value.prepareQuit)) {
              yield* restore;
              return false;
            }
            yield* session.value.update((s) => (s.closing ? s : { ...s, admissionsOpen: false }));
            if (!(yield* preservation.value.finishQuitPreparation)) {
              yield* restore;
              return false;
            }
          }
          if ((yield* getPhase) !== 'preparing') return false;
          yield* fence(false);
          if (!(yield* chat.preserve) || !(yield* recoveryReady)) {
            yield* restore;
            return false;
          }
          if ((yield* getPhase) !== 'preparing') return false;
          consented = true;
          yield* SubscriptionRef.set(phase, 'prepared');
          return true;
        });

        return {
          phase,
          chat,
          canUnload: Effect.gen(function* () {
            if (consented) return true;
            const { status, cleanupPending } = yield* SubscriptionRef.get(chat.state);
            if (
              checkingUnload ||
              (yield* getPhase) !== 'live' ||
              (yield* chat.busy) ||
              status === 'initialization-failed' ||
              status === 'cleanup-blocked' ||
              cleanupPending ||
              !(yield* recoveryReady)
            )
              return false;
            checkingUnload = true;
            yield* fence(false);
            const kept =
              (yield* chat.preserve) && (yield* getPhase) === 'live' && (yield* recoveryReady);
            if ((yield* getPhase) === 'live') yield* fence(true);
            checkingUnload = false;
            return kept;
          }),
          prepareQuit: Effect.gen(function* () {
            if (preparation) return yield* Deferred.await(preparation);
            if (checkingUnload) return false;
            const current = yield* getPhase;
            if (current === 'prepared') return true;
            if (current !== 'live') return false;
            const done = yield* Deferred.make<boolean>();
            preparation = done;
            yield* SubscriptionRef.set(phase, 'preparing');
            const exit = yield* Effect.exit(prepare);
            const consent = Exit.isSuccess(exit) && exit.value;
            if (Exit.isFailure(exit)) {
              const failure = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
              yield* chat.reportCleanup(failure?._tag === 'Fail' ? failure.error : undefined);
              yield* restore;
            }
            if (!consent) preparation = undefined;
            yield* Deferred.succeed(done, consent);
            return consent;
          }),
          release: Effect.gen(function* () {
            yield* SubscriptionRef.set(phase, 'disposing');
            yield* fence(false);
            const released = yield* Effect.exit(chat.release);
            yield* SubscriptionRef.set(phase, Exit.isSuccess(released) ? 'disposed' : 'failed');
            return yield* released;
          }),
          reportCleanup: chat.reportCleanup,
        } satisfies MoonbaseApplicationShape;
      }),
    );
    return Layer.provideMerge(application, ChatHost.layer(options));
  };

  /** Checks a composition's options before it is built. */
  static readonly validate = (options: ChatHostOptions) =>
    (options.chat && options.chatTargets?.length) ||
    !areChatTargetsValid(options.chatTargets ?? [], options.defaultChatTargetId)
      ? Effect.fail(new ApplicationLifecycleError({ reason: 'invalid-targets' }))
      : Effect.void;
}
