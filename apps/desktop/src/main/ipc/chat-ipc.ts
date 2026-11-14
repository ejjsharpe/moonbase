import { Effect, Stream } from 'effect';
import { normalizeApplicationError } from '@moonbase/effect';
import type { ChatCommand, ChatInput } from '@moonbase/contracts/chat';
import type { ConnectionCommand, ConnectionInput } from '@moonbase/contracts/connection';
import type { ProviderCommand, ProviderInput } from '@moonbase/contracts/providers';
import { DesktopChatRpcs, type ChatTargetId } from '../../ipc/chat-rpcs.ts';
import {
  IpcAuthorityError,
  IpcBusyError,
  IpcInputError,
  IpcUnavailableError,
  NativeActionError,
} from '../../ipc/ipc-errors.ts';
import type { DesktopChatBackends } from '../chat/chat-backends.ts';
import { maximumTranscriptCopies, type ChatIpcSession } from '../chat/session.ts';
import { copyTranscript } from '../chat/transcript-native.ts';
import { streamObservation } from './observation-stream.ts';
import { settledPromise } from './settled-promise.ts';

export type ChatIpcOptions = {
  backends: Pick<
    DesktopChatBackends,
    | 'getTargets'
    | 'getContext'
    | 'chooseFolder'
    | 'recentFolders'
    | 'createWorktree'
    | 'turnIntoProject'
    | 'getSession'
  >;
  /** Whether Moonbase is quitting, when no new native work starts. */
  isQuitting(): boolean;
  /** Reports a cleanup failure no request is left to answer with. */
  reportCleanup(error: unknown): void;
};
const promise = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: normalizeApplicationError });
/** The chat request refusal the renderer has always had for a target that lacks a capability. */
const unsupported = () => new IpcInputError({ problem: 'chat-request' });

/**
 * The chat procedures. Each names an installed target; its session is that target's for the
 * window's current document, and checks that the request names the configured host and actor.
 */
