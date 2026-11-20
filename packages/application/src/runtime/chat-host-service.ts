import {
  Context,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  FiberSet,
  Layer,
  Option,
  Ref,
  Scope,
  ScopedRef,
  SubscriptionRef,
} from 'effect';
import type { ChatDependencies } from '../chat/chat-ports.ts';
import { chatLayer, type ChatServices } from '../chat/chat-layer.ts';
import { ChatActions } from '../chat/actions/actions-service.ts';
import { ChatDrafts } from '../chat/drafts/drafts-service.ts';
import { TranscriptViewMemory } from '../chat/transcript/transcript-view-memory.ts';
import { ChatComposers, type ChatComposer } from '../chat/composer/composer-service.ts';
import { makeComposerChat } from '../chat/composer/composer-chat.ts';
import { runOrJoin } from './run-or-join.ts';
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
  /** The open chat's services. */
  chat: Context.Context<ChatServices> | null;
  /** The open chat's composer, made beside its services and released with them. */
  composer: ChatComposer | null;
  /** The chat's release is running; it can't open again until it ends. */
  cleanupPending: boolean;
  /** Releases that failed, newest last: at most 4. */
  cleanupErrors: readonly string[];
  /** Host bookkeeping, not for views: a close is keeping the chat's drafts before it releases it. */
  closing: boolean;
  /** Host bookkeeping, not for views: the host is being released for good and opens nothing more. */
  releasing: boolean;
};

export type ChatHostOptions = {
  chat?: Effect.Effect<ChatDependencies | null, unknown>;
  chatTargets?: readonly NamedChatTarget[];
  defaultChatTargetId?: string;
};

