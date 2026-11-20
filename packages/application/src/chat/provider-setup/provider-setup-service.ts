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
  /** A command is running. */
  busy: boolean;
  error: string | null;
};
/** A command that started; its identity is what `ProviderSetupState` tracks. */
type Command = { readonly read: boolean };
/** Provider setup's state: what a view shows, and what decides whose reply shows. */
export type ProviderSetupState = ProviderSetupSnapshot & {
  /** Commands that started and haven't settled; `busy` while any does. */
  active: ReadonlySet<Command>;
  /** The newest command: only its reply or error shows. */
  owner: Command | null;
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

/** A command starts, unless it is a read and a mutation runs, whose reply is newer. */
const startCommand = (s: ProviderSetupState, command: Command): ProviderSetupState | null =>
  command.read && [...s.active].some((other) => !other.read)
    ? null
    : { ...s, active: new Set([...s.active, command]), owner: command, busy: true, error: null };

/**
 * A command settles: it is no longer active, and its reply shows if it is still the newest
 * command, a failure as the error and a success as the status until the watch delivers.
 */
const settleCommand = (
  s: ProviderSetupState,
  command: Command,
  reply: Reply,
): ProviderSetupState => {
  const active = new Set(s.active);
  active.delete(command);
  const settled = { ...s, active, busy: active.size > 0 };
  if (s.owner !== command) return settled;
  if (Exit.isSuccess(reply)) return s.watched ? settled : { ...settled, status: reply.value };
  return Cause.hasInterruptsOnly(reply.cause)
    ? settled
    : { ...settled, error: describeChatFailure(Cause.squash(reply.cause)) };
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

      if (port)
        // Registered last, so it runs first: running commands settle and show their replies, then
        // a sign-in still running is cancelled, so it doesn't outlive the chat.
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
        // Starting is one step the caller can't interrupt, so a call that starts always settles;
        // the caller can stop waiting for it, and the command still settles by itself.
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const setup = port;
            if (!setup || !(yield* actions.accepting)) return;
            const self: Command = { read: operation === 'getProviders' };
            const started = yield* SubscriptionRef.modify(state, (s) => {
              const next = startCommand(s, self);
              return next ? [true, next] : [false, s];
            });
            if (!started) return;
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
            const fiber = self.read
              ? yield* FiberHandle.run(reading, work)
              : yield* FiberSet.run(mutations, work);
            yield* restore(Fiber.await(fiber));
          }),
        );

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