export function makeChatIpcHandlers({ backends, isQuitting, reportCleanup }: ChatIpcOptions) {
  const checkTarget = (backendId: ChatTargetId) =>
    backends.getTargets().some((target) => target.id === backendId)
      ? Effect.void
      : Effect.fail(new IpcAuthorityError({ refusal: 'chat-target' }));
  const findSession = (backendId: ChatTargetId, authorized?: unknown) =>
    Effect.gen(function* () {
      yield* checkTarget(backendId);
      const session = backends.getSession(backendId);
      if (!session) return yield* new IpcUnavailableError({ feature: 'chat-target' });
      const refusal = session.authority(authorized);
      if (refusal) return yield* new IpcAuthorityError({ refusal });
      return session;
    });
  /** A local chat's native action, refused while quitting. */
  const local = (feature: IpcUnavailableError['feature']) =>
    Effect.suspend(() =>
      isQuitting() ? Effect.fail(new IpcUnavailableError({ feature })) : Effect.void,
    );
  const providersOf = (session: ChatIpcSession) =>
    session.capabilities.providers
      ? Effect.succeed(session.capabilities.providers)
      : Effect.fail(unsupported());
  const remoteConnection = Effect.flatMap(findSession('remote'), (session) =>
    session.connection
      ? Effect.succeed({ session, connection: session.connection })
      : Effect.fail(unsupported()),
  );
  const chat =
    <K extends ChatCommand>(operation: K) =>
    ({ backendId, input }: { backendId: ChatTargetId; input: ChatInput<K> }) =>
      Effect.flatMap(findSession(backendId, input), (session) =>
        promise((signal) => session.chat.command(operation, input, { signal })),
      );
  const providers =
    <K extends ProviderCommand>(operation: K) =>
    ({ backendId, input }: { backendId: ChatTargetId; input: ProviderInput<K> }) =>
      Effect.flatMap(findSession(backendId), providersOf).pipe(
        Effect.flatMap((client) =>
          promise((signal) => client.command(operation, input, { signal })),
        ),
      );
  const connection =
    <K extends ConnectionCommand>(operation: K) =>
    ({ input }: { input: ConnectionInput<K> }) =>
      Effect.flatMap(remoteConnection, ({ session, connection }) => {
        const command = promise((signal) => connection.command(operation, input, { signal }));
        if (operation === 'getConnection') return command;
        // Image URLs belong to the connection that issued them, including ones issued mid-change.
        const revoke = Effect.promise(() => session.revokeImages());
        return Effect.andThen(revoke, command).pipe(Effect.ensuring(revoke));
      });
  return DesktopChatRpcs.of({
    getChatTargets: () => Effect.sync(() => backends.getTargets()),
    getChatContext: ({ backendId }) =>
      Effect.andThen(
        checkTarget(backendId),
        promise(() => backends.getContext(backendId)),
      ),
    chooseChatFolder: () =>
      Effect.andThen(
        local('folder-picker'),
        promise(() => backends.chooseFolder()),
      ),
    listChatFolders: ({ backendId }) =>
      Effect.andThen(
        checkTarget(backendId),
        promise(() => backends.recentFolders(backendId)),
      ),
    createChatWorktree: ({ root, branch, requestId }) =>
      Effect.andThen(
        local('new-worktree'),
        promise(() => backends.createWorktree(root, branch, requestId)),
      ),
    turnChatIntoProject: ({ conversationId }) =>
      Effect.andThen(
        local('turn-into-project'),
        promise(() => backends.turnIntoProject(conversationId)),
      ),
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
        Effect.map(findSession(backendId, { target }), (session) =>
          streamObservation(
            (receive, fail) => session.chat.watch({ target }, receive, fail),
            reportCleanup,
          ),
        ),
      ),
    watchChatList: ({ backendId, session: chatSession }) =>
      Stream.unwrap(
        Effect.map(findSession(backendId, { session: chatSession }), (session) =>
          streamObservation(
            (receive, fail) => session.chat.watchChatList({ session: chatSession }, receive, fail),
            reportCleanup,
          ),
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
        Effect.map(Effect.flatMap(findSession(backendId), providersOf), (client) =>
          streamObservation((receive, fail) => client.watch(receive, fail), reportCleanup),
        ),
      ),
    getConnection: connection('getConnection'),
    connect: connection('connect'),
    disconnect: connection('disconnect'),
    watchConnection: () =>
      Stream.unwrap(
        Effect.map(remoteConnection, ({ connection }) =>
          streamObservation((receive, fail) => connection.watch(receive, fail), reportCleanup),
        ),
      ),
    copyTranscript: ({ backendId, copy }) =>
      Effect.gen(function* () {
        const session = yield* findSession(backendId, copy);
        const transcript = session.capabilities.transcript;
        if (!transcript) return yield* unsupported();
        // Taken and counted in one step, so two requests can't both see a free place.
        const admitted = yield* Effect.sync(
          () => session.copies < maximumTranscriptCopies && ++session.copies > 0,
        );
        if (!admitted) return yield* new IpcBusyError({ limit: 'copies' });
        // Cancelled, a Copy is told so and waited for, since it may be writing the clipboard.
        yield* settledPromise((signal) =>
          copyTranscript(session.chat, copy, { signal, reportCleanup }, transcript),
        ).pipe(Effect.ensuring(Effect.sync(() => session.copies--)));
      }),
    openTranscriptLink: ({ backendId, url }) =>
      Effect.gen(function* () {
        const session = yield* findSession(backendId);
        const transcript = session.capabilities.transcript;
        if (!transcript) return yield* unsupported();
        yield* settledPromise(() => transcript.openExternal(new URL(url).href)).pipe(
          Effect.mapError(() => new NativeActionError({ failure: 'link-failed' })),
        );
      }),
    getTranscriptImageUrl: ({ backendId, image }) =>
      Effect.flatMap(findSession(backendId, image), (session) => {
        const url = session.issueImage(image);
        return url
          ? Effect.succeed(url)
          : Effect.fail(new IpcUnavailableError({ feature: 'chat-target' }));
      }),
  });
}
