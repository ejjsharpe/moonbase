import { Cause, Context, Effect, Exit, Fiber, Layer, Queue, Semaphore, Stream } from 'effect';
import { getJsonKey } from '@moonbase/contracts/common';
import {
  chatHostCapabilities,
  type ChatHostHealth,
  type ChatHostTarget,
} from '@moonbase/contracts/host';
import { ApplicationError } from '@moonbase/contracts/workspace';
import type { ChatCommand, ChatInput, ChatOutput, ChatTarget } from '@moonbase/contracts/chat';
import {
  ChatService,
  ConnectionService,
  LocalHostService,
  ProviderSetupService,
  WorkspaceHostService,
  type ChatServiceShape,
  type WorkspaceHostServiceShape,
  type LocalHostHandlers,
  type ProviderSetupHandlers,
  type VerifiedChatEndpoint,
} from '@moonbase/contracts/services';
import { randomUUID } from 'node:crypto';
import type {
  DaemonCommand,
  DaemonInput,
  DaemonOutput,
  HostProviderCommand,
  LocalHostCommand,
  LocalHostInput,
} from '@moonbase/contracts/daemon';
import { decodeDaemonInput, isDaemonMutation } from '@moonbase/contracts/daemon-schema';
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
import type { ProviderCommand, ProviderInput, ProviderState } from '@moonbase/contracts/providers';
import { decodeProviderInput, readProviderSignInUrl } from '@moonbase/contracts/providers-schema';
import type {
  SocketSubscriptionKind,
  SocketSubscriptionTarget,
  SocketSubscriptionValue,
} from '@moonbase/contracts/socket';
import * as P from './protocol.ts';
import { decodeChatInput } from '@moonbase/contracts/chat-schema';
import {
  decodeChatTarget,
  isChatMutation,
  isSameChatHost,
} from '@moonbase/contracts/chat-validation';
import { fail } from '@moonbase/contracts/errors';
import {
  connectDaemonSocket,
  type DaemonSocket,
  type SocketInput,
  type SocketOperation,
  type SocketOutput,
  type SocketSubscriptionState,
} from './socket-client.ts';
import { systemSocketClock, type SocketClock } from './socket-protocol.ts';

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

/**
 * The clock a daemon link's sockets and reconnect backoff run on: the system's unless a test
 * provides one.
 */
