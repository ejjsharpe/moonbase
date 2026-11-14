import { Deferred, Effect, Exit, Stream } from 'effect';
import { Rpc } from 'effect/rpc';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import type { ChatListState } from '@moonbase/contracts/chat';
import { isCancellableChatRead, isSameChatHost } from '@moonbase/contracts/chat-validation';
import { chatInputSchemas } from '@moonbase/contracts/chat-schema';
import {
  daemonCommandCapabilities,
  isDaemonMutation,
  localHostInputSchemas,
} from '@moonbase/contracts/daemon-schema';
import type { DaemonCommand } from '@moonbase/contracts/daemon';
import type { ChatHostHealth, ChatHostTarget } from '@moonbase/contracts/host';
import type {
  ChatServiceShape,
  LocalHostHandlers,
  ProviderSetupService,
} from '@moonbase/contracts/services';
import {
  socketLimits,
  type SocketDelta,
  type SocketSubscriptionKind,
  type SocketSubscriptionValue,
} from '@moonbase/contracts/socket';
import type { ChatCommand } from '@moonbase/contracts/chat';
import { UnauthorizedError } from '@moonbase/contracts/errors';
import {
  HostUnavailableError,
  IncompatibleHostError,
  RequestReusedError,
} from '@moonbase/contracts/host-errors';
import { chatRpcErrors } from '@moonbase/contracts/chat-rpc';
import { localHostRpcErrors, providerSetupRpcErrors } from '@moonbase/contracts/daemon-rpc';
import {
  ChatAccessError,
  ChatBusyError,
  InvalidChatRequestError,
} from '@moonbase/contracts/chat-errors';
import { FolderMissingError, FolderRefusedError } from '@moonbase/contracts/folder-errors';
import { ProviderSetupRefusedError } from '@moonbase/contracts/provider-errors';
import { projectSocketDelta } from './socket-deltas.ts';

/** The services one daemon serves over RPC, and what its health advertises. */
export type RpcServices = {
  host: ChatHostTarget;
  health: ChatHostHealth;
  chat: ChatServiceShape;
  daemon?: { localHost: LocalHostHandlers; providers: ProviderSetupService['Service'] };
};

const notServed = () => new IncompatibleHostError({ reason: 'not-served' });
/** Refuses a request for another host before its handler runs. */
const forHost = (services: RpcServices, host: ChatHostTarget, operation: string) =>
  isSameChatHost(host, services.host)
    ? Effect.void
    : Effect.fail(new UnauthorizedError({ operation }));

/**
 * A service's failure as its procedure's error union declares it: an error the union names is
 * sent as it is (its tag and fields, never a cause); anything else is the host's own failure.
 */
const toWire =
  (errors: readonly (abstract new (...args: never) => unknown)[]) => (error: unknown) => {
    try {
      if (errors.some((member) => error instanceof member)) return error as never;
    } catch {
      // A value whose prototype can't be read is no error of ours.
    }
    return new HostUnavailableError({ reason: 'failed' });
  };
const toChatWire = toWire(chatRpcErrors),
  toLocalHostWire = toWire(localHostRpcErrors),
  toProviderSetupWire = toWire(providerSetupRpcErrors);

/** A watch's update: a whole value, or a delta from the last one sent. */
export type Update<K extends SocketSubscriptionKind> =
  | { kind: 'snapshot'; value: SocketSubscriptionValue<K> }
  | { kind: 'delta'; delta: SocketDelta<K> };
/**
 * A watch's values as updates: the first whole, each later one as a delta from the last sent
 * where one pays (at most `socketLimits.deltaBytes`), else whole again. A value equal to the last
 * sent is skipped.
 */
export function toUpdates<K extends SocketSubscriptionKind, E>(
  kind: K,
  values: Stream.Stream<SocketSubscriptionValue<K>, E>,
) {
  return values.pipe(
    Stream.mapAccum(
      (): SocketSubscriptionValue<K> | undefined => undefined,
      (previous, next): readonly [SocketSubscriptionValue<K> | undefined, readonly Update<K>[]] => {
        if (previous === undefined) return [next, [{ kind: 'snapshot', value: next }]];
        const delta = projectSocketDelta(kind, previous, next);
        if (delta === null) return [previous, []];
        if (delta !== undefined && JSON.stringify(delta).length <= socketLimits.deltaBytes)
          return [next, [{ kind: 'delta', delta }]];
        return [next, [{ kind: 'snapshot', value: next }]];
      },
    ),
  );
}

