import { Cause, Effect, Exit, Fiber, Stream, type ManagedRuntime } from 'effect';
import { CancelledError } from '@moonbase/contracts/errors';
import { HostUnavailableError } from '@moonbase/contracts/host-errors';
import type {
  ChatCommand,
  ChatInput,
  ChatListUpdate,
  ChatOutput,
  ChatSession,
  ChatSnapshot,
  ChatTarget,
} from '@moonbase/contracts/chat';
import type {
  ConnectionCommand,
  ConnectionInput,
  ConnectionOutput,
  ConnectionSnapshot,
} from '@moonbase/contracts/connection';
import type { ProviderCommand, ProviderInput, ProviderState } from '@moonbase/contracts/providers';
import { ChatService, ConnectionService, ProviderSetupService } from '@moonbase/contracts/services';

// Test support: a runtime's chat, connection and provider setup services, called from Promise
// tests. A call rejects with the service's own tagged error, or `CancelledError` once interrupted;
// a watch hands each value and its failure to callbacks until it is closed.

type Runner<R> = Pick<
  ManagedRuntime.ManagedRuntime<R, unknown>,
  'runPromiseExit' | 'runPromise' | 'runFork'
>;
type Options = { signal?: AbortSignal };

/** Runs `effect` for a test: its value, or a rejection with its failure. */
async function call<A, E, R>(
  runtime: Runner<R>,
  effect: Effect.Effect<A, E, R>,
  operation: string,
  options?: Options,
): Promise<A> {
  if (options?.signal?.aborted) throw new CancelledError({ operation });
  // A runtime already disposed runs nothing: the host is as good as gone.
  const exit = await runtime
    .runPromiseExit(effect, options)
    .catch(() => Exit.fail(new HostUnavailableError({ reason: 'closed' })));
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag === 'Some') throw failure.value;
  if (Cause.hasInterruptsOnly(exit.cause)) throw new CancelledError({ operation });
  throw Cause.squash(exit.cause);
}

/**
 * Watches `stream` until the returned close, which stops delivery at once, ends the watch and
 * rejects with its failure if it failed, or with its release's defect.
 */
function watch<A, E, R>(
  runtime: Runner<R>,
  stream: Stream.Stream<A, E, R>,
  receive: (value: A) => void,
  onError: (error: E) => void,
) {
  let closing = false;
  let failed: { error: E } | undefined;
  const fiber = runtime.runFork(
    Stream.runForEach(stream, (value) =>
      Effect.sync(() => {
        if (!closing) receive(value);
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          failed = { error };
          if (!closing) onError(error);
        }),
      ),
    ),
  );
  return async () => {
    closing = true;
    // Interrupting needs nothing of the runtime, which may already be disposed.
    const exit = await Effect.runPromise(
      Effect.andThen(Fiber.interrupt(fiber), Fiber.await(fiber)),
    );
    if (failed) throw failed.error;
    // A release that failed as the watch ended.
    if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) throw Cause.squash(exit.cause);
  };
}

/** The runtime's `ChatService`. */
export const makeChatCalls = <R>(runtime: Runner<R | ChatService>) => ({
  command: <K extends ChatCommand>(operation: K, input: ChatInput<K>, options?: Options) =>
    call(
      runtime,
      Effect.flatMap(ChatService, (chat) =>
        (chat[operation] as (input: ChatInput<K>) => Effect.Effect<ChatOutput<K>, unknown>)(input),
      ),
      operation,
      options,
    ),
  watch: (
    input: { target: ChatTarget },
    receive: (snapshot: ChatSnapshot) => void,
    onError: (error: unknown) => void,
  ) =>
    watch(
      runtime,
      Stream.unwrap(Effect.map(ChatService, (chat) => chat.watch(input))),
      receive,
      onError,
    ),
  watchChatList: (
    input: { session: ChatSession },
    receive: (update: ChatListUpdate) => void,
    onError: (error: unknown) => void,
  ) =>
    watch(
      runtime,
      Stream.unwrap(Effect.map(ChatService, (chat) => chat.watchChatList(input))),
      receive,
      onError,
    ),
});

/** The runtime's `ConnectionService`. */
export const makeConnectionCalls = <R>(runtime: Runner<R | ConnectionService>) => ({
  command: <K extends ConnectionCommand>(
    operation: K,
    input: ConnectionInput<K>,
    options?: Options,
  ) =>
    call(
      runtime,
      Effect.flatMap(ConnectionService, (connection) =>
        (
          connection[operation] as (
            input: ConnectionInput<K>,
          ) => Effect.Effect<ConnectionOutput<K>, unknown>
        )(input),
      ),
      operation,
      options,
    ),
  watch: (receive: (snapshot: ConnectionSnapshot) => void, onError: (error: unknown) => void) =>
    watch(
      runtime,
      Stream.unwrap(Effect.map(ConnectionService, (connection) => connection.watch())),
      receive,
      onError,
    ),
});

/** The runtime's `ProviderSetupService`, as `ownerId`. */
export const makeProviderSetupCalls = <R>(
  runtime: Runner<R | ProviderSetupService>,
  ownerId: string,
) => ({
  command: <K extends ProviderCommand>(operation: K, input: ProviderInput<K>, options?: Options) =>
    call(
      runtime,
      Effect.flatMap(ProviderSetupService, (service) =>
        (
          service.forOwner(ownerId)[operation] as (
            input: ProviderInput<K>,
          ) => Effect.Effect<ProviderState, unknown>
        )(input),
      ),
      operation,
      options,
    ),
  watch: (receive: (state: ProviderState) => void, onError: (error: unknown) => void) =>
    watch(
      runtime,
      Stream.unwrap(Effect.map(ProviderSetupService, (service) => service.watch(ownerId))),
      receive,
      onError,
    ),
});
