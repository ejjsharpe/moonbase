import { Context, Deferred, Effect, Exit, Layer, Option, Ref, SubscriptionRef } from 'effect';
import { EditorPreservation } from '../editor/preservation/preservation-service.ts';
import { EditorSession } from '../editor/session/session-service.ts';
import { EditorLoader } from '../editor/editor-loader.ts';
import type { EditorFailure } from '../editor/editor-errors.ts';
import type { ChatController } from '../chat/index.ts';
import { ChatHost, type ChatHostOptions, type ChatHostState } from './chat-host-service.ts';
import { ChatComposers } from '../chat/composer/composer-service.ts';
import {
  PlaceNavigation,
  type PlaceNavigationShape,
} from '../place-history/place-history-service.ts';
import {
  ApplicationLifecycleError,
  areChatTargetsValid,
  type ApplicationPhase,
  type MoonbaseApplicationSnapshot,
} from './application.ts';

export type MoonbaseApplicationShape = {
  readonly phase: SubscriptionRef.SubscriptionRef<ApplicationPhase>;
  readonly chat: ChatHost['Service'];
  /** The places the window has shown, for back and forward. */
  readonly navigation: PlaceNavigationShape;
  /**
   * Starts the application: loads the editor, then opens the chat. Fails if the editor fails to
   * load, or if a chat-only application's chat can't open.
   */
  readonly start: Effect.Effect<void, ApplicationLifecycleError | EditorFailure>;
  /**
   * Whether the document may unload now without asking: Quit consented, or nothing is pending
   * and the chat's drafts and the editor's recovery are kept. Runs synchronously.
   */
  readonly canUnload: Effect.Effect<boolean>;
  /**
   * Prepares Quit: keeps the chat's drafts, asks about each editor buffer with unsaved changes and
   * fences every admission once all is kept. Succeeds false, restoring admissions, on a veto.
   * A call while one runs joins it.
   */
  readonly prepareQuit: Effect.Effect<boolean>;
  /** Releases the chat and fences the editor, as the document goes; the editor closes after. */
  readonly release: Effect.Effect<void, ApplicationLifecycleError>;
  readonly reportCleanup: (error: unknown) => Effect.Effect<void>;
  /** Opens the chat while the application is live. */
  readonly openChat: Effect.Effect<ChatController | null, ApplicationLifecycleError>;
  /** Closes the chat, keeping its drafts, while the application is live. */
  readonly closeChat: Effect.Effect<boolean>;
  /** Switches chat targets while the application is live. */
  readonly selectChatTarget: (
    id: string,
  ) => Effect.Effect<ChatController | null, ApplicationLifecycleError>;
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

/** Whether Quit consented, an unload check runs, or a preparation runs (which callers join). */
type QuitState = {
  consented: boolean;
  checkingUnload: boolean;
  preparation?: Deferred.Deferred<boolean>;
};

/**
 * The application around one optional editor and one optional chat: Quit and unload, which keep
 * every draft first, and the order they are released in. Built over `editorLayer` (if any), so it
 * is released before the editor.
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
        const navigation = yield* PlaceNavigation;
        const session = yield* Effect.serviceOption(EditorSession);
        const preservation = yield* Effect.serviceOption(EditorPreservation);
        const loader = yield* Effect.serviceOption(EditorLoader);
        const phase = yield* SubscriptionRef.make<ApplicationPhase>('live');
        const quit = yield* Ref.make<QuitState>({ consented: false, checkingUnload: false });
        const getPhase = SubscriptionRef.get(phase);
        const recoveryReady = Option.match(preservation, {
          onNone: () => Effect.succeed(true),
          onSome: (editor) => editor.recoveryReady,
        });
        const fenceEditor = (open: boolean) =>
          Option.isSome(session)
            ? session.value.update((s) => (s.closing ? s : { ...s, admissionsOpen: open }))
            : Effect.void;
        const fence = (open: boolean) => Effect.andThen(fenceEditor(open), chat.fence(open));
        const restore = Effect.gen(function* () {
          if ((yield* getPhase) !== 'preparing') return;
          yield* fence(true);
          yield* SubscriptionRef.set(phase, 'live');
        });
        const vetoed = Effect.as(restore, false);
        /** Whether chat may open, close or switch: the application is live and not checking. */
        const live = Effect.map(
          Effect.all([getPhase, Ref.get(quit)]),
          ([current, { checkingUnload }]) => current === 'live' && !checkingUnload,
        );

        const prepare = Effect.gen(function* () {
          yield* chat.settle;
          if ((yield* getPhase) !== 'preparing') return false;
          yield* chat.fence(false);
          const preserved = yield* chat.preserve;
          if ((yield* getPhase) === 'preparing') yield* chat.fence(true);
          const { status } = yield* SubscriptionRef.get(chat.state);
          if (status === 'initialization-failed' || !preserved) return yield* vetoed;
          if (Option.isSome(preservation)) {
            if ((yield* getPhase) !== 'preparing' || !(yield* preservation.value.prepareQuit))
              return yield* vetoed;
            yield* fenceEditor(false);
            if (!(yield* preservation.value.finishQuitPreparation)) return yield* vetoed;
          }
          if ((yield* getPhase) !== 'preparing') return false;
          yield* fence(false);
          if (!(yield* chat.preserve) || !(yield* recoveryReady)) return yield* vetoed;
          if ((yield* getPhase) !== 'preparing') return false;
          yield* Ref.update(quit, (q) => ({ ...q, consented: true }));
          yield* SubscriptionRef.set(phase, 'prepared');
          return true;
        });

        return {
          phase,
          chat,
          navigation,
          start: Effect.gen(function* () {
            if (Option.isNone(loader) && !chat.configured)
              return yield* new ApplicationLifecycleError({ reason: 'nothing-composed' });
            if (Option.isSome(loader)) yield* loader.value.load;
            if (!chat.configured) return;
            const opened = yield* Effect.exit(chat.open);
            if (Option.isSome(loader)) return;
            // A chat-only application needs its chat.
            if (Exit.isSuccess(opened) && opened.value) return;
            const { error } = yield* SubscriptionRef.get(chat.state);
            return yield* new ApplicationLifecycleError({
              reason: 'unavailable',
              detail: error ?? undefined,
            });
          }),
          canUnload: Effect.gen(function* () {
            const { consented, checkingUnload } = yield* Ref.get(quit);
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
            yield* Ref.update(quit, (q) => ({ ...q, checkingUnload: true }));
            yield* fence(false);
            const kept =
              (yield* chat.preserve) && (yield* getPhase) === 'live' && (yield* recoveryReady);
            if ((yield* getPhase) === 'live') yield* fence(true);
            yield* Ref.update(quit, (q) => ({ ...q, checkingUnload: false }));
            return kept;
          }),
          prepareQuit: Effect.gen(function* () {
            const { preparation, checkingUnload } = yield* Ref.get(quit);
            if (preparation) return yield* Deferred.await(preparation);
            if (checkingUnload) return false;
            const current = yield* getPhase;
            if (current === 'prepared') return true;
            if (current !== 'live') return false;
            const done = yield* Deferred.make<boolean>();
            yield* Ref.update(quit, (q) => ({ ...q, preparation: done }));
            yield* SubscriptionRef.set(phase, 'preparing');
            const exit = yield* Effect.exit(prepare);
            const consent = Exit.isSuccess(exit) && exit.value;
            if (Exit.isFailure(exit)) {
              const failure = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
              yield* chat.reportCleanup(failure?._tag === 'Fail' ? failure.error : undefined);
              yield* restore;
            }
            if (!consent) yield* Ref.update(quit, (q) => ({ ...q, preparation: undefined }));
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
          openChat: Effect.flatMap(live, (open) =>
            open ? chat.open : Effect.fail(new ApplicationLifecycleError({ reason: 'closing' })),
          ),
          closeChat: Effect.flatMap(live, (open) => (open ? chat.close : Effect.succeed(false))),
          selectChatTarget: (id) =>
            Effect.flatMap(live, (open) =>
              open
                ? chat.select(id)
                : Effect.fail(new ApplicationLifecycleError({ reason: 'target-unavailable' })),
            ),
        } satisfies MoonbaseApplicationShape;
      }),
    );
    return Layer.provideMerge(
      application,
      Layer.provideMerge(
        Layer.merge(
          Layer.provide(ChatHost.layer(options), ChatComposers.layer),
          PlaceNavigation.layer,
        ),
        Layer.effectDiscard(validate(options)),
      ),
    );
  };
}

/** Refuses a composition whose chat targets aren't distinct and named, with a matching default. */
const validate = (options: ChatHostOptions) =>
  (options.chat && options.chatTargets?.length) ||
  !areChatTargetsValid(options.chatTargets ?? [], options.defaultChatTargetId)
    ? Effect.fail(new ApplicationLifecycleError({ reason: 'invalid-targets' }))
    : Effect.void;
