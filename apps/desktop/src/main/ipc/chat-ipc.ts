import { Effect, Option, Stream } from 'effect';
import type { ChatCommand, ChatInput } from '@moonbase/contracts/chat';
import type { ConnectionCommand, ConnectionInput } from '@moonbase/contracts/connection';
import type { ProviderCommand, ProviderInput } from '@moonbase/contracts/providers';
import type { ChatHandlers, ConnectionHandlers } from '@moonbase/contracts/services';
import { toChatApplicationError } from '@moonbase/contracts/chat-legacy-errors';
import { toConnectionApplicationError } from '@moonbase/contracts/connection-errors';
import { DesktopChatRpcs, type ChatTargetId } from '../../ipc/chat-rpcs.ts';
import {
  IpcAuthorityError,
  IpcBusyError,
  IpcInputError,
  IpcUnavailableError,
  NativeActionError,
} from '../../ipc/ipc-errors.ts';
import type { ChatBackends, ChatTargetClients } from '../chat/chat-backends.ts';
import type { ChatDocument } from '../chat/chat-document.ts';
import { copyTranscript, type NativeTranscriptActions } from '../chat/transcript-native.ts';

export type ChatIpcOptions = {
  backends: Pick<
    ChatBackends,
    | 'targets'
    | 'findTarget'
    | 'getContext'
    | 'chooseFolder'
    | 'recentFolders'
    | 'createWorktree'
    | 'turnIntoProject'
  >;
  /** Whether Moonbase is quitting, when no new native work starts. */
  readonly isQuitting: Effect.Effect<boolean>;
  transcript?: NativeTranscriptActions;
};
/** The chat request refusal the renderer has always had for a target that lacks a capability. */
const unsupported = () => new IpcInputError({ problem: 'chat-request' });

/** Why `value` may not name what it names: another host and store, or another actor. */
function checkHostAndActor(
  context: ChatTargetClients['context'],
  value: unknown,
): 'host' | 'actor' | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const host = v.host as { hostId?: unknown; storeId?: unknown } | undefined;
  if (
    host !== undefined &&
    (host.hostId !== context.host.hostId || host.storeId !== context.host.storeId)
  )
    return 'host';
  if (v.actorId !== undefined && v.actorId !== context.actorId) return 'actor';
  for (const name of ['target', 'session', 'stop', 'source']) {
    const refusal = checkHostAndActor(context, v[name]);
    if (refusal) return refusal;
  }
  return undefined;
}

/**
 * The chat procedures for one document. Each names an installed target, and is checked against
 * that target's configured host and actor; what the document holds of a target (provider
 * sign-ins, image URLs, Copies) is `document`'s.
 */
