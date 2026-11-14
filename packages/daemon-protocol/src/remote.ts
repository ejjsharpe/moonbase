import { normalizeApplicationError } from '@moonbase/effect';
import { Cause, Context, Effect, Exit, Fiber, Layer, Queue, Semaphore, Stream } from 'effect';
import { getJsonKey } from '@moonbase/contracts/common';
import type { ChatHostHealth, ChatHostTarget } from '@moonbase/contracts/host';
import { ApplicationError } from '@moonbase/contracts/workspace';
import {
  ConnectionService,
  WorkspaceHostService,
  type WorkspaceHostServiceShape,
  type VerifiedChatEndpoint,
} from '@moonbase/contracts/services';
import { decodeChatHostTarget } from '@moonbase/contracts/host-schema';
import type { HostCommand, HostInput, HostOutput } from '@moonbase/contracts/workspace-host';
import {
  decodeHostInput,
  hostDeadlineMs,
  hostInputCheckout,
  hostInputSchemas,
  isHostMutation,
} from '@moonbase/contracts/workspace-host-schema';
import { socketLimits } from '@moonbase/contracts/socket';
import { toConnectionApplicationError } from '@moonbase/contracts/connection-errors';
import type {
  SocketSubscriptionKind,
  SocketSubscriptionTarget,
  SocketSubscriptionValue,
} from '@moonbase/contracts/socket';
import * as P from './protocol.ts';
import { isSameChatHost } from '@moonbase/contracts/chat-validation';
import { fail } from '@moonbase/contracts/errors';
import {
  connectDaemonSocket,
  type DaemonSocket,
  type SocketInput,
  type SocketOperation,
  type SocketOutput,
  type SocketSubscriptionState,
} from './socket-client.ts';

/** What a subscription delivers: a value (`reset` after one that replaced missed updates) or a gap. */
type LinkUpdate<K extends SocketSubscriptionKind> =
  | { value: SocketSubscriptionValue<K>; reset: boolean }
  | { reconnecting: true };
/** Where a followed subscription's updates and failure go. */
type Sink<K extends SocketSubscriptionKind> = {
  offer(update: LinkUpdate<K>): void;
  fail(cause: Cause.Cause<ApplicationError>): Effect.Effect<void>;
};
/**
 * One authenticated WebSocket per connection generation, shared by every service built with it:
 * requests and subscriptions to the daemon the connection serves.
 */
class DaemonLink extends Context.Service<
  DaemonLink,
  {
    /**
     * Sends one request. A mutation whose reply is lost, late or arrives after the connection
     * changed is `Uncertain` and is never sent again; `check` refuses a reply against the
     * daemon's authenticated health.
     */
    request<K extends SocketOperation>(
      host: ChatHostTarget,
      operation: K,
      input: SocketInput<K>,
      mutation: boolean,
      check?: (output: SocketOutput<K>, health: ChatHostHealth) => void,
      /** How long to wait for the reply; `requestDeadlineMs` by default. */
      deadlineMs?: number,
      /**
       * Called once the daemon is done with the request (its reply, to a cancel too, or the
       * connection closing), or at once if none was sent. A deadline or an interrupt cancels a
       * read and leaves a mutation running, so this can come later than the request's own result.
       */
      settled?: () => void,
    ): Effect.Effect<SocketOutput<K>, ApplicationError>;
    /**
     * Follows a subscription. When its connection drops it reconnects within a budget of
     * `reconnectMs` per outage (renewed once a connection has carried traffic for `renewMs` after
     * its first update) and resumes from the update it last applied. It fails when the daemon ends
     * it, the connection generation changes or the budget runs out.
     */
    subscribe<K extends SocketSubscriptionKind>(
      host: ChatHostTarget,
      kind: K,
      target: SocketSubscriptionTarget<K>,
    ): Stream.Stream<LinkUpdate<K>, ApplicationError>;
  }
>()('moonbase/DaemonLink') {}

export { DaemonLinkClock } from './link-clock.ts';
import { DaemonLinkClock } from './link-clock.ts';
const sameEndpoint = (a: VerifiedChatEndpoint, b: VerifiedChatEndpoint) =>
  a.connectionId === b.connectionId &&
  a.origin === b.origin &&
  a.token === b.token &&
  isSameChatHost(a.expected, b.expected);
const generationChanged = (mutation: boolean) =>
  new ApplicationError({
    code: mutation ? 'Uncertain' : 'Unavailable',
    message: mutation
      ? 'Connection changed after a chat mutation was sent. Preserve its original request and reconcile through its authority.'
      : 'Connection generation changed; query through the selected authority again.',
  });
