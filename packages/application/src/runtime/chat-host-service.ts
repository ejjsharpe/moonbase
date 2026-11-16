import { Context, Deferred, Effect, Exit, Layer, Scope, SubscriptionRef } from 'effect';
import {
  TranscriptViewMemory,
  makeChatController,
  makeChatModel,
  type ChatController,
  type ChatDependencies,
  type ChatModel,
  type ChatRunner,
} from '../chat/index.ts';
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
  readonly release: Effect.Effect<void, ApplicationLifecycleError | Error>;
  readonly reportCleanup: (error: unknown) => Effect.Effect<void>;
};

type ChatInstance = { model: ChatModel; controller: ChatController; scope: Scope.Closeable };

/** The chat the application shows: one target's at a time, opened, switched and released. */
export class ChatHost extends Context.Service<ChatHost, ChatHostShape>()(
  'moonbase/application/ChatHost',
) {
  static readonly layer = (options: ChatHostOptions) =>
    Layer.effect(
      ChatHost,
      Effect.gen(function* () {
        const root = yield* Effect.scope;
        const transcriptMemory = new TranscriptViewMemory();
        const targets = options.chatTargets ?? [];
        const state = yield* SubscriptionRef.make<ChatHostState>({
          targetId: options.defaultChatTargetId ?? targets[0]?.id ?? null,
          status: 'unavailable',
          error: null,
          controller: null,
          cleanupPending: false,
          cleanupErrors: [],
        });
        const update = (f: (s: ChatHostState) => ChatHostState) => SubscriptionRef.update(state, f);
        let current: ChatInstance | null = null;
        let opening: Deferred.Deferred<ChatController | null, ApplicationLifecycleError> | undefined;
        let switching: Deferred.Deferred<ChatController | null, ApplicationLifecycleError> | undefined;
        let cleanup: Deferred.Deferred<void, unknown> | undefined;
        let closingChat = false;
        let releasing = false;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releasing = true;
            transcriptMemory.clear();
          }),
        );
        const configured = !!options.chat || targets.length > 0;
        const fail = (reason: ApplicationLifecycleError['reason']) =>
          Effect.fail(new ApplicationLifecycleError({ reason }));
        const recordCleanupError = (error: unknown) =>
          update((s) => ({
            ...s,
            cleanupErrors: [...s.cleanupErrors, describeApplicationFailure(error).slice(0, 512)].slice(-4),
          }));

        /** Releases an instance: the controller's own release, then its scope, joining both. */
        const releaseInstance = (instance: Pick<ChatInstance, 'scope'> & { model?: ChatModel }) =>
          Effect.gen(function* () {
            const exits = [
              yield* Effect.exit(
                instance.model
                  ? Effect.tryPromise({
                      try: () => instance.model!.dispose(),
                      catch: (error) => error,
                    })
                  : Effect.void,
              ),
              yield* Effect.exit(Scope.close(instance.scope, Exit.void)),
            ];
            const failures = exits.flatMap((exit) =>
              Exit.isFailure(exit)
                ? exit.cause.reasons.flatMap((reason) =>
                    reason._tag === 'Fail' ? [reason.error] : reason._tag === 'Die' ? [reason.defect] : [],
                  )
                : [],
            );
            if (failures.length) return yield* Effect.fail(new Error(joinFailures(failures)));
          });
        /** Releases the chat's instance as the application's cleanup, which blocks reopening. */
        const ownCleanup = (instance: Pick<ChatInstance, 'scope'> & { model?: ChatModel }) =>
          Effect.gen(function* () {
            const done = yield* Deferred.make<void, unknown>();
            cleanup = done;
            yield* update((s) => ({ ...s, cleanupPending: true }));
            const exit = yield* Effect.exit(releaseInstance(instance));
            yield* update((s) => ({ ...s, cleanupPending: false }));
            if (Exit.isFailure(exit)) {
              const failure = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
              yield* recordCleanupError(failure?._tag === 'Fail' ? failure.error : undefined);
              yield* update((s) => ({
                ...s,
                status: 'cleanup-blocked',
                error: describeApplicationFailure(failure?._tag === 'Fail' ? failure.error : undefined),
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
              if (!dependencies || releasing) return null;
              model = yield* makeChatModel({
                ...dependencies,
                backendId: targetId ?? dependencies.backendId,
                transcriptMemory,
              }).pipe(Effect.provideService(Scope.Scope, scope));
              return makeChatController(options.runner, model);
            }),
          );
          if (Exit.isSuccess(opened) && opened.value && !releasing) {
            current = { model: model!, controller: opened.value, scope };
            yield* update((s) => ({ ...s, status: 'ready', controller: opened.value }));
            return opened.value;
          }
          if (Exit.isSuccess(opened)) {
            yield* Effect.exit(ownCleanup({ scope, model }));
            if (!releasing) yield* update((s) => ({ ...s, status: 'unavailable' }));
            return null;
          }
          const errors: unknown[] = [Exit.isFailure(opened) ? failureOf(opened) : undefined];
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
            if (releasing) return yield* fail('closing');
            if (opening) return yield* Deferred.await(opening);
            if (current) return current.controller;
            if (!configured) return null;
            const { cleanupPending, status } = yield* SubscriptionRef.get(state);
            if (cleanupPending || status === 'cleanup-blocked') return yield* fail('cleanup-pending');
            const done = yield* Deferred.make<ChatController | null, ApplicationLifecycleError>();
            opening = done;
            yield* update((s) => ({ ...s, status: 'opening', error: null }));
            const exit = yield* Effect.exit(acquire);
            opening = undefined;
            yield* Deferred.done(done, exit);
            return yield* exit;
          });

        const close: Effect.Effect<boolean> = Effect.gen(function* () {
          if (releasing || !current || closingChat) return false;
          closingChat = true;
          const instance = current;
          instance.model.setAdmissionsOpen(false);
          try {
            if (!instance.controller.preserve() || releasing || current !== instance) return false;
            current = null;
            yield* update((s) => ({ ...s, status: 'closed', controller: null }));
            yield* Effect.forkIn(Effect.exit(ownCleanup(instance)), root);
            return true;
          } finally {
            if (!releasing && current === instance) instance.model.setAdmissionsOpen(true);
            closingChat = false;
          }
        });

        return {
          state,
          targets: targets.map(({ id, label }) => ({ id, label })),
          configured,
          open: Effect.suspend(() => (switching ? Deferred.await(switching) : openSelected)),
          close,
          select: (id) =>
            Effect.gen(function* () {
              if (releasing || switching || !targets.some((target) => target.id === id))
                return yield* fail('target-unavailable');
              if (id === (yield* SubscriptionRef.get(state)).targetId) return yield* openSelected;
              const done = yield* Deferred.make<ChatController | null, ApplicationLifecycleError>();
              switching = done;
              const exit = yield* Effect.exit(
                Effect.gen(function* () {
                  if (opening) yield* Effect.exit(Deferred.await(opening));
                  if (current && !(yield* close)) return yield* fail('preserve-first');
                  if (cleanup) yield* Effect.exit(Deferred.await(cleanup));
                  if (releasing) return null;
                  yield* update((s) => ({ ...s, targetId: id }));
                  return yield* openSelected;
                }),
              );
              switching = undefined;
              yield* Deferred.done(done, exit);
              return yield* exit;
            }),
          settle: Effect.gen(function* () {
            if (switching) yield* Effect.exit(Deferred.await(switching));
            if (opening) yield* Effect.exit(Deferred.await(opening));
          }),
          busy: Effect.sync(() => !!opening || !!switching || closingChat),
          fence: (open) => Effect.sync(() => current?.model.setAdmissionsOpen(open)),
          preserve: Effect.sync(() => current?.controller.preserve() ?? true),
          release: Effect.gen(function* () {
            releasing = true;
            transcriptMemory.clear();
            current?.model.setAdmissionsOpen(false);
            const instance = current;
            current = null;
            if (opening) yield* Effect.exit(Deferred.await(opening));
            if (switching) yield* Effect.exit(Deferred.await(switching));
            const results = [
              ...(instance ? [yield* Effect.exit(ownCleanup(instance))] : []),
              ...(cleanup ? [yield* Effect.exit(Deferred.await(cleanup))] : []),
            ];
            const failures = results.flatMap((exit) => (Exit.isFailure(exit) ? [failureOf(exit)] : []));
            if (failures.length) return yield* Effect.fail(new Error(joinFailures(failures)));
          }),
          reportCleanup: recordCleanupError,
        } satisfies ChatHostShape;
      }),
    );
}

const failureOf = (exit: Exit.Failure<unknown, unknown>) => {
  const reason = exit.cause.reasons.find((item) => item._tag === 'Fail' || item._tag === 'Die');
  return reason?._tag === 'Fail' ? reason.error : reason?._tag === 'Die' ? reason.defect : undefined;
};