/**
 * Chat handlers for every procedure, over the chat service: each checks the request's host. A
 * request that changes state, or a read a caller may not abandon, runs to completion once it
 * started, even if its connection drops.
 */
export function makeChatHandlers(services: RpcServices) {
  const { chat } = services;
  const handlers: Record<string, unknown> = {
    watchChat: ({ host, target }: { host: ChatHostTarget; target: never }) =>
      Stream.unwrap(
        Effect.as(forHost(services, host, 'watchChat'), toUpdates('chat', chat.watch({ target }))),
      ).pipe(Stream.mapError(toChatWire)),
    watchChatList: ({ host, session }: { host: ChatHostTarget; session: never }) =>
      Stream.unwrap(
        Effect.as(
          forHost(services, host, 'watchChatList'),
          toUpdates(
            'chatList',
            chat.watchChatList({ session }).pipe(
              Stream.map(({ list, changed, dropped }): ChatListState => ({
                list,
                changed,
                dropped,
              })),
            ),
          ),
        ),
      ).pipe(Stream.mapError(toChatWire)),
  };
  for (const operation of Object.keys(chatInputSchemas) as ChatCommand[]) {
    handlers[operation] = ({ host, input }: { host: ChatHostTarget; input: never }) => {
      const run = Effect.andThen(
        forHost(services, host, operation),
        Effect.suspend(() =>
          (chat[operation] as unknown as (input: never) => Effect.Effect<unknown, unknown>)(input),
        ),
      ).pipe(Effect.mapError(toChatWire));
      return isCancellableChatRead(operation) ? run : Rpc.uninterruptible(run);
    };
  }
  return handlers as never;
}

/** Request IDs of recent daemon mutations; a repeat of one returns its outcome instead of rerunning. */
const rememberedDaemonRequests = 256;
// Errors a daemon raises only before it applies anything, so a refused request may be sent again.
const refusals = [
  FolderRefusedError,
  FolderMissingError,
  ProviderSetupRefusedError,
  InvalidChatRequestError,
  ChatAccessError,
  ChatBusyError,
  IncompatibleHostError,
  UnauthorizedError,
  RequestReusedError,
];

/**
 * Daemon handlers for folder approvals, control and provider setup. Each checks the request's
 * host and that health advertises the operation's capability. A mutation's request ID binds its
 * whole input: a repeat returns the first outcome, unless the daemon refused it outright, so
 * nothing of it applied.
 */