export const DaemonLinkClock = Context.Reference<SocketClock>('moonbase/DaemonLinkClock', {
  defaultValue: () => systemSocketClock,
});
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
        const endpoint = yield* connections.endpoint({ host });
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
      Effect.map(Effect.exit(connections.endpoint({ host })), (now) =>
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
        const first = yield* connections.endpoint({ host });
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
        yield* failWith(connections.watch().pipe(Stream.runForEach(() => stale)));
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

/** Client graph imports no engine, SQLite, provider or local workspace implementation. */
export const RemoteChatLive: Layer.Layer<ChatService, never, ConnectionService> = Layer.effect(
  ChatService,
  Effect.gen(function* () {
    const link = yield* DaemonLink;
    const call = <K extends ChatCommand>(
      operation: K,
      unknown: ChatInput<K>,
    ): Effect.Effect<ChatOutput<K>, ApplicationError> =>
      Effect.gen(function* () {
        const input = yield* Effect.try({
          try: () => decodeChatInput(operation, unknown),
          catch: ApplicationError.fromUnknown,
        });
        const shape = input as {
          host?: ChatHostTarget;
          session?: { host: ChatHostTarget };
          target?: ChatTarget;
          source?: { target: ChatTarget };
          stop?: { target: ChatTarget };
        };
        const host =
          shape.host ??
          shape.session?.host ??
          shape.target?.host ??
          shape.source?.target.host ??
          shape.stop!.target.host;
        return (yield* link.request(
          host,
          operation,
          input as never,
          isChatMutation(operation),
          (output, health) => {
            // Every host is a daemon whose chats choose their own folder and model.
            if (
              operation === 'getChatHost' &&
              !health.capabilities.includes(chatHostCapabilities.local)
            )
              fail('Incompatible', 'This host does not run the Moonbase daemon. Update it.');
          },
        )) as ChatOutput<K>;
      });
    const validate = <A>(read: () => A) =>
      Effect.try({ try: read, catch: ApplicationError.fromUnknown });
    return {
      getChatHost: (d) => call('getChatHost', d),
      listChats: (d) => call('listChats', d),
      createChat: (d) => call('createChat', d),
      getChat: (d) => call('getChat', d),
      getChatHistory: (d) => call('getChatHistory', d),
      getChatTranscriptContent: (d) => call('getChatTranscriptContent', d),
      findChatTranscript: (d) => call('findChatTranscript', d),
      getChatHistoryAround: (d) => call('getChatHistoryAround', d),
      sendChat: (d) => call('sendChat', d),
      getChatSend: (d) => call('getChatSend', d),
      stopChat: (d) => call('stopChat', d),
      settleChat: (d) => call('settleChat', d),
      findChatFiles: (d) => call('findChatFiles', d),
      // While the connection is down the last snapshot is shown as reconnecting.
      watch: ({ target }) =>
        Stream.unwrap(
          Effect.map(
            validate(() => decodeChatTarget(target)),
            (checked) => {
              let last: SocketSubscriptionValue<'chat'> | undefined;
              return link.subscribe(checked.host, 'chat', checked).pipe(
                Stream.filter((update) => !('reconnecting' in update) || last !== undefined),
                Stream.map((update) => {
                  if ('reconnecting' in update)
                    return {
                      ...last!,
                      observationStatus: 'reconnecting' as const,
                    };
                  last = update.value;
                  return {
                    ...update.value,
                    observationStatus: 'connected' as const,
                  };
                }),
              );
            },
          ),
        ),
      watchChatList: ({ session }) =>
        Stream.unwrap(
          Effect.map(
            validate(() => decodeChatInput('listChats', { session }).session),
            (checked) =>
              link.subscribe(checked.host, 'chatList', checked).pipe(
                Stream.filter((update) => !('reconnecting' in update)),
                Stream.map((update) => {
                  const { value, reset } = update as Exclude<typeof update, { reconnecting: true }>;
                  return { ...value, reset };
                }),
              ),
          ),
        ),
    } satisfies ChatServiceShape;
  }),
).pipe(Layer.provide(DaemonLinkLive));

/**
 * Sends one daemon operation: decoded and bounded before it leaves, refused unless the daemon's
 * authenticated health advertises its capability, and its reply decoded strictly with any request
 * ID it carried echoed back.
 */
function sendDaemonCommand<K extends DaemonCommand>(
  link: DaemonLink['Service'],
  operation: K,
  unknown: DaemonInput<K>,
  check?: (output: DaemonOutput<K>, input: DaemonInput<K>) => void,
): Effect.Effect<DaemonOutput<K>, ApplicationError> {
  return Effect.flatMap(
    Effect.try({
      try: () => decodeDaemonInput(operation, unknown),
      catch: ApplicationError.fromUnknown,
    }),
    (input) => {
      const shape = input as { host?: ChatHostTarget; target?: ChatTarget };
      return link.request(
        shape.host ?? shape.target!.host,
        operation,
        input as never,
        isDaemonMutation(operation),
        check && ((output) => check(output as DaemonOutput<K>, input)),
      ) as Effect.Effect<DaemonOutput<K>, ApplicationError>;
    },
  );
}

/** A daemon's folder approvals and control, over an injected `ConnectionService`. */
export const RemoteLocalHostLive: Layer.Layer<LocalHostService, never, ConnectionService> =
  Layer.effect(
    LocalHostService,
    Effect.gen(function* () {
      const link = yield* DaemonLink;
      const send =
        <K extends LocalHostCommand>(operation: K) =>
        (input: LocalHostInput<K>) =>
          sendDaemonCommand(link, operation, input);
      return {
        approveFolder: send('approveFolder'),
        listRecentFolders: send('listRecentFolders'),
        checkChatFolder: send('checkChatFolder'),
        checkApprovedFolder: send('checkApprovedFolder'),
        getActiveWork: send('getActiveWork'),
        markFolderAsProject: send('markFolderAsProject'),
        listHostFolders: send('listHostFolders'),
      } satisfies LocalHostHandlers;
    }),
  ).pipe(Layer.provide(DaemonLinkLive));

export type RemoteProviderSetupConfiguration = {
  /** The local-mode host whose providers are set up. */
  host: ChatHostTarget;
  /** Opens a validated sign-in URL in the user's browser. */
  openUrl(url: string): Promise<void>;
  /**
   * Whether that browser runs on the host's machine, where a provider's loopback sign-in callback
   * (ChatGPT's `127.0.0.1:1455`) reaches the host and finishes sign-in by itself. Otherwise the
   * user pastes the final redirect URL.
   */
  sameMachine: boolean;
};
const sameMachineCallback =
  'Finish signing in in your browser; Moonbase completes it by itself. If it does not, paste the final redirect URL here.';
const pastedCallback =
  'Your browser cannot reach the host’s sign-in callback. After signing in, paste the final redirect URL here.';

/**
 * Provider setup on a local-mode host, scoped to owners the client names. Sign-in links come back
 * validated and open through the client's `openUrl`; setup state is pushed to `watch`.
 */
export const RemoteProviderSetupLive = (
  config: RemoteProviderSetupConfiguration,
): Layer.Layer<ProviderSetupService, never, ConnectionService> =>
  Layer.effect(
    ProviderSetupService,
    Effect.gen(function* () {
      const link = yield* DaemonLink;
      const host = decodeChatHostTarget(config.host);
      // Which ChatGPT sign-in path applies depends on where the browser is, which only the client
      // knows; its OAuth flow is the one whose callback listens on the host.
      const present = (state: ProviderState): ProviderState =>
        state.flow?.providerId === 'openai' && state.flow.prompt?.type === 'manual_code'
          ? {
              ...state,
              flow: {
                ...state.flow,
                prompt: {
                  ...state.flow.prompt,
                  message: config.sameMachine ? sameMachineCallback : pastedCallback,
                },
              },
            }
          : state;
      const checkUrl = (
        output: DaemonOutput<'openProviderUrl'>,
        input: DaemonInput<'openProviderUrl'>,
      ) => {
        if (
          readProviderSignInUrl(output.url) !== output.url ||
          output.state.flow?.id !== input.flowId
        )
          fail('Incompatible', 'Provider sign-in link is invalid.');
      };
      const openUrl = (url: string) =>
        Effect.tryPromise({
          try: () => config.openUrl(url),
          catch: () =>
            new ApplicationError({
              code: 'Unavailable',
              message: 'The provider sign-in page could not be opened.',
            }),
        });
      const forOwner = (ownerId: string): ProviderSetupHandlers => {
        const send = <K extends ProviderCommand & HostProviderCommand>(
          operation: K,
          unknown: ProviderInput<K>,
        ) =>
          Effect.flatMap(
            Effect.try({
              try: () => decodeProviderInput(operation, unknown),
              catch: ApplicationError.fromUnknown,
            }),
            (input) =>
              sendDaemonCommand(
                link,
                operation,
                {
                  host,
                  ownerId,
                  ...(isDaemonMutation(operation) ? { requestId: randomUUID() } : {}),
                  ...input,
                } as DaemonInput<K>,
                operation === 'openProviderUrl' ? (checkUrl as never) : undefined,
              ),
          );
        const state =
          <K extends ProviderCommand & HostProviderCommand>(operation: K) =>
          (input: ProviderInput<K>) =>
            Effect.map(send(operation, input), (output) =>
              present((output as { state: ProviderState }).state),
            );
        return {
          getProviders: state('getProviders'),
          startProviderLogin: state('startProviderLogin'),
          answerProviderPrompt: state('answerProviderPrompt'),
          cancelProviderLogin: state('cancelProviderLogin'),
          openProviderUrl: (input) =>
            Effect.flatMap(send('openProviderUrl', input), (output) =>
              Effect.as(openUrl(output.url), present(output.state)),
            ),
          logoutProvider: state('logoutProvider'),
        };
      };
      return {
        forOwner,
        releaseOwner: (ownerId) =>
          sendDaemonCommand(link, 'releaseProviderOwner', { host, ownerId }),
        watch: (ownerId) =>
          Stream.unwrap(
            Effect.map(
              Effect.try({
                try: () => decodeDaemonInput('getProviders', { host, ownerId }),
                catch: ApplicationError.fromUnknown,
              }),
              (target) =>
                link.subscribe(host, 'providerSetup', target).pipe(
                  Stream.filter((update) => !('reconnecting' in update)),
                  Stream.map((update) => present((update as { value: ProviderState }).value)),
                ),
            ),
          ),
        getProviderUrl: (ownerId, flowId) =>
          Effect.map(
            sendDaemonCommand(link, 'openProviderUrl', { host, ownerId, flowId }, checkUrl),
            (output) => output.url,
          ),
      };
    }),
  ).pipe(Layer.provide(DaemonLinkLive));

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
              catch: ApplicationError.fromUnknown,
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
                catch: ApplicationError.fromUnknown,
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
