import { randomUUID } from 'node:crypto';
import { Effect, Layer, Stream } from 'effect';
import type { RpcClientError } from 'effect/rpc/RpcClientError';
import type { ChatCommand, ChatInput, ChatOutput } from '@moonbase/contracts/chat';
import { checkChatOutput } from '@moonbase/contracts/chat-validation';
import type { DaemonCommand, DaemonInput, DaemonOutput } from '@moonbase/contracts/daemon';
import { daemonCommandCapabilities } from '@moonbase/contracts/daemon-schema';
import { chatHostCapabilities, type ChatHostTarget } from '@moonbase/contracts/host';
import type { ProviderState } from '@moonbase/contracts/providers';
import { readProviderSignInUrl } from '@moonbase/contracts/providers-schema';
import {
  ChatService,
  LocalHostService,
  ProviderSetupService,
  type ChatServiceShape,
  type LocalHostHandlers,
  type ProviderSetupHandlers,
} from '@moonbase/contracts/services';
import { IncompatibleHostError } from '@moonbase/contracts/host-errors';
import { ProviderSetupUnavailableError } from '@moonbase/contracts/provider-errors';
import {
  DaemonRpcLink,
  DaemonRpcLinkLive,
  followWatch,
  presentRemoteError,
  type DaemonRpc,
  type RemoteError,
} from './daemon-rpc-link.ts';
import type { ProcedureClient } from './rpc-link.ts';

/** What a daemon procedure's client fails with: the errors it declares, or the transport's. */
type SentError = RemoteError | RpcClientError;
const invalidReply = () => new IncompatibleHostError({ reason: 'invalid-reply' });

/** A daemon's chat over its RPC link: every procedure, each reply checked against its request. */
export const RemoteChatLive: Layer.Layer<ChatService, never, DaemonRpcLink> = Layer.effect(
  ChatService,
  Effect.gen(function* () {
    const link = yield* DaemonRpcLink;
    const { host } = link;
    const call =
      <K extends ChatCommand, E extends SentError>(
        operation: K,
        send: (
          client: ProcedureClient<DaemonRpc, K>,
          payload: { host: ChatHostTarget; input: ChatInput<K> },
        ) => Effect.Effect<ChatOutput<K>, E>,
      ) =>
      (input: ChatInput<K>) =>
        link.call(operation, (client) => send(client, { host, input }), {
          // A chat a client makes chooses its own folder and model, which only a daemon offers.
          capability:
            operation === 'createChat' ? chatHostCapabilities.local : chatHostCapabilities.chat,
          present: (error) => presentRemoteError(error, operation),
          check: (output, health) =>
            // Every host is a daemon whose chats choose their own folder and model.
            operation === 'getChatHost' && !health.capabilities.includes(chatHostCapabilities.local)
              ? Effect.fail(new IncompatibleHostError({ reason: 'not-daemon' }))
              : Effect.asVoid(checkChatOutput(operation, output, input)),
        });
    return {
      getChatHost: call('getChatHost', (client, payload) => client.getChatHost(payload)),
      listChats: call('listChats', (client, payload) => client.listChats(payload)),
      createChat: call('createChat', (client, payload) => client.createChat(payload)),
      getChat: call('getChat', (client, payload) => client.getChat(payload)),
      getChatHistory: call('getChatHistory', (client, payload) => client.getChatHistory(payload)),
      getChatTranscriptContent: call('getChatTranscriptContent', (client, payload) =>
        client.getChatTranscriptContent(payload),
      ),
      findChatTranscript: call('findChatTranscript', (client, payload) =>
        client.findChatTranscript(payload),
      ),
      getChatHistoryAround: call('getChatHistoryAround', (client, payload) =>
        client.getChatHistoryAround(payload),
      ),
      sendChat: call('sendChat', (client, payload) => client.sendChat(payload)),
      getChatSend: call('getChatSend', (client, payload) => client.getChatSend(payload)),
      stopChat: call('stopChat', (client, payload) => client.stopChat(payload)),
      settleChat: call('settleChat', (client, payload) => client.settleChat(payload)),
      findChatFiles: call('findChatFiles', (client, payload) => client.findChatFiles(payload)),
      // While the connection is down the last snapshot is shown as reconnecting.
      watch: ({ target }) => {
        let last: ChatOutput<'getChat'> | undefined;
        return followWatch(
          link,
          'watchChat',
          'chat',
          (client) => client.watchChat({ host, target }),
          {
            capability: chatHostCapabilities.chat,
            check: (value) => Effect.asVoid(checkChatOutput('getChat', value, { target })),
          },
        ).pipe(
          Stream.filter((update) => !('reconnecting' in update) || last !== undefined),
          Stream.map((update) => {
            if ('reconnecting' in update)
              return { ...last!, observationStatus: 'reconnecting' as const };
            last = update.value;
            return { ...update.value, observationStatus: 'connected' as const };
          }),
        );
      },
      watchChatList: ({ session }) =>
        followWatch(
          link,
          'watchChatList',
          'chatList',
          (client) => client.watchChatList({ host, session }),
          {
            capability: chatHostCapabilities.chat,
            // Every row, on the first page or past it, stays within the watched host and actor.
            check: ({ list, changed }) =>
              Effect.andThen(
                checkChatOutput('listChats', list, { session }),
                checkChatOutput(
                  'listChats',
                  { conversations: changed, nextCursor: null },
                  { session },
                ),
              ),
          },
        ).pipe(
          Stream.filter((update) => !('reconnecting' in update)),
          Stream.map((update) => {
            const { value, reset } = update as Exclude<typeof update, { reconnecting: true }>;
            return { ...value, reset };
          }),
        ),
    } satisfies ChatServiceShape;
  }),
);

