import { Context, Deferred, Effect, Exit, Layer, Ref, Scope, SubscriptionRef } from 'effect';
import {
  TranscriptViewMemory,
  makeChatController,
  makeChatModel,
  type ChatController,
  type ChatDependencies,
  type ChatModel,
  type ChatRunner,
} from '../chat/index.ts';
import { ChatComposers, type ChatComposer } from '../chat/composer/composer-service.ts';
import { getFailureCode } from '../editor/editor-errors.ts';
import {
  ApplicationLifecycleError,
  describeApplicationFailure,
  joinFailures,
  type ApplicationChatStatus,
  type NamedChatTarget,
} from './application.ts';

export type ChatHostState = {
  targetId: string | null;
  status: ApplicationChatStatus;
  error: string | null;
  controller: ChatController | null;
  /** The open chat's composer, made beside its controller and released with it. */
  composer: ChatComposer | null;
  /** The chat's release is running; it can't open again until it ends. */
  cleanupPending: boolean;
  /** Releases that failed, newest last: at most 4. */
  cleanupErrors: readonly string[];
};

export type ChatHostOptions = {
  chat?: Effect.Effect<ChatDependencies | null, unknown>;
  chatTargets?: readonly NamedChatTarget[];
  defaultChatTargetId?: string;
  /** The root runtime's runner, which the chat controller runs its work on until CL-22. */
  runner: ChatRunner;
};

type Opened = Deferred.Deferred<ChatController | null, ApplicationLifecycleError>;
type ChatInstance = {
  model: ChatModel;
  controller: ChatController;
  composer: ChatComposer;
  scope: Scope.Closeable;
};
/** What the host is doing: each running step, which later callers join, and the open chat. */
type Steps = {
  current: ChatInstance | null;
  opening?: Opened;
  switching?: Opened;
  /** The last release, which a switch waits for. */
  cleanup?: Deferred.Deferred<void, unknown>;
  closing: boolean;
  releasing: boolean;
};

export type ChatHostShape = {
  readonly state: SubscriptionRef.SubscriptionRef<ChatHostState>;
  readonly targets: readonly { id: string; label: string }[];
  /** Whether a chat capability was supplied at all. */
  readonly configured: boolean;
  /** Opens the selected target's chat, or joins the open running; null when it has none. */
  readonly open: Effect.Effect<ChatController | null, ApplicationLifecycleError>;
  /**
   * Closes the chat if its drafts are preserved, releasing it in the background; false when it
   * isn't open, is closing, or its drafts couldn't be kept.
   */
  readonly close: Effect.Effect<boolean>;
  /** Closes the current chat (if its drafts are kept) and opens another target's. */
  readonly select: (id: string) => Effect.Effect<ChatController | null, ApplicationLifecycleError>;
  /** Waits for an open or a switch that is running. */
  readonly settle: Effect.Effect<void>;
  /** Whether the chat is opening, switching or closing. */
  readonly busy: Effect.Effect<boolean>;
  /** Fences or reopens the chat's admissions. */
  readonly fence: (open: boolean) => Effect.Effect<void>;
  /** Keeps the chat's drafts; false when they couldn't be kept. */
  readonly preserve: Effect.Effect<boolean>;
  /** Releases the chat and waits for every release, failing with what they failed with. */
  readonly release: Effect.Effect<void, ApplicationLifecycleError>;
  readonly reportCleanup: (error: unknown) => Effect.Effect<void>;
};

const failureOf = (exit: Exit.Failure<unknown, unknown>) => {
  const reason = exit.cause.reasons.find((item) => item._tag === 'Fail' || item._tag === 'Die');
  if (reason?._tag === 'Fail') return reason.error;
  return reason?._tag === 'Die' ? reason.defect : undefined;
};