export function makeDaemonHandlers(services: RpcServices) {
  const daemon = services.daemon!;
  const remembered = new Map<
    string,
    { operation: string; input: unknown; outcome: Deferred.Deferred<unknown, unknown> }
  >();
  const serve = <A>(
    operation: DaemonCommand,
    host: ChatHostTarget,
    input: { requestId?: string; ownerId?: string },
    service: () => Effect.Effect<A, unknown>,
  ) => {
    const checked = Effect.andThen(
      forHost(services, host, operation),
      services.health.capabilities.includes(daemonCommandCapabilities[operation])
        ? Effect.void
        : Effect.fail(notServed()),
    );
    const toWireError = operation in localHostInputSchemas ? toLocalHostWire : toProviderSetupWire;
    const run = () => Effect.suspend(service).pipe(Effect.mapError(toWireError));
    if (!isDaemonMutation(operation)) return Effect.andThen(checked, run());
    return Rpc.uninterruptible(
      Effect.andThen(
        checked,
        Effect.gen(function* () {
          // Keyed by owner too, so one owner's request IDs never answer for another's.
          const key = JSON.stringify([input.ownerId ?? null, input.requestId]),
            prior = remembered.get(key);
          if (prior) {
            if (prior.operation !== operation || !areJsonValuesEqual(prior.input, input))
              return yield* Effect.fail(new RequestReusedError());
            return (yield* Deferred.await(prior.outcome)) as A;
          }
          const outcome = Deferred.makeUnsafe<unknown, unknown>();
          remembered.set(key, { operation, input, outcome });
          for (const old of remembered.keys()) {
            if (remembered.size <= rememberedDaemonRequests) break;
            remembered.delete(old);
          }
          const exit = yield* Effect.exit(run());
          if (
            Exit.isFailure(exit) &&
            exit.cause.reasons.every(
              (reason) =>
                reason._tag === 'Fail' &&
                refusals.some((refusal) => reason.error instanceof refusal),
            ) &&
            remembered.get(key)?.outcome === outcome
          )
            remembered.delete(key);
          yield* Deferred.done(outcome, exit);
          return yield* exit;
        }),
      ),
    );
  };
  const local: Record<string, unknown> = {};
  for (const operation of Object.keys(localHostInputSchemas) as (keyof LocalHostHandlers)[])
    local[operation] = ({ host, input }: { host: ChatHostTarget; input: never }) =>
      serve(operation, host, input, () =>
        (daemon.localHost[operation] as (input: never) => Effect.Effect<unknown, unknown>)(input),
      );
  const owner = (ownerId: string) => daemon.providers.forOwner(ownerId);
  type Owned = { host: ChatHostTarget; input: { ownerId: string; requestId: string } };
  const providers = {
    getProviders: ({ host, input }: Owned) =>
      serve('getProviders', host, input, () =>
        Effect.map(owner(input.ownerId).getProviders({}), (state) => ({ state })),
      ),
    startProviderLogin: ({ host, input }: Owned & { input: { providerId: string } }) =>
      serve('startProviderLogin', host, input, () =>
        Effect.map(
          owner(input.ownerId).startProviderLogin({ providerId: input.providerId }),
          (state) => ({ requestId: input.requestId, state }),
        ),
      ),
    answerProviderPrompt: ({
      host,
      input,
    }: Owned & { input: { flowId: string; promptId: string; answer: string } }) =>
      serve('answerProviderPrompt', host, input, () =>
        Effect.map(
          owner(input.ownerId).answerProviderPrompt({
            flowId: input.flowId,
            promptId: input.promptId,
            answer: input.answer,
          }),
          (state) => ({ requestId: input.requestId, state }),
        ),
      ),
    cancelProviderLogin: ({ host, input }: Owned & { input: { flowId: string } }) =>
      serve('cancelProviderLogin', host, input, () =>
        Effect.map(owner(input.ownerId).cancelProviderLogin({ flowId: input.flowId }), (state) => ({
          requestId: input.requestId,
          state,
        })),
      ),
    openProviderUrl: ({ host, input }: Owned & { input: { flowId: string } }) =>
      serve('openProviderUrl', host, input, () =>
        Effect.flatMap(daemon.providers.getProviderUrl(input.ownerId, input.flowId), (url) =>
          Effect.map(owner(input.ownerId).getProviders({}), (state) => ({ state, url })),
        ),
      ),
    logoutProvider: ({ host, input }: Owned & { input: { providerId: string } }) =>
      serve('logoutProvider', host, input, () =>
        Effect.map(
          owner(input.ownerId).logoutProvider({ providerId: input.providerId }),
          (state) => ({
            requestId: input.requestId,
            state,
          }),
        ),
      ),
    releaseProviderOwner: ({ host, input }: Owned) =>
      serve('releaseProviderOwner', host, input, () =>
        daemon.providers.releaseOwner(input.ownerId),
      ),
    watchProviderSetup: ({ host, ownerId }: { host: ChatHostTarget; ownerId: string }) =>
      Stream.unwrap(
        Effect.as(
          Effect.andThen(
            forHost(services, host, 'watchProviderSetup'),
            services.health.capabilities.includes(daemonCommandCapabilities.getProviders)
              ? Effect.void
              : Effect.fail(notServed()),
          ),
          toUpdates('providerSetup', daemon.providers.watch(ownerId)),
        ),
      ).pipe(Stream.mapError(toProviderSetupWire)),
  };
  return { local: local as never, providers: providers as never };
}
