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
  busy: boolean;
  error: string | null;
};
/** Provider setup's state: what a view shows, and what decides whose reply shows. */
export type ProviderSetupState = ProviderSetupSnapshot & {
  /** Commands running, and how many of them change setup state. */
  running: number;
  mutations: number;
  /** Counts the commands that changed setup state; only the newest one's reply or error shows. */
  latest: number;
  /** The open watch has delivered: it is the state's source and command replies stop replacing it. */
  watched: boolean;
};

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
 * appears without polling; until then command replies supply it. A watch that fails `Unavailable`
 * opens again on the shared backoff; after that, or another failure, the next refresh, login or
 * answer opens it again. Closing the chat waits for running commands, then cancels a running
 * sign-in.
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
        running: 0,
        mutations: 0,
        latest: 0,
        watched: false,
      });
      const watching = yield* FiberHandle.make<void, never>();
      /** Reads, which a command that changes state interrupts: its reply is newer. */
      const reading = yield* FiberHandle.make<void, never>();
      const mutations = yield* FiberSet.make<void, never>();
      const update = (f: (s: ProviderSetupState) => ProviderSetupState) =>
        SubscriptionRef.update(state, f);

      if (port)
        // Registered last, so it runs first: running commands settle, then a sign-in still running
        // is cancelled, so it doesn't outlive the chat.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* FiberHandle.clear(watching);
            yield* FiberSet.awaitEmpty(mutations);
            const flow = (yield* SubscriptionRef.get(state)).status?.flow;
            if (flow?.state === 'running')
              yield* Effect.ignore(port.cancelProviderLogin({ flowId: flow.id }));
          }),
        );

      const command = <K extends ProviderCommand>(operation: K, input: ProviderInput<K>) =>
        Effect.gen(function* () {
          const setup = port;
          if (!setup || !(yield* actions.accepting)) return;
          const read = operation === 'getProviders';
          // Starting is one step: a read waits for no mutation, and a mutation takes the next token.
          const token = yield* SubscriptionRef.modify(state, (s) => {
            if (read && s.mutations) return [undefined, s];
            const latest = read ? s.latest : s.latest + 1;
            return [
              latest,
              {
                ...s,
                busy: true,
                error: null,
                running: s.running + 1,
                mutations: s.mutations + (read ? 0 : 1),
                latest,
              },
            ];
          });
          if (token === undefined) return;
          if (!read) yield* FiberHandle.clear(reading);
          const call = (
            setup[operation] as (
              input: ProviderInput<K>,
            ) => ReturnType<ProviderSetupPort['getProviders']>
          )(input);
          const work = Effect.exit(call).pipe(
            Effect.flatMap((exit) =>
              update((s) => {
                const running = s.running - 1;
                const settled = {
                  ...s,
                  running,
                  busy: running > 0,
                  mutations: s.mutations - (read ? 0 : 1),
                };
                // A newer command's reply (or the watch, once it delivers) supersedes this one.
                if (s.latest !== token) return settled;
                if (Exit.isSuccess(exit))
                  return s.watched ? settled : { ...settled, status: exit.value };
                return Cause.hasInterruptsOnly(exit.cause)
                  ? settled
                  : { ...settled, error: describeChatFailure(Cause.squash(exit.cause)) };
              }),
            ),
          );
          // A command that changes setup state runs to its end, even as the chat closes.
          const fiber = read
            ? yield* FiberHandle.run(
                reading,
                work.pipe(
                  Effect.onInterrupt(() =>
                    update((s) => ({ ...s, running: s.running - 1, busy: s.running > 1 })),
                  ),
                ),
              )
            : yield* FiberSet.run(mutations, Effect.uninterruptible(work));
          yield* Fiber.await(fiber);
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
