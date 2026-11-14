import { randomUUID } from 'node:crypto';
import { Effect, Layer, Stream } from 'effect';
import type { ChatCommand, ChatInput, ChatOutput } from '@moonbase/contracts/chat';
import { checkChatOutput, isChatMutation } from '@moonbase/contracts/chat-validation';
import { chatInputSchemas } from '@moonbase/contracts/chat-schema';
import type {
  DaemonInput,
  DaemonOutput,
  HostProviderCommand,
  LocalHostCommand,
} from '@moonbase/contracts/daemon';
import {
  daemonCommandCapabilities,
  isDaemonMutation,
  localHostInputSchemas,
} from '@moonbase/contracts/daemon-schema';
import { chatHostCapabilities, type ChatHostTarget } from '@moonbase/contracts/host';
import type { ProviderCommand, ProviderInput, ProviderState } from '@moonbase/contracts/providers';
import { readProviderSignInUrl } from '@moonbase/contracts/providers-schema';
import {
  ChatService,
  LocalHostService,
  ProviderSetupService,
  type ChatServiceShape,
  type LocalHostHandlers,
  type ProviderSetupHandlers,
} from '@moonbase/contracts/services';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { fail } from '@moonbase/contracts/errors';
import { DaemonRpcLink, DaemonRpcLinkLive } from './rpc-link.ts';

/** A daemon's chat over its RPC link: every procedure, each reply checked against its request. */
export const RemoteChatLive: Layer.Layer<ChatService, never, DaemonRpcLink> = Layer.effect(
  ChatService,
  Effect.gen(function* () {
    const link = yield* DaemonRpcLink;
    const call =
      <K extends ChatCommand>(operation: K) =>
      (input: ChatInput<K>) =>
        link.call<ChatOutput<K>>(
          operation,
          { host: link.host, input },
          {
            kind: 'chat',
            mutation: isChatMutation(operation),
            // A chat a client makes chooses its own folder and model, which only a daemon offers.
            capability:
              operation === 'createChat' ? chatHostCapabilities.local : chatHostCapabilities.chat,
            check: (output, health) => {
              // Every host is a daemon whose chats choose their own folder and model.
              if (
                operation === 'getChatHost' &&
                !health.capabilities.includes(chatHostCapabilities.local)
              )
                fail('Incompatible', 'This host does not run the Moonbase daemon. Update it.');
              checkChatOutput(operation, output, input);
            },
          },
        );
    const handlers = Object.fromEntries(
      (Object.keys(chatInputSchemas) as ChatCommand[]).map((operation) => [
        operation,
        call(operation),
      ]),
    ) as unknown as Omit<ChatServiceShape, 'watch' | 'watchChatList'>;
    return {
      ...handlers,
      // While the connection is down the last snapshot is shown as reconnecting.
      watch: ({ target }) => {
        let last: ChatOutput<'getChat'> | undefined;
        return link
          .watch(
            'watchChat',
            'chat',
            { host: link.host, target },
            {
              capability: chatHostCapabilities.chat,
              kindOfErrors: 'chat',
              check: (value) => void checkChatOutput('getChat', value, { target }),
            },
          )
          .pipe(
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
        link
          .watch(
            'watchChatList',
            'chatList',
            { host: link.host, session },
            {
              capability: chatHostCapabilities.chat,
              kindOfErrors: 'chat',
              // Every row, on the first page or past it, stays within the watched host and actor.
              check: ({ list, changed }) => {
                checkChatOutput('listChats', list, { session });
                checkChatOutput(
                  'listChats',
                  { conversations: changed, nextCursor: null },
                  { session },
                );
              },
            },
          )
          .pipe(
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
const sendDaemonCommand = <K extends LocalHostCommand | HostProviderCommand>(
  link: DaemonRpcLink['Service'],
  operation: K,
  input: DaemonInput<K>,
  check?: (output: DaemonOutput<K>) => void,
) =>
  link.call<DaemonOutput<K>>(
    operation,
    { host: link.host, input },
    {
      kind: 'daemon',
      mutation: isDaemonMutation(operation),
      capability: daemonCommandCapabilities[operation],
      check: (output) => {
        const requestId = (input as { requestId?: string }).requestId;
        if (requestId !== undefined && (output as { requestId?: string }).requestId !== requestId)
          fail('Unavailable', 'Daemon request identity changed.');
        check?.(output);
      },
    },
  );

/** A daemon's folder approvals and control over its RPC link. */
export const RemoteLocalHostLive: Layer.Layer<LocalHostService, never, DaemonRpcLink> =
  Layer.effect(
    LocalHostService,
    Effect.gen(function* () {
      const link = yield* DaemonRpcLink;
      return Object.fromEntries(
        (Object.keys(localHostInputSchemas) as LocalHostCommand[]).map((operation) => [
          operation,
          (input: DaemonInput<typeof operation>) => sendDaemonCommand(link, operation, input),
        ]),
      ) as unknown as LocalHostHandlers;
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
      const checkUrl = (flowId: string) => (output: DaemonOutput<'openProviderUrl'>) => {
        if (readProviderSignInUrl(output.url) !== output.url || output.state.flow?.id !== flowId)
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
          input: ProviderInput<K>,
        ) =>
          sendDaemonCommand(
            link,
            operation,
            {
              host,
              ownerId,
              ...(isDaemonMutation(operation) ? { requestId: randomUUID() } : {}),
              ...input,
            } as DaemonInput<K>,
            operation === 'openProviderUrl'
              ? (checkUrl((input as { flowId: string }).flowId) as never)
              : undefined,
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
          link
            .watch(
              'watchProviderSetup',
              'providerSetup',
              { host, ownerId },
              {
                capability: daemonCommandCapabilities.getProviders,
                kindOfErrors: 'daemon',
              },
            )
            .pipe(
              Stream.filter((update) => !('reconnecting' in update)),
              Stream.map((update) => present((update as { value: ProviderState }).value)),
            ),
        getProviderUrl: (ownerId, flowId) =>
          Effect.map(
            sendDaemonCommand(link, 'openProviderUrl', { host, ownerId, flowId }, checkUrl(flowId)),
            (output) => output.url,
          ),
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