/**
 * Sends one daemon operation: refused unless the daemon's signed health advertises its capability,
 * and its reply checked to echo any request ID it carried.
 */
const sendDaemonCommand = <K extends DaemonCommand, A extends DaemonOutput<K>, E extends SentError>(
  link: DaemonRpcLink['Service'],
  operation: K,
  input: DaemonInput<K>,
  send: (
    client: ProcedureClient<DaemonRpc, K>,
    payload: { host: ChatHostTarget; input: DaemonInput<K> },
  ) => Effect.Effect<A, E>,
  check?: (output: A) => Effect.Effect<void, IncompatibleHostError>,
) =>
  link.call(operation, (client) => send(client, { host: link.host, input }), {
    capability: daemonCommandCapabilities[operation],
    present: (error) => presentRemoteError(error, operation),
    check: (output) => {
      const requestId = (input as { requestId?: string }).requestId;
      if (requestId !== undefined && (output as { requestId?: string }).requestId !== requestId)
        return Effect.fail(invalidReply());
      return check ? check(output) : Effect.void;
    },
  });

/** A daemon's folder approvals and control over its RPC link. */
export const RemoteLocalHostLive: Layer.Layer<LocalHostService, never, DaemonRpcLink> =
  Layer.effect(
    LocalHostService,
    Effect.gen(function* () {
      const link = yield* DaemonRpcLink;
      return {
        approveFolder: (input) =>
          sendDaemonCommand(link, 'approveFolder', input, (client, payload) =>
            client.approveFolder(payload),
          ),
        listRecentFolders: (input) =>
          sendDaemonCommand(link, 'listRecentFolders', input, (client, payload) =>
            client.listRecentFolders(payload),
          ),
        checkChatFolder: (input) =>
          sendDaemonCommand(link, 'checkChatFolder', input, (client, payload) =>
            client.checkChatFolder(payload),
          ),
        checkApprovedFolder: (input) =>
          sendDaemonCommand(link, 'checkApprovedFolder', input, (client, payload) =>
            client.checkApprovedFolder(payload),
          ),
        getActiveWork: (input) =>
          sendDaemonCommand(link, 'getActiveWork', input, (client, payload) =>
            client.getActiveWork(payload),
          ),
        markFolderAsProject: (input) =>
          sendDaemonCommand(link, 'markFolderAsProject', input, (client, payload) =>
            client.markFolderAsProject(payload),
          ),
        listHostFolders: (input) =>
          sendDaemonCommand(link, 'listHostFolders', input, (client, payload) =>
            client.listHostFolders(payload),
          ),
      } satisfies LocalHostHandlers;
    }),
  );