export function makeChatIpcHandlers(
  { backends, isQuitting, transcript }: ChatIpcOptions,
  document: ChatDocument,
) {
  const checkTarget = (backendId: ChatTargetId) =>
    backends.targets.some((target) => target.id === backendId)
      ? Effect.void
      : Effect.fail(new IpcAuthorityError({ refusal: 'chat-target' }));
  const findTarget = (backendId: ChatTargetId, authorized?: unknown) =>
    Effect.gen(function* () {
      yield* checkTarget(backendId);
      const clients = yield* backends.findTarget(backendId);
      if (!clients) return yield* new IpcUnavailableError({ feature: 'chat-target' });
      const refusal = checkHostAndActor(clients.context, authorized);
      if (refusal) return yield* new IpcAuthorityError({ refusal });
      return clients;
    });
  /** A local chat's native action, refused while quitting. */
  const local = (feature: IpcUnavailableError['feature']) =>
    Effect.flatMap(isQuitting, (quitting) =>
      quitting ? Effect.fail(new IpcUnavailableError({ feature })) : Effect.void,
    );
  const providersOf = (backendId: ChatTargetId) =>
    Effect.map(findTarget(backendId), ({ providers }) => providers);
  const remoteConnection = Effect.flatMap(findTarget('remote'), ({ connection }) =>
    connection ? Effect.succeed(connection) : Effect.fail(unsupported()),
  );
  // The services' errors reach the renderer as the legacy error with its code (CL-22).
  const chat =
    <K extends ChatCommand>(operation: K) =>
    ({ backendId, input }: { backendId: ChatTargetId; input: ChatInput<K> }) =>
      Effect.flatMap(findTarget(backendId, input), (clients) => {
        const handlers: ChatHandlers = clients.chat;
        return handlers[operation](input).pipe(Effect.mapError(toChatApplicationError));
      });
  const providers =
    <K extends ProviderCommand>(operation: K) =>
    ({ backendId, input }: { backendId: ChatTargetId; input: ProviderInput<K> }) =>
      Effect.flatMap(providersOf(backendId), (service) =>
        service
          .forOwner(document.id)
          [operation](input)
          .pipe(Effect.mapError(toChatApplicationError)),
      );
  const connection =
    <K extends ConnectionCommand>(operation: K) =>
    ({ input }: { input: ConnectionInput<K> }) =>
      Effect.flatMap(remoteConnection, (service) => {
        const handlers: ConnectionHandlers = service;
        const command = handlers[operation](input).pipe(
          Effect.mapError(toConnectionApplicationError),
        );
        if (operation === 'getConnection') return command;
        // Image URLs belong to the connection that issued them, including ones issued mid-change.
        const revoke = document.targets.remote.images.revoke;
        return Effect.andThen(revoke, command).pipe(Effect.ensuring(revoke));
      });
  return DesktopChatRpcs.of({
    getChatTargets: () => Effect.succeed(backends.targets),
    getChatContext: ({ backendId }) =>
      Effect.andThen(checkTarget(backendId), backends.getContext(backendId)),
    chooseChatFolder: () => Effect.andThen(local('folder-picker'), backends.chooseFolder),
    listChatFolders: ({ backendId }) =>
      Effect.andThen(checkTarget(backendId), backends.recentFolders(backendId)),
    createChatWorktree: ({ root, branch, requestId }) =>
      Effect.andThen(local('new-worktree'), backends.createWorktree(root, branch, requestId)),
    turnChatIntoProject: ({ conversationId }) =>
      Effect.andThen(local('turn-into-project'), backends.turnIntoProject(conversationId)),
    getChatHost: chat('getChatHost'),
    listChats: chat('listChats'),
    createChat: chat('createChat'),
    getChat: chat('getChat'),
    getChatHistory: chat('getChatHistory'),
    getChatTranscriptContent: chat('getChatTranscriptContent'),
    findChatTranscript: chat('findChatTranscript'),
    getChatHistoryAround: chat('getChatHistoryAround'),
    sendChat: chat('sendChat'),
    getChatSend: chat('getChatSend'),
    stopChat: chat('stopChat'),
    settleChat: chat('settleChat'),
    findChatFiles: chat('findChatFiles'),
    watchChat: ({ backendId, target }) =>
      Stream.unwrap(
        Effect.map(findTarget(backendId, { target }), (clients) =>
          clients.chat.watch({ target }).pipe(Stream.mapError(toChatApplicationError)),
        ),
      ),
    watchChatList: ({ backendId, session }) =>
      Stream.unwrap(
        Effect.map(findTarget(backendId, { session }), (clients) =>
          clients.chat.watchChatList({ session }).pipe(Stream.mapError(toChatApplicationError)),
        ),
      ),
    getProviders: providers('getProviders'),
    startProviderLogin: providers('startProviderLogin'),
    answerProviderPrompt: providers('answerProviderPrompt'),
    cancelProviderLogin: providers('cancelProviderLogin'),
    openProviderUrl: providers('openProviderUrl'),
    logoutProvider: providers('logoutProvider'),
    watchProviders: ({ backendId }) =>
      Stream.unwrap(
        Effect.map(providersOf(backendId), (service) =>
          service.watch(document.id).pipe(Stream.mapError(toChatApplicationError)),
        ),
      ),
    getConnection: connection('getConnection'),
    connect: connection('connect'),
    disconnect: connection('disconnect'),
    watchConnection: () =>
      Stream.unwrap(
        Effect.map(remoteConnection, (service) =>
          service.watch().pipe(Stream.mapError(toConnectionApplicationError)),
        ),
      ),
    copyTranscript: ({ backendId, copy }) =>
      Effect.gen(function* () {
        const clients = yield* findTarget(backendId, copy);
        if (!transcript) return yield* unsupported();
        const copied = yield* document.targets[backendId].copies.withPermitsIfAvailable(1)(
          copyTranscript(clients.chat, copy, transcript),
        );
        if (Option.isNone(copied)) return yield* new IpcBusyError({ limit: 'copies' });
      }),
    openTranscriptLink: ({ backendId, url }) =>
      Effect.gen(function* () {
        yield* findTarget(backendId);
        if (!transcript) return yield* unsupported();
        // Cancelled, a link being opened is waited for.
        yield* Effect.uninterruptible(
          Effect.tryPromise({
            try: () => transcript.openExternal(new URL(url).href),
            catch: () => new NativeActionError({ failure: 'link-failed' }),
          }),
        );
      }),
    getTranscriptImageUrl: ({ backendId, image }) =>
      Effect.andThen(findTarget(backendId, image), document.targets[backendId].images.issue(image)),
  });
}