const lostReply = (mutation: boolean) =>
  new ApplicationError({
    code: mutation ? 'Uncertain' : 'Unavailable',
    message: mutation
      ? 'Chat reply was lost. Query the original request; do not invent another Send.'
      : 'Chat reply was lost. Retry the read through the selected authority.',
  });
// Codes a request fails with before it is sent; such a request never reached the daemon.
const refusedBeforeSending = new Set(['InvalidInput', 'Incompatible', 'Cancelled']);

const DaemonLinkLive: Layer.Layer<DaemonLink, never, ConnectionService> = Layer.effect(
  DaemonLink,
  Effect.gen(function* () {
    const connections = yield* ConnectionService;
    // A connection failure reaches chat, folder and provider callers as the legacy error.
    const lookUpEndpoint = (host: ChatHostTarget) =>
      connections.endpoint({ host }).pipe(Effect.mapError(toConnectionApplicationError));
    const clock = yield* DaemonLinkClock;
    const scope = yield* Effect.scope;
    const sleep = (ms: number) =>
      Effect.callback<void>((resume) => {
        const handle = clock.setTimeout(() => resume(Effect.void), ms);
        return Effect.sync(() => clock.clearTimeout(handle));
      });
    let current: { endpoint: VerifiedChatEndpoint; socket: Promise<DaemonSocket> } | undefined,
      released = false;
    const closeSocket = (socket: Promise<DaemonSocket>) =>
      void socket.then(
        (open) => open.close(),
        () => {},
      );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        released = true;
        if (current) closeSocket(current.socket);
        current = undefined;
      }),
    );
    /** The open socket for `endpoint`, or a new one; a socket of an older generation closes. */
    const open = (endpoint: VerifiedChatEndpoint): Promise<DaemonSocket> => {
      if (released)
        return Promise.reject(
          new ApplicationError({
            code: 'Unavailable',
            message: 'The daemon client was released.',
          }),
        );
      if (current && sameEndpoint(current.endpoint, endpoint)) return current.socket;
      if (current) closeSocket(current.socket);
      const link = {
        endpoint,
        socket: connectDaemonSocket(endpoint, { clock }),
      };
      current = link;
      const forget = () => {
        if (current === link) current = undefined;
      };
      link.socket.then((socket) => socket.closed.then(forget), forget);
      return link.socket;
    };
    const acquire = (host: ChatHostTarget) =>
      Effect.gen(function* () {
        const endpoint = yield* lookUpEndpoint(host);
        const socket = yield* Effect.tryPromise({
          try: () => open(endpoint),
          catch: (error) =>
            ApplicationError.is(error)
              ? error
              : new ApplicationError({
                  code: 'Unavailable',
                  message: 'The daemon could not be reached.',
                }),
        });
        return { endpoint, socket };
      });
    const isCurrent = (host: ChatHostTarget, endpoint: VerifiedChatEndpoint) =>
      Effect.map(Effect.exit(lookUpEndpoint(host)), (now) =>
        Exit.isSuccess(now) ? sameEndpoint(now.value, endpoint) : false,
      );

    /**
     * Follows one socket subscription into `sink` until it fails; `reset` marks a snapshot that
     * arrived when it subscribed again after a reconnect, so updates may have been missed.
     */
    const follow = <K extends SocketSubscriptionKind>(
      host: ChatHostTarget,
      kind: K,
      target: SocketSubscriptionTarget<K>,
      sink: Sink<K>,
    ) =>
      Effect.gen(function* () {
        const first = yield* lookUpEndpoint(host);
        const stale = Effect.flatMap(isCurrent(host, first), (same) =>
          same ? Effect.void : Effect.fail(generationChanged(false)),
        );
        const failWith = (effect: Effect.Effect<unknown, ApplicationError>) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.void : sink.fail(cause),
            ),
            Effect.forkScoped,
          );
        // A connection publication fails the subscription once its generation is gone.
        yield* failWith(
          connections.watch().pipe(
            Stream.mapError(toConnectionApplicationError),
            Stream.runForEach(() => stale),
          ),
        );
        let state: SocketSubscriptionState<K> | undefined,
          delivered = false,
          failures = 0;
        type Ended = {
          error: ApplicationError;
          closed: boolean;
          renewed: boolean;
        };
        const followSocket = (socket: DaemonSocket) =>
          Effect.callback<Ended>((resume) => {
            let firstAt: number | undefined,
              // A snapshot first after subscribing again replaced whatever was missed meanwhile.
              resuming = delivered;
            const subscription = socket.subscribe(
              kind,
              target,
              {
                receive(value, update) {
                  firstAt ??= socket.lastReceived;
                  const reset = resuming && update === 'snapshot';
                  resuming = false;
                  delivered = true;
                  state = subscription.state;
                  sink.offer({ value, reset });
                },
                onError(error, closed) {
                  state = subscription.state ?? state;
                  resume(
                    Effect.succeed({
                      error,
                      closed,
                      renewed:
                        firstAt !== undefined &&
                        socket.lastReceived - firstAt >= P.streamLimits.renewMs,
                    }),
                  );
                },
              },
              state,
            );
            return Effect.sync(() => subscription.close());
          });
        const loop = Effect.gen(function* () {
          for (;;) {
            const acquired = yield* Effect.exit(acquire(host));
            let ended: Ended;
            if (Exit.isSuccess(acquired)) {
              if (!sameEndpoint(acquired.value.endpoint, first))
                return yield* Effect.fail(generationChanged(false));
              ended = yield* followSocket(acquired.value.socket);
              if (!ended.closed) return yield* Effect.fail(ended.error);
            } else {
              const error = Cause.squash(acquired.cause);
              if (Cause.hasInterruptsOnly(acquired.cause)) return yield* acquired;
              ended = {
                error: ApplicationError.is(error) ? error : lostReply(false),
                closed: true,
                renewed: false,
              };
            }
            yield* stale;
            if (ended.renewed) failures = 0;
            if (ended.error.code !== 'Unavailable' || failures >= P.streamLimits.reconnectMs.length)
              return yield* Effect.fail(ended.error);
            if (delivered) sink.offer({ reconnecting: true });
            yield* sleep(P.streamLimits.reconnectMs[failures++]!);
          }
        });
        yield* failWith(loop);
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : sink.fail(cause),
        ),
      );
    /**
     * Identical chat list and provider setup subscriptions share one socket subscription, so a
     * connection's 64 cover every window. A sink that joins one already delivering gets its
     * latest value at once; the last to leave closes it.
     */
    const shared = new Map<
      string,
      {
        sinks: Set<Sink<never>>;
        latest?: unknown;
        fiber?: Fiber.Fiber<unknown, unknown>;
      }
    >();
    const join = <K extends SocketSubscriptionKind>(
      host: ChatHostTarget,
      kind: K,
      target: SocketSubscriptionTarget<K>,
      sink: Sink<K>,
    ) =>
      Effect.gen(function* () {
        const key = getJsonKey({ kind, target });
        type Entry = {
          sinks: Set<Sink<K>>;
          latest?: SocketSubscriptionValue<K>;
          fiber?: Fiber.Fiber<unknown, unknown>;
        };
        let entry = shared.get(key) as Entry | undefined;
        if (entry) {
          if (entry.latest !== undefined) sink.offer({ value: entry.latest, reset: false });
          entry.sinks.add(sink);
        } else {
          const created: Entry = { sinks: new Set([sink]) };
          shared.set(key, created as never);
          entry = created;
          const fanOut: Sink<K> = {
            offer(update) {
              if ('value' in update) created.latest = update.value;
              for (const each of created.sinks) each.offer(update);
            },
            fail: (cause) =>
              Effect.suspend(() => {
                if (shared.get(key) === (created as never)) shared.delete(key);
                return Effect.forEach([...created.sinks], (each) => each.fail(cause), {
                  discard: true,
                });
              }),
          };
          created.fiber = yield* Effect.forkIn(
            Effect.scoped(Effect.andThen(follow(host, kind, target, fanOut), Effect.never)),
            scope,
          );
        }
        const joined = entry;
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() => {
            joined.sinks.delete(sink);
            if (joined.sinks.size) return Effect.void;
            if (shared.get(key) === (joined as never)) shared.delete(key);
            return joined.fiber ? Fiber.interrupt(joined.fiber) : Effect.void;
          }),
        );
      });

    return {
      request: (host, operation, input, mutation, check, deadlineMs, settled) => {
        let started = false;
        return Effect.gen(function* () {
          const { endpoint, socket } = yield* acquire(host);
          const attempt = yield* Effect.exit(
            Effect.tryPromise({
              try: (signal) => {
                started = true;
                return socket.request(operation, input, {
                  signal,
                  ...(settled ? { settled } : {}),
                });
              },
              catch: (error) => (ApplicationError.is(error) ? error : lostReply(mutation)),
            }).pipe(
              Effect.timeoutOrElse({
                duration: deadlineMs ?? P.requestDeadlineMs,
                orElse: () => Effect.fail(lostReply(mutation)),
              }),
            ),
          );
          if (Exit.isFailure(attempt)) {
            if (Cause.hasInterruptsOnly(attempt.cause)) return yield* attempt;
            const error = Cause.squash(attempt.cause);
            if (ApplicationError.is(error) && refusedBeforeSending.has(error.code))
              return yield* attempt;
          }
          // A reply belongs to the generation it was sent on; one that changed since is stale.
          if (!(yield* isCurrent(host, endpoint)))
            return yield* Effect.fail(generationChanged(mutation));
          const output = yield* attempt;
          yield* Effect.try({
            try: () => check?.(output, socket.health),
            catch: (error) => {
              if (mutation) return lostReply(true);
              return ApplicationError.is(error)
                ? error
                : new ApplicationError({
                    code: 'Incompatible',
                    message: 'The daemon sent an invalid reply.',
                  });
            },
          });
          return output;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (!started) settled?.();
            }),
          ),
        );
      },
      subscribe: <K extends SocketSubscriptionKind>(
        host: ChatHostTarget,
        kind: K,
        target: SocketSubscriptionTarget<K>,
      ) => {
        // Set when a snapshot replaced missed updates, until the consumer takes the next value.
        let resetPending = false;
        return Stream.callback<LinkUpdate<K>, ApplicationError>(
          (queue) => {
            const sink: Sink<K> = {
              offer(update) {
                if ('value' in update && update.reset) resetPending = true;
                Queue.offerUnsafe(queue, update);
              },
              fail: (cause) => Effect.asVoid(Queue.failCause(queue, cause)),
            };
            return kind === 'chat'
              ? follow(host, kind, target, sink)
              : join(host, kind, target, sink);
          },
          { bufferSize: 1, strategy: 'sliding' },
        ).pipe(
          Stream.map((update) => {
            if ('reconnecting' in update) return update;
            const reset = resetPending;
            resetPending = false;
            return { ...update, reset };
          }),
        );
      },
    };
  }),
);