export type ChatHostShape = {
  readonly state: SubscriptionRef.SubscriptionRef<ChatHostState>;
  readonly targets: readonly { id: string; label: string }[];
  /** Whether a chat capability was supplied at all. */
  readonly configured: boolean;
  /** Opens the selected target's chat, or joins the open running; null when it has none. */
  readonly open: Effect.Effect<Context.Context<ChatServices> | null, ApplicationLifecycleError>;
  /**
   * Closes the chat if its drafts are preserved, releasing it in the background; false when it
   * isn't open, is closing, or its drafts couldn't be kept.
   */
  readonly close: Effect.Effect<boolean>;
  /** Closes the current chat (if its drafts are kept) and opens another target's. */
  readonly select: (
    id: string,
  ) => Effect.Effect<Context.Context<ChatServices> | null, ApplicationLifecycleError>;
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

type Chat = Context.Context<ChatServices>;

/** Fences or reopens a chat's admissions. */
const fenceChat = (chat: Chat, open: boolean) =>
  Context.get(chat, ChatActions).setAdmissionsOpen(open);

/** Waits for the fiber a handle runs, if any. */
const awaitHandle = <A, E>(handle: FiberHandle.FiberHandle<A, E>) =>
  Effect.flatMap(FiberHandle.get(handle), (running) =>
    Option.isSome(running) ? Effect.asVoid(Fiber.await(running.value)) : Effect.void,
  );

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
        const composers = yield* ChatComposers;
        const transcriptMemory = new TranscriptViewMemory();
        const targets = options.chatTargets ?? [];
        const configured = !!options.chat || targets.length > 0;
        const state = yield* SubscriptionRef.make<ChatHostState>({
          targetId: options.defaultChatTargetId ?? targets[0]?.id ?? null,
          status: 'unavailable',
          error: null,
          chat: null,
          composer: null,
          cleanupPending: false,
          cleanupErrors: [],
          closing: false,
          releasing: false,
        });
        /** The open chat's scope: replacing it releases the chat and composer built in it. */
        const instance = yield* ScopedRef.fromAcquire(Effect.scope);
        // Made after the instance, so closing the host interrupts its steps before the release.
        const opening = yield* FiberHandle.make<Chat | null, ApplicationLifecycleError>();
        const switching = yield* FiberHandle.make<Chat | null, ApplicationLifecycleError>();
        /** Releases of closed chats, which run on after their close. */
        const cleanups = yield* FiberSet.make<void>();
        const get = SubscriptionRef.get(state);
        const update = (f: (s: ChatHostState) => ChatHostState) => SubscriptionRef.update(state, f);
        const releasing = Effect.map(get, (s) => s.releasing);
        const stopAll = Effect.andThen(
          update((s) => ({ ...s, releasing: true })),
          Effect.sync(() => transcriptMemory.clear()),
        );
        yield* Effect.addFinalizer(() => stopAll);
        const fail = (reason: ApplicationLifecycleError['reason'], detail?: string) =>
          Effect.fail(new ApplicationLifecycleError({ reason, detail }));
        const describeCleanup = (error: unknown) => describeApplicationFailure(error).slice(0, 512);
        const recordCleanupError = (error: unknown) =>
          update((s) => ({
            ...s,
            cleanupErrors: [...s.cleanupErrors, describeCleanup(error)].slice(-4),
          }));
        /** What the release that blocks reopening failed with; Quit's failures don't replace it. */
        const blockingCleanup = yield* Ref.make<string | undefined>(undefined);

        /** Releases the chat's scope as the application's cleanup, which blocks reopening. */
        const ownCleanup = Effect.gen(function* () {
          yield* update((s) => ({ ...s, cleanupPending: true }));
          const exit = yield* Effect.exit(ScopedRef.set(instance, Effect.scope));
          yield* update((s) => ({ ...s, cleanupPending: false }));
          if (Exit.isFailure(exit)) {
            const error = failureOf(exit);
            yield* recordCleanupError(error);
            yield* Ref.set(blockingCleanup, describeCleanup(error));
            yield* update((s) => ({
              ...s,
              status: 'cleanup-blocked',
              error: describeApplicationFailure(error),
            }));
            return yield* Effect.fail(error);
          }
        });

        const acquire = Effect.gen(function* () {
          const scope = yield* ScopedRef.get(instance);
          const { targetId } = yield* get;
          const capability =
            targets.find((target) => target.id === targetId)?.acquire ?? options.chat!;
          const opened = yield* Effect.exit(
            Effect.gen(function* () {
              const dependencies = yield* capability;
              if (!dependencies || (yield* releasing)) return null;
              const chat = yield* Layer.buildWithScope(
                chatLayer({
                  ...dependencies,
                  backendId: targetId ?? dependencies.backendId,
                  transcriptMemory,
                }),
                scope,
              );
              const composer = yield* composers
                .make(makeComposerChat(chat))
                .pipe(Effect.provideService(Scope.Scope, scope));
              return { chat, composer };
            }),
          );
          if (Exit.isSuccess(opened) && opened.value && !(yield* releasing)) {
            const { chat, composer } = opened.value;
            yield* update((s) => ({ ...s, status: 'ready', chat, composer }));
            return chat;
          }
          if (Exit.isSuccess(opened)) {
            const released = yield* Effect.exit(ownCleanup);
            if (Exit.isSuccess(released) && !(yield* releasing))
              yield* update((s) => ({ ...s, status: 'unavailable' }));
            return null;
          }
          const errors: unknown[] = [failureOf(opened)];
          yield* update((s) => ({ ...s, status: 'initialization-failed' }));
          const released = yield* Effect.exit(ownCleanup);
          if (Exit.isFailure(released)) {
            errors.push(failureOf(released));
            yield* update((s) => ({ ...s, status: 'cleanup-blocked' }));
          }
          yield* update((s) => ({ ...s, error: joinFailures(errors) }));
          return null;
        });

        /** Opens the selected target's chat in `opening`, which later callers join. */
        const openSelected = runOrJoin(
          opening,
          Effect.gen(function* () {
            const current = yield* get;
            if (current.releasing) return yield* fail('closing');
            if (current.chat) return current.chat;
            if (!configured) return null;
            if (current.cleanupPending || current.status === 'cleanup-blocked')
              return yield* fail('cleanup-pending');
            yield* update((s) => ({ ...s, status: 'opening', error: null }));
            return yield* acquire;
          }),
        );

        const close: Effect.Effect<boolean> = Effect.gen(function* () {
          const taken = yield* SubscriptionRef.modify(state, (s) =>
            s.releasing || !s.chat || s.closing
              ? [undefined, s]
              : [s.chat, { ...s, closing: true }],
          );
          if (!taken) return false;
          yield* fenceChat(taken, false);
          return yield* Effect.gen(function* () {
            const kept = yield* Context.get(taken, ChatDrafts).preserve;
            const now = yield* get;
            if (!kept || now.releasing || now.chat !== taken) return false;
            yield* update((s) => ({ ...s, status: 'closed', chat: null, composer: null }));
            yield* FiberSet.run(cleanups, Effect.ignore(ownCleanup));
            return true;
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                const now = yield* get;
                if (!now.releasing && now.chat === taken) yield* fenceChat(taken, true);
                yield* update((s) => ({ ...s, closing: false }));
              }),
            ),
          );
        });

        /** Closes the open chat and opens target `id`'s, in `switching`. */
        const switchTo = (id: string) =>
          Effect.gen(function* () {
            yield* awaitHandle(opening);
            if ((yield* get).chat && !(yield* close)) return yield* fail('preserve-first');
            yield* FiberSet.awaitEmpty(cleanups);
            if (yield* releasing) return null;
            yield* update((s) => ({ ...s, targetId: id }));
            return yield* openSelected;
          });

        return {
          state,
          targets: targets.map(({ id, label }) => ({ id, label })),
          configured,
          open: Effect.suspend(() => {
            const running = FiberHandle.getUnsafe(switching);
            return Option.isSome(running) ? Fiber.join(running.value) : openSelected;
          }),
          close,
          select: (id) =>
            Effect.gen(function* () {
              const current = yield* get;
              const switchRunning = Option.isSome(yield* FiberHandle.get(switching));
              if (current.releasing || switchRunning || !targets.some((target) => target.id === id))
                return yield* fail('target-unavailable');
              if (id === current.targetId) return yield* openSelected;
              return yield* runOrJoin(switching, switchTo(id));
            }),
          settle: Effect.andThen(awaitHandle(switching), awaitHandle(opening)),
          busy: Effect.map(
            Effect.all([FiberHandle.get(opening), FiberHandle.get(switching), get]),
            ([open, switched, s]) => Option.isSome(open) || Option.isSome(switched) || s.closing,
          ),
          fence: (open) =>
            Effect.flatMap(get, (s) => (s.chat ? fenceChat(s.chat, open) : Effect.void)),
          preserve: Effect.flatMap(get, (s) =>
            s.chat ? Context.get(s.chat, ChatDrafts).preserve : Effect.succeed(true),
          ),
          release: Effect.gen(function* () {
            yield* stopAll;
            const taken = yield* SubscriptionRef.modify(state, (s) => [
              s.chat,
              { ...s, chat: null, composer: null },
            ]);
            if (taken) yield* fenceChat(taken, false);
            yield* awaitHandle(opening);
            yield* awaitHandle(switching);
            // An acquisition that finished meanwhile released its own chat.
            if (taken) yield* Effect.exit(ownCleanup);
            else yield* FiberSet.awaitEmpty(cleanups);
            if ((yield* get).status === 'cleanup-blocked')
              return yield* fail('cleanup-failed', yield* Ref.get(blockingCleanup));
          }),
          reportCleanup: recordCleanupError,
        } satisfies ChatHostShape;
      }),
    );
}
