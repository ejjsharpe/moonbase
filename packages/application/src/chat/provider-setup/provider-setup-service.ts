import {
  Context,
  Effect,
  FiberHandle,
  FiberSet,
  Fiber,
  Layer,
  Option,
  Ref,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import type { ProviderCommand, ProviderInput } from '@moonbase/contracts/providers';
import { ChatConfig } from '../chat-config.ts';
import type { ProviderSetupPort } from '../chat-ports.ts';
import { isChatUnavailable } from '../chat-errors.ts';
import { ChatActions } from '../actions/actions-service.ts';
import { retryWatch } from '../../watch-retry.ts';
import {
  settleCommand,
  startCommand,
  type ProviderSetupCommand,
  type ProviderSetupState,
} from './provider-setup.ts';

type Call = ReturnType<ProviderSetupPort['getProviders']>;

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
        active: new Set(),
        owner: null,
        watched: false,
      });
      const watching = yield* FiberHandle.make<void, never>();
      /** A read, which a command that changes state interrupts: its reply is newer. */
      const reading = yield* FiberHandle.make<void, never>();
      /** Commands that change setup state: each runs to its end, even as the chat closes. */
      const mutations = yield* FiberSet.make<void, never>();
      const update = (f: (s: ProviderSetupState) => ProviderSetupState) =>
        SubscriptionRef.update(state, f);

      /**
       * Admitting work and registering its fiber are one step under this permit, so competing
       * starts and closing see each other whole: a command is either registered or never starts.
       */
      const admission = yield* Semaphore.make(1);
      const closing = yield* Ref.make(false);
      /** Runs `start` as one admitted step, unless the chat is closing. */
      const admit = <A>(start: Effect.Effect<A | undefined>) =>
        admission.withPermit(
          Effect.gen(function* () {
            if ((yield* Ref.get(closing)) || !(yield* actions.accepting)) return undefined;
            return yield* start;
          }),
        );

      if (port)
        // Registered last, so it runs first: admission stops, running commands settle and show
        // their replies, then a sign-in still running is cancelled, so it doesn't outlive the chat.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* admission.withPermit(Ref.set(closing, true));
            yield* FiberHandle.clear(watching);
            yield* FiberSet.awaitEmpty(mutations);
            const flow = (yield* SubscriptionRef.get(state)).status?.flow;
            if (flow?.state === 'running')
              yield* Effect.ignore(port.cancelProviderLogin({ flowId: flow.id }));
          }),
        );

      const command = <K extends ProviderCommand>(operation: K, input: ProviderInput<K>) =>
        // Starting is one step the caller can't interrupt, so a call that starts always settles;
        // the caller can stop waiting for it, and the command still settles by itself.
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const setup = port;
            if (!setup) return;
            const self: ProviderSetupCommand = { read: operation === 'getProviders' };
            const call = (setup[operation] as (input: ProviderInput<K>) => Call)(input);
            // A command settles once it ends, after its own cleanup, even if interrupted. A read is
            // interruptible; a mutation first interrupts the read, whose reply is older, then runs
            // to its end.
            const work = Effect.uninterruptible(
              Effect.exit(
                self.read
                  ? Effect.interruptible(call)
                  : Effect.andThen(FiberHandle.clear(reading), call),
              ).pipe(Effect.flatMap((reply) => update((s) => settleCommand(s, self, reply)))),
            );
            const fiber = yield* admit(
              Effect.gen(function* () {
                const started = yield* SubscriptionRef.modify(state, (s) => {
                  const next = startCommand(s, self);
                  return next ? [true, next] : [false, s];
                });
                if (!started) return undefined;
                return self.read
                  ? yield* FiberHandle.run(reading, work)
                  : yield* FiberSet.run(mutations, work);
              }),
            );
            if (fiber) yield* restore(Fiber.await(fiber));
          }),
        );

      /** Opens the watch unless one is open or waiting to reopen. */
      const watch = Effect.gen(function* () {
        if (!port) return;
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
        yield* admit(
          Effect.gen(function* () {
            if (Option.isSome(yield* FiberHandle.get(watching))) return;
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
          }),
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