export type RemoteProviderSetupConfiguration = {
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
 * Provider setup on a daemon, scoped to owners the client names. Sign-in links come back
 * validated and open through the client's `openUrl`; setup state is pushed to `watch`.
 */
export const RemoteProviderSetupLive = (
  config: RemoteProviderSetupConfiguration,
): Layer.Layer<ProviderSetupService, never, DaemonRpcLink> =>
  Layer.effect(
    ProviderSetupService,
    Effect.gen(function* () {
      const link = yield* DaemonRpcLink;
      const host = link.host;
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
      const checkUrl = (flowId: string) => (output: DaemonOutput<'openProviderUrl'>) =>
        readProviderSignInUrl(output.url) !== output.url || output.state.flow?.id !== flowId
          ? Effect.fail(invalidReply())
          : Effect.void;
      const getUrl = (ownerId: string, flowId: string) =>
        sendDaemonCommand(
          link,
          'openProviderUrl',
          { host, ownerId, flowId },
          (client, payload) => client.openProviderUrl(payload),
          checkUrl(flowId),
        );
      const openUrl = (url: string) =>
        Effect.tryPromise({
          try: () => config.openUrl(url),
          catch: (error) =>
            error instanceof ProviderSetupUnavailableError
              ? error
              : new ProviderSetupUnavailableError({ reason: 'browser' }),
        });
      /** A command's reply as the client shows its state. */
      const presentState = <A extends { state: ProviderState }, E>(reply: Effect.Effect<A, E>) =>
        Effect.map(reply, (output) => present(output.state));
      const forOwner = (ownerId: string): ProviderSetupHandlers => {
        const owned = { host, ownerId };
        // A mutation carries a request ID of its own, which its reply echoes.
        const mutation = () => ({ ...owned, requestId: randomUUID() });
        return {
          getProviders: () =>
            presentState(
              sendDaemonCommand(link, 'getProviders', owned, (client, payload) =>
                client.getProviders(payload),
              ),
            ),
          startProviderLogin: ({ providerId }) =>
            presentState(
              sendDaemonCommand(
                link,
                'startProviderLogin',
                { ...mutation(), providerId },
                (client, payload) => client.startProviderLogin(payload),
              ),
            ),
          answerProviderPrompt: ({ flowId, promptId, answer }) =>
            presentState(
              sendDaemonCommand(
                link,
                'answerProviderPrompt',
                { ...mutation(), flowId, promptId, answer },
                (client, payload) => client.answerProviderPrompt(payload),
              ),
            ),
          cancelProviderLogin: ({ flowId }) =>
            presentState(
              sendDaemonCommand(
                link,
                'cancelProviderLogin',
                { ...mutation(), flowId },
                (client, payload) => client.cancelProviderLogin(payload),
              ),
            ),
          openProviderUrl: ({ flowId }) =>
            Effect.flatMap(getUrl(ownerId, flowId), (output) =>
              Effect.as(openUrl(output.url), present(output.state)),
            ),
          logoutProvider: ({ providerId }) =>
            presentState(
              sendDaemonCommand(
                link,
                'logoutProvider',
                { ...mutation(), providerId },
                (client, payload) => client.logoutProvider(payload),
              ),
            ),
        };
      };
      return {
        forOwner,
        releaseOwner: (ownerId) =>
          sendDaemonCommand(link, 'releaseProviderOwner', { host, ownerId }, (client, payload) =>
            client.releaseProviderOwner(payload),
          ),
        watch: (ownerId) =>
          followWatch(
            link,
            'watchProviderSetup',
            'providerSetup',
            (client) => client.watchProviderSetup({ host, ownerId }),
            { capability: daemonCommandCapabilities.getProviders },
          ).pipe(
            Stream.filter((update) => !('reconnecting' in update)),
            Stream.map((update) => present((update as { value: ProviderState }).value)),
          ),
        getProviderUrl: (ownerId, flowId) =>
          Effect.map(getUrl(ownerId, flowId), (output) => output.url),
      };
    }),
  );

/**
 * A daemon's chat, folder and provider setup services over one RPC link to it, through an injected
 * `ConnectionService`.
 */
export const RemoteDaemonLive = (
  config: { host: ChatHostTarget } & RemoteProviderSetupConfiguration,
) =>
  Layer.mergeAll(RemoteChatLive, RemoteLocalHostLive, RemoteProviderSetupLive(config)).pipe(
    Layer.provide(DaemonRpcLinkLive({ host: config.host })),
  );
