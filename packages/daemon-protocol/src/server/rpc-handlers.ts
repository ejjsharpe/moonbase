import { Effect, Stream } from 'effect';
import { Rpc, type RpcGroup } from 'effect/rpc';
import type { ChatCommand, ChatInput, ChatListState } from '@moonbase/contracts/chat';
import { isCancellableChatRead, isSameChatHost } from '@moonbase/contracts/chat-validation';
import { daemonCommandCapabilities } from '@moonbase/contracts/daemon-schema';
import type { DaemonCommand, LocalHostCommand, LocalHostInput } from '@moonbase/contracts/daemon';
import type { ChatHostHealth, ChatHostTarget } from '@moonbase/contracts/host';
import {
  ChatService,
  LocalHostService,
  ProviderSetupService,
  type ChatHandlers,
  type LocalHostHandlers,
} from '@moonbase/contracts/services';
import {
  watchDeltaBytes,
  type WatchDelta,
  type WatchKind,
  type WatchValue,
} from '@moonbase/contracts/watch';
import { UnauthorizedError } from '@moonbase/contracts/errors';
import { HostUnavailableError, IncompatibleHostError } from '@moonbase/contracts/host-errors';
import { ChatRpcs } from '@moonbase/contracts/chat-rpc';
import { isDaemonMutation, LocalHostRpcs, ProviderSetupRpcs } from '@moonbase/contracts/daemon-rpc';
import { declaredErrorsOf, isOneOf, type Procedure } from '../declared-errors.ts';
import type { MutationInput, MutationReplay } from './mutation-replay.ts';
import { projectWatchDelta } from './watch-deltas.ts';

/** The host a daemon serves over RPC, and what its health advertises. */
export type ServedHost = { host: ChatHostTarget; health: ChatHostHealth };

export const notServed = () => new IncompatibleHostError({ reason: 'not-served' });
/** Refuses a request for another host before its handler runs. */
export const forHost = (
  served: { host: ChatHostTarget },
  host: ChatHostTarget,
  operation: string,
) =>
  isSameChatHost(host, served.host)
    ? Effect.void
    : Effect.fail(new UnauthorizedError({ operation }));

/**
 * A service's failure as `operation`'s error union declares it: an error the union names is sent
 * as it is (its tag and fields, never a cause); anything else is the host's own failure.
 */
export const toWire = <Rpcs extends Procedure, const Tag extends Rpcs['_tag']>(
  group: RpcGroup.RpcGroup<Rpcs>,
  operation: Tag,
) => {
  const errors = declaredErrorsOf(group.requests.get(operation)!);
  return (error: unknown): Rpc.ErrorExit<Rpc.ExtractTag<Rpcs, Tag>> | HostUnavailableError =>
    // An instance of a class the union names is of its type.
    isOneOf(errors, error)
      ? (error as Rpc.ErrorExit<Rpc.ExtractTag<Rpcs, Tag>>)
      : new HostUnavailableError({ reason: 'failed' });
};

/** A watch's update: a whole value, or a delta from the last one sent. */
export type Update<K extends WatchKind> =
  | { kind: 'snapshot'; value: WatchValue<K> }
  | { kind: 'delta'; delta: WatchDelta<K> };
/**
 * A watch's values as updates: the first whole, each later one as a delta from the last sent
 * where one pays (at most `watchDeltaBytes`), else whole again. A value equal to the last sent is
 * skipped.
 */
export function toUpdates<K extends WatchKind, E>(
  kind: K,
  values: Stream.Stream<WatchValue<K>, E>,
) {
  return values.pipe(
    Stream.mapAccum(
      (): WatchValue<K> | undefined => undefined,
      (previous, next): readonly [WatchValue<K> | undefined, readonly Update<K>[]] => {
        if (previous === undefined) return [next, [{ kind: 'snapshot', value: next }]];
        const delta = projectWatchDelta(kind, previous, next);
        if (delta === null) return [previous, []];
        if (delta !== undefined && JSON.stringify(delta).length <= watchDeltaBytes)
          return [next, [{ kind: 'delta', delta }]];
        return [next, [{ kind: 'snapshot', value: next }]];
      },
    ),
  );
}

type ChatRpc = RpcGroup.Rpcs<typeof ChatRpcs>;

/**
 * Chat handlers for every procedure, over the chat service: each checks the request's host. A
 * request that changes state, or a read a caller may not abandon, runs to completion once it
 * started, even if its connection drops.
 */
