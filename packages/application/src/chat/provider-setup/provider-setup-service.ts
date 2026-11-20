import {
  Cause,
  Context,
  Effect,
  Exit,
  FiberHandle,
  FiberSet,
  Fiber,
  Layer,
  Option,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import type { ProviderCommand, ProviderInput, ProviderState } from '@moonbase/contracts/providers';
import { ChatConfig } from '../chat-config.ts';
import type { ProviderSetupPort } from '../chat-ports.ts';
import { describeChatFailure, isChatUnavailable } from '../chat-errors.ts';
import { ChatActions } from '../actions/actions-service.ts';
import { retryWatch } from '../../watch-retry.ts';

export type ProviderSetupSnapshot = {
  status: ProviderState | null;
  /** A command is running. */
  busy: boolean;
  error: string | null;
};
/** Provider setup's state: what a view shows, and what decides whose reply shows. */
export type ProviderSetupState = ProviderSetupSnapshot & {
  /** The open watch has delivered: it is the state's source and command replies stop replacing it. */
  watched: boolean;
};

type Call = ReturnType<ProviderSetupPort['getProviders']>;
type Reply = Exit.Exit<Effect.Success<Call>, Effect.Error<Call>>;

export type ChatProviderSetupShape = {
  /** Whether the host serves provider setup. */
  readonly available: boolean;
  readonly state: SubscriptionRef.SubscriptionRef<ProviderSetupState>;
  readonly refresh: Effect.Effect<void>;
  readonly login: (providerId: string) => Effect.Effect<void>;
  readonly answer: (flowId: string, promptId: string, answer: string) => Effect.Effect<void>;
  readonly cancel: (flowId: string) => Effect.Effect<void>;
  readonly openUrl: (flowId: string) => Effect.Effect<void>;
  readonly logout: (providerId: string) => Effect.Effect<void>;
};

/**
 * Provider sign-in on the chat's host. Transient state only: answers never enter snapshots or
 * draft storage. The state comes from the host's watch once it delivers, so a sign-in's progress
 * appears without polling; until then command replies supply it, and only the newest command's
 * reply or error shows. A watch that fails `Unavailable` opens again on the shared backoff; after
 * that, or another failure, the next refresh, login or answer opens it again. Closing the chat
 * waits for running commands, then cancels a running sign-in.
 */
export class ChatProviderSetup extends Context.Service<ChatProviderSetup, ChatProviderSetupShape>()(
  'moonbase/chat/ChatProviderSetup',
) {
  static readonly layer = Layer.effect(
    ChatProviderSetup,
    Effect.gen(function* () {
      const { providers: port, limits } = yield* ChatConfig;
      const actions = yield* ChatActions;
      const state = yield* SubscriptionRef.make<ProviderSetupState>({
        status: null,
        busy: false,
        error: null,
        watched: false,
      });
      const watching = yield* FiberHandle.make<void, never>();
      /** A read and its reply, which a command that changes state interrupts: its reply is newer. */
      const reading = yield* FiberHandle.make<void, never>();
      /** Commands that change setup state: each runs to its end, even as the chat closes. */
      const mutations = yield* FiberSet.make<Reply, never>();
      /** Shows the newest mutation's reply once it settles; a newer mutation replaces it. */
      const replying = yield* FiberHandle.make<void, never>();
      /** Clears `busy` once no command runs; each command's start replaces it. */
      const settling = yield* FiberHandle.make<void, never>();
      /** Starting a command, and clearing `busy`, are one step each. */
      const starting = yield* Semaphore.make(1);
      const update = (f: (s: ProviderSetupState) => ProviderSetupState) =>
        SubscriptionRef.update(state, f);
      /** Shows a reply: a failure as the error, a success as the status until the watch delivers. */
      const show = (reply: Reply) =>
        update((s) => {
          if (Exit.isSuccess(reply)) return s.watched ? s : { ...s, status: reply.value };
          return Cause.hasInterruptsOnly(reply.cause)
            ? s
            : { ...s, error: describeChatFailure(Cause.squash(reply.cause)) };
        });
      const settle = Effect.gen(function* () {
        yield* FiberSet.awaitEmpty(mutations);
        yield* FiberHandle.awaitEmpty(reading);
        yield* FiberHandle.awaitEmpty(replying);
        yield* starting.withPermit(update((s) => ({ ...s, busy: false })));
      });

      if (port)
        // Registered last, so it runs first: running commands settle and show their replies, then
        // a sign-in still running is cancelled, so it doesn't outlive the chat.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* FiberHandle.clear(watching);
            yield* FiberSet.awaitEmpty(mutations);
            yield* FiberHandle.awaitEmpty(replying);
            const flow = (yield* SubscriptionRef.get(state)).status?.flow;
            if (flow?.state === 'running')
              yield* Effect.ignore(port.cancelProviderLogin({ flowId: flow.id }));
          }),
        );

      /** A command starts: it clears the last error until its own reply. */
      const begin = update((s) => ({ ...s, busy: true, error: null }));
      /** Starts a read unless a mutation runs, whose reply is newer. */
      const startRead = (call: Call) =>
        Effect.gen(function* () {
          if (yield* FiberSet.size(mutations)) return [];
          yield* begin;
          return [yield* FiberHandle.run(reading, Effect.flatMap(Effect.exit(call), show))];
        });
      /** Starts a mutation, which supersedes the read and an older mutation's reply. */
      const startMutation = (call: Call) =>
        Effect.gen(function* () {
          yield* begin;
          yield* FiberHandle.clear(reading);
          const mutation = yield* FiberSet.run(
            mutations,
            Effect.uninterruptible(Effect.exit(call)),
          );
          const reply = yield* FiberHandle.run(
            replying,
            Effect.flatMap(Fiber.join(mutation), show),
          );
          return [reply, mutation];
        });
      const command = <K extends ProviderCommand>(operation: K, input: ProviderInput<K>) =>
        Effect.gen(function* () {
          const setup = port;
          if (!setup || !(yield* actions.accepting)) return;
          const call = (setup[operation] as (input: ProviderInput<K>) => Call)(input);
          const start = operation === 'getProviders' ? startRead : startMutation;
          const started: readonly Fiber.Fiber<unknown>[] = yield* starting.withPermit(
            Effect.gen(function* () {
              const fibers: readonly Fiber.Fiber<unknown>[] = yield* start(call);
              if (fibers.length) yield* FiberHandle.run(settling, settle);
              return fibers;
            }),
          );
          yield* Effect.forEach(started, Fiber.await, { discard: true });
        });

      /** Opens the watch unless one is open or waiting to reopen. */
      const watch = Effect.gen(function* () {
        if (!port || !(yield* actions.accepting)) return;
        if (Option.isSome(yield* FiberHandle.get(watching))) return;
        const attempt = (_rewatched: boolean, up: Effect.Effect<void>) =>
          port.watch().pipe(
            Stream.runForEach((status) =>
              Effect.andThen(
                up,
                update((s) => ({ ...s, status, watched: true })),
              ),
            ),
            Effect.ensuring(update((s) => ({ ...s, watched: false }))),
          );
        yield* FiberHandle.run(
          watching,
          Effect.ignore(
            retryWatch(attempt, {
              retryMs: limits.watchRetryMs,
              healthyMs: limits.watchHealthyMs,
              isRetryable: isChatUnavailable,
            }),
          ),
        );
      });
      /** Commands that start or continue a sign-in first make sure its progress is watched. */
      const watched = (work: Effect.Effect<void>) => Effect.andThen(watch, work);

      return {
        available: !!port,
        state,
        refresh: watched(command('getProviders', {})),
        login: (providerId) => watched(command('startProviderLogin', { providerId })),
        answer: (flowId, promptId, answer) =>
          watched(command('answerProviderPrompt', { flowId, promptId, answer })),
        cancel: (flowId) => command('cancelProviderLogin', { flowId }),
        openUrl: (flowId) => command('openProviderUrl', { flowId }),
        logout: (providerId) => command('logoutProvider', { providerId }),
      } satisfies ChatProviderSetupShape;
    }),
  );
}
