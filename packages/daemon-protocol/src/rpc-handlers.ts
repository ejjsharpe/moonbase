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
import { ApplicationError } from '@moonbase/contracts/workspace';
import type { ChatCommand } from '@moonbase/contracts/chat';
import { projectSocketDelta } from './socket-deltas.ts';

/** The services one daemon serves over RPC, and what its health advertises. */
export type RpcServices = {
  host: ChatHostTarget;
  health: ChatHostHealth;
  chat: ChatServiceShape;
  daemon?: { localHost: LocalHostHandlers; providers: ProviderSetupService['Service'] };
};

const elsewhere = () =>
  new ApplicationError({ code: 'Unauthorized', message: 'Request target differs from this host.' });
const notServed = () =>
  new ApplicationError({
    code: 'Incompatible',
    message: 'This host does not serve that operation.',
  });
/** Refuses a request for another host before its handler runs. */
const forHost = (services: RpcServices, host: ChatHostTarget) =>
  isSameChatHost(host, services.host) ? Effect.void : Effect.fail(elsewhere());

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
      Stream.unwrap(Effect.as(forHost(services, host), toUpdates('chat', chat.watch({ target })))),
    watchChatList: ({ host, session }: { host: ChatHostTarget; session: never }) =>
      Stream.unwrap(
        Effect.as(
          forHost(services, host),
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
      ),
  };
  for (const operation of Object.keys(chatInputSchemas) as ChatCommand[]) {
    handlers[operation] = ({ host, input }: { host: ChatHostTarget; input: never }) => {
      const run = Effect.andThen(
        forHost(services, host),
        Effect.suspend(() =>
          (chat[operation] as unknown as (input: never) => Effect.Effect<unknown>)(input),
        ),
      );
      return isCancellableChatRead(operation) ? run : Rpc.uninterruptible(run);
    };
  }
  return handlers as never;
}

/** Request IDs of recent daemon mutations; a repeat of one returns its outcome instead of rerunning. */
const rememberedDaemonRequests = 256;
// Codes a daemon raises only before it applies anything, so a refused request may be sent again.
const refusalCodes = new Set<string>(['InvalidInput', 'Unauthorized', 'Incompatible', 'Conflict']);

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
    run: () => Effect.Effect<A, ApplicationError>,
  ) => {
    const checked = Effect.andThen(
      forHost(services, host),
      services.health.capabilities.includes(daemonCommandCapabilities[operation])
        ? Effect.void
        : Effect.fail(notServed()),
    );
    if (!isDaemonMutation(operation)) return Effect.andThen(checked, Effect.suspend(run));
    return Rpc.uninterruptible(
      Effect.andThen(
        checked,
        Effect.gen(function* () {
          // Keyed by owner too, so one owner's request IDs never answer for another's.
          const key = JSON.stringify([input.ownerId ?? null, input.requestId]),
            prior = remembered.get(key);
          if (prior) {
            if (prior.operation !== operation || !areJsonValuesEqual(prior.input, input))
              return yield* Effect.fail(
                new ApplicationError({
                  code: 'InvalidInput',
                  message: 'Request ID is bound to another operation or input.',
                }),
              );
            return (yield* Deferred.await(prior.outcome)) as A;
          }
          const outcome = Deferred.makeUnsafe<unknown, unknown>();
          remembered.set(key, { operation, input, outcome });
          for (const old of remembered.keys()) {
            if (remembered.size <= rememberedDaemonRequests) break;
            remembered.delete(old);
          }
          const exit = yield* Effect.exit(Effect.suspend(run));
          if (
            Exit.isFailure(exit) &&
            exit.cause.reasons.every(
              (reason) =>
                reason._tag === 'Fail' &&
                ApplicationError.is(reason.error) &&
                refusalCodes.has(reason.error.code),
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
        (daemon.localHost[operation] as (input: never) => Effect.Effect<unknown, ApplicationError>)(
          input,
        ),
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
            forHost(services, host),
            services.health.capabilities.includes(daemonCommandCapabilities.getProviders)
              ? Effect.void
              : Effect.fail(notServed()),
          ),
          toUpdates('providerSetup', daemon.providers.watch(ownerId)),
        ),
      ),
  };
  return { local: local as never, providers: providers as never };
}