export const makeChatHandlers = (served: { host: ChatHostTarget }) =>
  Effect.gen(function* () {
    const chat = yield* ChatService;
    const commands: ChatHandlers = chat;
    const command =
      <K extends ChatCommand>(operation: K) =>
      ({ host, input }: { host: ChatHostTarget; input: ChatInput<K> }) => {
        const run = Effect.andThen(
          forHost(served, host, operation),
          Effect.suspend(() => commands[operation](input)),
        ).pipe(Effect.mapError(toWire(ChatRpcs, operation)));
        return isCancellableChatRead(operation) ? run : Rpc.uninterruptible(run);
      };
    return {
      getChatHost: command('getChatHost'),
      listChats: command('listChats'),
      createChat: command('createChat'),
      getChat: command('getChat'),
      getChatHistory: command('getChatHistory'),
      getChatTranscriptContent: command('getChatTranscriptContent'),
      findChatTranscript: command('findChatTranscript'),
      getChatHistoryAround: command('getChatHistoryAround'),
      sendChat: command('sendChat'),
      getChatSend: command('getChatSend'),
      stopChat: command('stopChat'),
      settleChat: command('settleChat'),
      findChatFiles: command('findChatFiles'),
      watchChat: ({ host, target }) =>
        Stream.unwrap(
          Effect.as(forHost(served, host, 'watchChat'), toUpdates('chat', chat.watch({ target }))),
        ).pipe(Stream.mapError(toWire(ChatRpcs, 'watchChat'))),
      watchChatList: ({ host, session }) =>
        Stream.unwrap(
          Effect.as(
            forHost(served, host, 'watchChatList'),
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
        ).pipe(Stream.mapError(toWire(ChatRpcs, 'watchChatList'))),
    } satisfies RpcGroup.HandlersFrom<ChatRpc>;
  });

/**
 * Serves one daemon operation: it checks the request's host and that health advertises the
 * operation's capability. A mutation's request ID binds its whole input: `replay` runs it once per
 * ID and answers a repeat with its outcome, as the operation's union declares it.
 */
const makeServeDaemonCommand =
  <Rpcs extends Procedure>(
    group: RpcGroup.RpcGroup<Rpcs>,
    served: ServedHost,
    replay: MutationReplay,
  ) =>
  <const K extends DaemonCommand & Rpcs['_tag'], A, E>(
    operation: K,
    host: ChatHostTarget,
    input: MutationInput,
    service: () => Effect.Effect<A, E>,
  ) => {
    const wire = toWire(group, operation);
    const checked = Effect.andThen(
      forHost(served, host, operation),
      served.health.capabilities.includes(daemonCommandCapabilities[operation])
        ? Effect.void
        : Effect.fail(notServed()),
    );
    const run = Effect.suspend(service).pipe(Effect.mapError(wire));
    if (!isDaemonMutation(operation)) return Effect.andThen(checked, run);
    return Rpc.uninterruptible(
      Effect.andThen(checked, replay(operation, input, run)).pipe(Effect.mapError(wire)),
    );
  };

type LocalHostRpc = RpcGroup.Rpcs<typeof LocalHostRpcs>;
/** Folder approval and control handlers, over the local host service. */
export const makeLocalHostHandlers = (served: ServedHost, replay: MutationReplay) =>
  Effect.gen(function* () {
    const localHost: LocalHostHandlers = yield* LocalHostService;
    const serve = makeServeDaemonCommand(LocalHostRpcs, served, replay);
    const command =
      <K extends LocalHostCommand>(operation: K) =>
      ({ host, input }: { host: ChatHostTarget; input: LocalHostInput<K> }) =>
        serve(operation, host, input, () => localHost[operation](input));
    return {
      approveFolder: command('approveFolder'),
      listRecentFolders: command('listRecentFolders'),
      checkChatFolder: command('checkChatFolder'),
      checkApprovedFolder: command('checkApprovedFolder'),
      getActiveWork: command('getActiveWork'),
      markFolderAsProject: command('markFolderAsProject'),
      listHostFolders: command('listHostFolders'),
    } satisfies RpcGroup.HandlersFrom<LocalHostRpc>;
  });

type ProviderSetupRpc = RpcGroup.Rpcs<typeof ProviderSetupRpcs>;
/** Provider setup handlers, each for the owner its request names. */
export const makeProviderSetupHandlers = (served: ServedHost, replay: MutationReplay) =>
  Effect.gen(function* () {
    const providers = yield* ProviderSetupService;
    const serve = makeServeDaemonCommand(ProviderSetupRpcs, served, replay);
    const owner = (ownerId: string) => providers.forOwner(ownerId);
    return {
      getProviders: ({ host, input }) =>
        serve('getProviders', host, input, () =>
          Effect.map(owner(input.ownerId).getProviders({}), (state) => ({ state })),
        ),
      startProviderLogin: ({ host, input }) =>
        serve('startProviderLogin', host, input, () =>
          Effect.map(
            owner(input.ownerId).startProviderLogin({ providerId: input.providerId }),
            (state) => ({ requestId: input.requestId, state }),
          ),
        ),
      answerProviderPrompt: ({ host, input }) =>
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
      cancelProviderLogin: ({ host, input }) =>
        serve('cancelProviderLogin', host, input, () =>
          Effect.map(
            owner(input.ownerId).cancelProviderLogin({ flowId: input.flowId }),
            (state) => ({ requestId: input.requestId, state }),
          ),
        ),
      openProviderUrl: ({ host, input }) =>
        serve('openProviderUrl', host, input, () =>
          Effect.flatMap(providers.getProviderUrl(input.ownerId, input.flowId), (url) =>
            Effect.map(owner(input.ownerId).getProviders({}), (state) => ({ state, url })),
          ),
        ),
      logoutProvider: ({ host, input }) =>
        serve('logoutProvider', host, input, () =>
          Effect.map(
            owner(input.ownerId).logoutProvider({ providerId: input.providerId }),
            (state) => ({ requestId: input.requestId, state }),
          ),
        ),
      releaseProviderOwner: ({ host, input }) =>
        serve('releaseProviderOwner', host, input, () => providers.releaseOwner(input.ownerId)),
      watchProviderSetup: ({ host, ownerId }) =>
        Stream.unwrap(
          Effect.as(
            Effect.andThen(
              forHost(served, host, 'watchProviderSetup'),
              served.health.capabilities.includes(daemonCommandCapabilities.getProviders)
                ? Effect.void
                : Effect.fail(notServed()),
            ),
            toUpdates('providerSetup', providers.watch(ownerId)),
          ),
        ).pipe(Stream.mapError(toWire(ProviderSetupRpcs, 'watchProviderSetup'))),
    } satisfies RpcGroup.HandlersFrom<ProviderSetupRpc>;
  });