/**
 * The file host of a daemon that advertises `workspace-v1`, over the shared WebSocket: every host
 * operation, each decoded before it leaves, refused unless the daemon advertises the capability
 * and for a checkout of another host, and answered within its deadline class. Mutations are never
 * sent again: a lost reply is `Uncertain`, and `saveStatus`, `operationStatus` or the request ID
 * of a repeat resolves it. At most `workspaceRequests` (plus `workspaceStatusRequests` for the
 * status calls) are in flight, leaving room for chat. A request waits up to the operation's
 * deadline for a place (`Unavailable`, never sent, past it), then has up to the deadline to run. A
 * request keeps its place until the daemon has answered it (a read past its deadline is
 * cancelled, and the daemon answers the cancel) or the connection closes, even after its caller
 * was told `Cancelled` or `Uncertain`, so the daemon's places and the client's agree.
 * `watch` ignores `paths`: the daemon follows the whole checkout, and every update, including the
 * snapshot after a reconnect, is an event to refresh from.
 */
export const RemoteWorkspaceHostLive = (config: {
  host: ChatHostTarget;
}): Layer.Layer<WorkspaceHostService, never, ConnectionService> =>
  Layer.effect(
    WorkspaceHostService,
    Effect.gen(function* () {
      const link = yield* DaemonLink;
      const host = decodeChatHostTarget(config.host);
      const permits = Semaphore.makeUnsafe(socketLimits.workspaceRequests);
      // The calls that resolve an `Uncertain` result have places of their own.
      const statusPermits = Semaphore.makeUnsafe(socketLimits.workspaceStatusRequests);
      // A permit is held until the daemon has answered (or the connection closed), not until the
      // caller gave up: a mutation past its deadline still counts against the server's limit, and
      // a cancelled read until the daemon answers its cancel.
      // Waiting for one is bounded by the operation's deadline, so a wedged host cannot leave a
      // caller waiting for ever; a request that never got one was never sent.
      const holdPermit = <A, E>(
        semaphore: Semaphore.Semaphore,
        deadlineMs: number,
        run: (free: () => void) => Effect.Effect<A, E>,
      ) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.flatMap(
            restore(
              semaphore.take(1).pipe(
                Effect.timeoutOrElse({
                  duration: deadlineMs,
                  orElse: () =>
                    Effect.fail(
                      new ApplicationError({
                        code: 'Unavailable',
                        message: 'The workspace is busy with earlier requests.',
                      }),
                    ),
                }),
              ),
            ),
            () => {
              let freed = false,
                entered = false;
              const free = () => {
                if (freed) return;
                freed = true;
                Effect.runSync(semaphore.release(1));
              };
              return restore(
                Effect.suspend(() => {
                  entered = true;
                  return run(free);
                }),
              ).pipe(
                Effect.onExit(() =>
                  Effect.sync(() => {
                    if (!entered) free();
                  }),
                ),
              );
            },
          ),
        );
      const statusOperations = new Set<string>(['saveStatus', 'operationStatus']);
      const checkoutMakers = new Set<string>([
        'openCheckout',
        'createWorktree',
        'initializeRepository',
        'createChatWorktree',
        'turnChatIntoProject',
      ]);
      const ownHost = (value: unknown) => {
        const checkout = hostInputCheckout(value);
        if (checkout && checkout.hostId !== host.hostId)
          fail('Unauthorized', 'Workspace request target differs from this host.');
      };
      /** The checkouts a reply names: the one it made or opened, an operation's, or a feed's. */
      const outputCheckouts = (operation: HostCommand, output: unknown) => {
        if (checkoutMakers.has(operation)) return [output as { hostId: string }];
        if (operation === 'mutate' || operation === 'operationStatus')
          return output ? [(output as HostOutput<'mutate'>).checkout] : [];
        if (operation === 'listOperations')
          return (output as HostOutput<'listOperations'>).operations.map((entry) => entry.checkout);
        return [];
      };
      // A reply naming a checkout of another host is refused (`Uncertain` for a mutation).
      const checkOutput = (operation: HostCommand) => (output: unknown) => {
        for (const checkout of outputCheckouts(operation, output))
          if (checkout.hostId !== host.hostId)
            fail('Incompatible', 'The daemon returned a checkout of another host.');
      };
      const send =
        <K extends HostCommand>(operation: K) =>
        (unknown: HostInput<K>): Effect.Effect<HostOutput<K>, ApplicationError> =>
          Effect.flatMap(
            Effect.try({
              try: () => {
                const input = decodeHostInput(operation, unknown);
                ownHost(input);
                return input;
              },
              catch: normalizeApplicationError,
            }),
            (input) =>
              holdPermit(
                statusOperations.has(operation) ? statusPermits : permits,
                hostDeadlineMs(operation),
                (free) =>
                  link.request(
                    host,
                    operation,
                    input as never,
                    isHostMutation(operation),
                    checkOutput(operation),
                    hostDeadlineMs(operation),
                    free,
                  ),
              ) as Effect.Effect<HostOutput<K>, ApplicationError>,
          );
      const handlers = Object.fromEntries(
        (Object.keys(hostInputSchemas) as HostCommand[]).map((operation) => [
          operation,
          send(operation),
        ]),
      ) as { [K in HostCommand]: ReturnType<typeof send<K>> };
      return {
        ...handlers,
        watch: ({ checkout }) =>
          Stream.unwrap(
            Effect.map(
              Effect.try({
                try: () => {
                  ownHost({ checkout });
                  return { checkout };
                },
                catch: normalizeApplicationError,
              }),
              (target) =>
                link.subscribe(host, 'workspace', target).pipe(
                  Stream.filter((update) => !('reconnecting' in update)),
                  // Only the value that first says the watch is ready is `ready`; every later one,
                  // a snapshot after a reconnect included, is a change to read again from.
                  Stream.mapAccum(
                    () => false,
                    (readySeen, update) => {
                      const { value } = update as Exclude<typeof update, { reconnecting: true }>;
                      return [
                        readySeen || value.ready,
                        [
                          {
                            checkout,
                            paths: [''],
                            ...(!readySeen && value.ready ? { ready: true } : {}),
                            ...(value.error ? { error: 'The workspace watch failed.' } : {}),
                          },
                        ],
                      ] as const;
                    },
                  ),
                ),
            ),
          ),
      } satisfies WorkspaceHostServiceShape;
    }),
  ).pipe(Layer.provide(DaemonLinkLive));

export {
  RemoteChatLive,
  RemoteDaemonLive,
  RemoteLocalHostLive,
  RemoteProviderSetupLive,
  type RemoteProviderSetupConfiguration,
} from './rpc-services.ts';
export { DaemonRpcLink, DaemonRpcLinkLive } from './rpc-link.ts';
export { EndpointConnectionLive } from './endpoint-connection.ts';