/** The chat the application shows: one target's at a time, opened, switched and released. */
export class ChatHost extends Context.Service<ChatHost, ChatHostShape>()(
  'moonbase/application/ChatHost',
) {
  static readonly layer = (options: ChatHostOptions) =>
    Layer.effect(
      ChatHost,
      Effect.gen(function* () {
        const root = yield* Effect.scope;
        const composers = yield* ChatComposers;
        const transcriptMemory = new TranscriptViewMemory();
        const targets = options.chatTargets ?? [];
        const configured = !!options.chat || targets.length > 0;
        const state = yield* SubscriptionRef.make<ChatHostState>({
          targetId: options.defaultChatTargetId ?? targets[0]?.id ?? null,
          status: 'unavailable',
          error: null,
          controller: null,
          composer: null,
          cleanupPending: false,
          cleanupErrors: [],
        });
        const steps = yield* Ref.make<Steps>({ current: null, closing: false, releasing: false });
        const update = (f: (s: ChatHostState) => ChatHostState) => SubscriptionRef.update(state, f);
        const step = (f: (s: Steps) => Steps) => Ref.update(steps, f);
        const releasing = Effect.map(Ref.get(steps), (s) => s.releasing);
        const stopAll = Effect.andThen(
          step((s) => ({ ...s, releasing: true })),
          Effect.sync(() => transcriptMemory.clear()),
        );
        yield* Effect.addFinalizer(() => stopAll);
        const fail = (
          reason: ApplicationLifecycleError['reason'],
          detail?: string,
          code?: ApplicationLifecycleError['code'],
        ) => Effect.fail(new ApplicationLifecycleError({ reason, detail, code }));
        const recordCleanupError = (error: unknown) =>
          update((s) => ({
            ...s,
            cleanupErrors: [
              ...s.cleanupErrors,
              describeApplicationFailure(error).slice(0, 512),
            ].slice(-4),
          }));

        /** Releases an instance: the controller's own release, then its scope, joining both. */
        const releaseInstance = (instance: { scope: Scope.Closeable; model?: ChatModel }) =>
          Effect.gen(function* () {
            const exits = [
              yield* Effect.exit(
                instance.model
                  ? Effect.tryPromise({ try: () => instance.model!.dispose(), catch: (e) => e })
                  : Effect.void,
              ),
              yield* Effect.exit(Scope.close(instance.scope, Exit.void)),
            ];
            const failures = exits.flatMap((exit) =>
              Exit.isFailure(exit) ? [failureOf(exit)] : [],
            );
            if (failures.length) return yield* Effect.fail(failures[0]);
          });
        /** Releases the chat's instance as the application's cleanup, which blocks reopening. */
        const ownCleanup = (instance: { scope: Scope.Closeable; model?: ChatModel }) =>
          Effect.gen(function* () {
            const done = yield* Deferred.make<void, unknown>();
            yield* step((s) => ({ ...s, cleanup: done }));
            yield* update((s) => ({ ...s, cleanupPending: true }));
            const exit = yield* Effect.exit(releaseInstance(instance));
            yield* update((s) => ({ ...s, cleanupPending: false }));
            if (Exit.isFailure(exit)) {
              const error = failureOf(exit);
              yield* recordCleanupError(error);
              yield* update((s) => ({
                ...s,
                status: 'cleanup-blocked',
                error: describeApplicationFailure(error),
              }));
            }
            yield* Deferred.done(done, exit);
            return yield* exit;
          });

        const acquire = Effect.gen(function* () {
          const scope = yield* Scope.fork(root, 'parallel');
          let model: ChatModel | undefined;
          const { targetId } = yield* SubscriptionRef.get(state);
          const capability =
            targets.find((target) => target.id === targetId)?.acquire ?? options.chat!;
          const opened = yield* Effect.exit(
            Effect.gen(function* () {
              const dependencies = yield* capability;
              if (!dependencies || (yield* releasing)) return null;
              model = yield* makeChatModel({
                ...dependencies,
                backendId: targetId ?? dependencies.backendId,
                transcriptMemory,
              }).pipe(Effect.provideService(Scope.Scope, scope));
              const controller = makeChatController(options.runner, model);
              const composer = yield* composers
                .make(controller)
                .pipe(Effect.provideService(Scope.Scope, scope));
              return { controller, composer };
            }),
          );
          if (Exit.isSuccess(opened) && opened.value && !(yield* releasing)) {
            const { controller, composer } = opened.value;
            yield* step((s) => ({
              ...s,
              current: { model: model!, controller, composer, scope },
            }));
            yield* update((s) => ({ ...s, status: 'ready', controller, composer }));
            return controller;
          }
          if (Exit.isSuccess(opened)) {
            yield* Effect.exit(ownCleanup({ scope, model }));
            if (!(yield* releasing)) yield* update((s) => ({ ...s, status: 'unavailable' }));
            return null;
          }
          const errors: unknown[] = [failureOf(opened)];
          yield* update((s) => ({ ...s, status: 'initialization-failed' }));
          const released = yield* Effect.exit(ownCleanup({ scope, model }));
          if (Exit.isFailure(released)) {
            errors.push(failureOf(released));
            yield* update((s) => ({ ...s, status: 'cleanup-blocked' }));
          }
          yield* update((s) => ({ ...s, error: joinFailures(errors) }));
          return null;
        });

        const openSelected: Effect.Effect<ChatController | null, ApplicationLifecycleError> =
          Effect.gen(function* () {
            const current = yield* Ref.get(steps);
            if (current.releasing) return yield* fail('closing');
            if (current.opening) return yield* Deferred.await(current.opening);
            if (current.current) return current.current.controller;
            if (!configured) return null;
            const { cleanupPending, status } = yield* SubscriptionRef.get(state);
            if (cleanupPending || status === 'cleanup-blocked')
              return yield* fail('cleanup-pending');
            const done = yield* Deferred.make<ChatController | null, ApplicationLifecycleError>();
            yield* step((s) => ({ ...s, opening: done }));
            yield* update((s) => ({ ...s, status: 'opening', error: null }));
            const exit = yield* Effect.exit(acquire);
            yield* step((s) => ({ ...s, opening: undefined }));
            yield* Deferred.done(done, exit);
            return yield* exit;
          });

        const close: Effect.Effect<boolean> = Effect.gen(function* () {
          const taken = yield* Ref.modify(steps, (s) =>
            s.releasing || !s.current || s.closing
              ? [undefined, s]
              : [s.current, { ...s, closing: true }],
          );
          if (!taken) return false;
          taken.model.setAdmissionsOpen(false);
          return yield* Effect.gen(function* () {
            const kept = taken.controller.preserve();
            const now = yield* Ref.get(steps);
            if (!kept || now.releasing || now.current !== taken) return false;
            yield* step((s) => ({ ...s, current: null }));
            yield* update((s) => ({ ...s, status: 'closed', controller: null, composer: null }));
            yield* Effect.forkIn(Effect.exit(ownCleanup(taken)), root, { startImmediately: true });
            return true;
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                const now = yield* Ref.get(steps);
                if (!now.releasing && now.current === taken) taken.model.setAdmissionsOpen(true);
                yield* step((s) => ({ ...s, closing: false }));
              }),
            ),
          );
        });

        const select = (id: string) =>
          Effect.gen(function* () {
            const now = yield* Ref.get(steps);
            if (now.releasing || now.switching || !targets.some((target) => target.id === id))
              return yield* fail('target-unavailable');
            if (id === (yield* SubscriptionRef.get(state)).targetId) return yield* openSelected;
            const done = yield* Deferred.make<ChatController | null, ApplicationLifecycleError>();
            yield* step((s) => ({ ...s, switching: done }));
            const exit = yield* Effect.exit(
              Effect.gen(function* () {
                const { opening } = yield* Ref.get(steps);
                if (opening) yield* Effect.exit(Deferred.await(opening));
                if ((yield* Ref.get(steps)).current && !(yield* close))
                  return yield* fail('preserve-first');
                const { cleanup } = yield* Ref.get(steps);
                if (cleanup) yield* Effect.exit(Deferred.await(cleanup));
                if (yield* releasing) return null;
                yield* update((s) => ({ ...s, targetId: id }));
                return yield* openSelected;
              }),
            );
            yield* step((s) => ({ ...s, switching: undefined }));
            yield* Deferred.done(done, exit);
            return yield* exit;
          });

        return {
          state,
          targets: targets.map(({ id, label }) => ({ id, label })),
          configured,
          open: Effect.flatMap(Ref.get(steps), (s) =>
            s.switching ? Deferred.await(s.switching) : openSelected,
          ),
          close,
          select,
          settle: Effect.gen(function* () {
            const { switching } = yield* Ref.get(steps);
            if (switching) yield* Effect.exit(Deferred.await(switching));
            const { opening } = yield* Ref.get(steps);
            if (opening) yield* Effect.exit(Deferred.await(opening));
          }),
          busy: Effect.map(Ref.get(steps), (s) => !!s.opening || !!s.switching || s.closing),
          fence: (open) =>
            Effect.flatMap(Ref.get(steps), (s) =>
              Effect.sync(() => s.current?.model.setAdmissionsOpen(open)),
            ),
          preserve: Effect.flatMap(Ref.get(steps), (s) =>
            Effect.sync(() => s.current?.controller.preserve() ?? true),
          ),
          release: Effect.gen(function* () {
            yield* stopAll;
            const taken = yield* Ref.modify(steps, (s) => [s, { ...s, current: null }]);
            taken.current?.model.setAdmissionsOpen(false);
            yield* update((s) => ({ ...s, controller: null, composer: null }));
            if (taken.opening) yield* Effect.exit(Deferred.await(taken.opening));
            if (taken.switching) yield* Effect.exit(Deferred.await(taken.switching));
            // An acquisition that finished meanwhile released its own instance.
            const { cleanup } = yield* Ref.get(steps);
            const pending = taken.current
              ? ownCleanup(taken.current)
              : cleanup && Deferred.await(cleanup);
            const released: Exit.Exit<unknown, unknown> = pending
              ? yield* Effect.exit(pending)
              : Exit.void;
            if (Exit.isFailure(released)) {
              const failure = failureOf(released);
              // Main reads the code its cleanup failed with, as it always has (until CL-22).
              return yield* fail(
                'cleanup-failed',
                joinFailures([failure]),
                getFailureCode(failure) ?? 'Unavailable',
              );
            }
          }),
          reportCleanup: recordCleanupError,
        } satisfies ChatHostShape;
      }),
    );
}
