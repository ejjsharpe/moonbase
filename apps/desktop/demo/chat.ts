import { Effect, Queue, Stream } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import { chatProtocolVersion } from '@moonbase/contracts/host';
import { chatInputSchemas } from '@moonbase/contracts/chat-schema';
import { providerInputSchemas } from '@moonbase/contracts/providers-schema';
import type {
  ChatDependencies,
  ChatPort,
  ConnectionPort,
  ProviderSetupPort,
} from '@moonbase/application/chat';
import type {
  ChatCommand,
  ChatEntry,
  ChatListUpdate,
  ChatSnapshot,
  ChatSummary,
  ChatCreationSettings,
  ChatTarget,
} from '@moonbase/contracts/chat';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import { chatFileMatchLimit, type ChatInput, type ChatOutput } from '@moonbase/contracts/chat';
import { compareMatches, matchPath } from '@moonbase/contracts/lookup';

/** The demo host's answer to each chat command, as a browser test may replace one. */
export type DemoChatCommands = {
  [K in ChatCommand]: (
    input: ChatInput<K>,
    options: { signal?: AbortSignal },
  ) => Promise<ChatOutput<K>>;
};
type DemoChatCommand = (input: never, options: { signal?: AbortSignal }) => Promise<unknown>;

/** A failure as the chat reads it: an `ApplicationError` as it is, anything else Unavailable. */
const toApplicationError = (error: unknown) =>
  ApplicationError.is(error)
    ? error
    : new ApplicationError({ code: 'Unavailable', message: 'Application effect failed' });
const unexpected = (operation: string) => async (): Promise<never> => {
  throw Error(`Unexpected fake operation: ${operation}`);
};
const noTranscript = async (): Promise<never> => {
  throw new ApplicationError({
    code: 'Incompatible',
    message: 'This demo serves no transcript reads.',
  });
};
/** Every provider command but `getProviders`, which the demo answers. */
const readOnlyProviders = Object.fromEntries(
  Object.keys(providerInputSchemas).map((operation) => [
    operation,
    () =>
      Effect.fail(
        new ApplicationError({
          code: 'InvalidInput',
          message: 'Demo provider setup is read-only.',
        }),
      ),
  ]),
);

/** The demo working folder's files, for @ mentions. */
export const demoFiles = [
  'README.md',
  'package.json',
  'apps/desktop/README.md',
  'apps/desktop/src/renderer/chat/view.tsx',
  'apps/desktop/src/renderer/chat/composer.tsx',
  'apps/desktop/src/main/main.ts',
  'packages/workbench/src/workbench.tsx',
  'packages/workbench/src/editor/file-lookup.tsx',
  'docs/Release notes.md',
];

/** A demo message whose transcript is its whole text, as one part. */
async function makeEntry(
  target: ChatTarget,
  id: string,
  role: 'user' | 'assistant',
  text: string,
): Promise<ChatEntry> {
  const bytes = new TextEncoder().encode(text);
  const revision = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return {
    id,
    role,
    text,
    truncated: false,
    transcript: {
      source: { kind: 'entry', target, entryId: id },
      parts: [
        {
          partId: 'm0.b0',
          kind: 'text',
          role,
          availability: 'available',
          encoding: 'utf8',
          text,
          truncated: false,
          bytes: bytes.length,
          revision,
        },
      ],
      nextCursor: null,
      thinking: 'none',
    },
  };
}

/** Volatile, trusted browser demo capabilities; no host, transport or provider is installed. */
export function chatCapabilities(local = false, activity = false) {
  const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'actor' };
  const target = { ...context, conversationId: 'conversation' };
  const conversation: ChatSummary = {
    target,
    title: 'Conversation',
    cwd: '/remote',
    model: 'fake',
    createdAt: '2026-01-01T00:00:00Z',
  };
  let added = false,
    ownFolders = 0;
  /** Open chat-list watches; `?activity` pushes its added chats to them. */
  const listWatches = new Set<(list: ChatOutput<'listChats'>) => void>();
  const listPage = () =>
    ({
      conversations: (added ? [conversation, ...activityChats()] : [conversation]).map(withSettled),
      nextCursor: null,
    }) as ChatOutput<'listChats'>;
  /** When each chat was settled, as the host keeps it; a Send unsettles it. */
  const settled = new Map<string, string>();
  const withSettled = (chat: ChatSummary): ChatSummary => {
    const { settledAt: _, ...rest } = chat;
    const at = settled.get(chat.target.conversationId);
    return at ? { ...rest, settledAt: at } : rest;
  };
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const activityChats = (): ChatSummary[] =>
    (
      [
        ['dock', 'Fix the dock resize handle', '/work/moonbase', 'failed', 4],
        ['tour', 'Summarise this repository', '/work/moonbase', 'idle', 12],
        ['watcher', 'Audit file-watcher flakes', '/work/moonbase', 'stopped', 60],
        ['legend', 'Move the transcript to Legend List', '/work/moonbase', 'running', 0],
        ['docs', 'Translate the docs site', '/work/pi-docs', 'running', 2],
        ['palette', 'Pick a palette', '/work/moonbase', 'idle', 60 * 30],
      ] as const
    ).map(([id, title, cwd, state, minutes]) => ({
      target: { ...context, conversationId: id },
      title,
      cwd,
      model: 'fake',
      createdAt: ago(minutes + 30),
      activity: { state, at: ago(minutes) },
    }));
  const snapshot: ChatSnapshot = {
    conversation,
    state: 'idle',
    run: null,
    entries: [],
    olderCursor: null,
    transcriptBoundary: null,
  };
  const profile = {
    id: 'profile',
    label: 'Controlled',
    destination: 'controlled',
    remotePort: 8787,
    expected: context.host,
  };
  let connectionState: ConnectionSnapshot = { state: 'disconnected', connectionId: null, profile };
  let receiveConnection: (state: ConnectionSnapshot) => void = () => {};
  const calls: string[] = [];
  const sent: ChatInput<'sendChat'>[] = [];
  /** Worktrees a new local chat asked for, as `root branch`; main makes them in the app. */
  const worktrees: string[] = [];
  const createWorktree = async (root: string, branch: string) => {
    worktrees.push(`${root} ${branch}`);
    return `${root}-worktrees/${branch.replaceAll('/', '-')}`;
  };
  /** Like main: a chat without a project's folder becomes a project where it is. */
  const turnIntoProject = async (conversationId: string) => {
    if (conversation.target.conversationId !== conversationId || !conversation.ownFolder)
      throw new ApplicationError({
        code: 'InvalidInput',
        message: 'Only a chat without a project can become one.',
      });
    delete conversation.ownFolder;
    controls.receiveChat(structuredClone({ ...snapshot, conversation: withSettled(conversation) }));
    return conversation.cwd;
  };
  const storage = { value: null as string | null, writes: 0, write: (_value: string) => {} };
  const controls = {
    release: async () => {},
    receiveChat: (_snapshot: ChatSnapshot) => {},
    observations: 0,
    closed: 0,
  };
  const close = () => {
    let completion: Promise<void> | undefined;
    return () =>
      (completion ??= controls.release().then(() => {
        controls.closed++;
      }));
  };
  /** One watch: counted while open, and closed through `controls.release`, once. */
  const observe = <A>(register: (offer: (value: A) => void) => () => void) =>
    Stream.callback<A, ApplicationError>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          controls.observations++;
          return register((value) => Queue.offerUnsafe(queue, value));
        }),
        (unregister) =>
          Effect.sync(unregister).pipe(
            Effect.andThen(Effect.tryPromise({ try: close(), catch: toApplicationError })),
            Effect.orDie,
          ),
      ),
    );
  /**
   * The fake host's answer to each chat command. A browser test may replace one to hold or fail
   * it; the chat port calls whichever is here when the command runs.
   */
  const commands: DemoChatCommands = {
    getChatHost: async () => ({ ...context, mode: 'local' }),
    listChats: async () => {
      const page = listPage();
      // `?activity` adds chats after the first listing, which marks only that one as seen;
      // the open list watches then deliver them.
      if (activity && !added) {
        added = true;
        setTimeout(() => listWatches.forEach((receive) => receive(listPage())));
      }
      return page;
    },
    getChat: async (input) => {
      const id = input.target.conversationId;
      const listed = activity && activityChats().find((chat) => chat.target.conversationId === id);
      const opened = listed
        ? { ...structuredClone(snapshot), conversation: listed, entries: [] }
        : structuredClone(snapshot);
      return { ...opened, conversation: withSettled(opened.conversation) };
    },
    createChat: async (input) => {
      // The local fixture plays the host; the remote one answers with its saved chat.
      if (local) {
        const creation = input as { title: string; settings: ChatCreationSettings };
        conversation.title = creation.title;
        // Like the host, a chat without a project gets a new folder of its own.
        conversation.cwd = creation.settings.cwd ?? `/demo/chats/chat-${++ownFolders}`;
        if (creation.settings.cwd) delete conversation.ownFolder;
        else conversation.ownFolder = true;
        conversation.model = creation.settings.model.modelId;
        conversation.reasoningEffort = creation.settings.reasoningEffort;
      }
      return { requestId: input.requestId, conversation } as never;
    },
    sendChat: async (input) => {
      sent.push(structuredClone(input));
      settled.delete(input.target.conversationId);
      if (local) {
        const message = input as { requestId: string; text: string },
          replyId = message.requestId + '-reply';
        snapshot.entries.unshift(
          await makeEntry(
            target,
            replyId,
            'assistant',
            'I’ll inspect the desktop shell and file sidebar, then check that the editor keeps its buffers and undo history when switching views.',
          ),
          await makeEntry(target, message.requestId, 'user', message.text),
        );
        snapshot.transcriptBoundary = replyId;
        controls.receiveChat(structuredClone(snapshot));
      }
      return {
        target,
        requestId: input.requestId,
        admission: 'admitted',
        submissionId: 'submission',
      } as never;
    },
    getChatHistory: unexpected('getChatHistory'),
    getChatTranscriptContent: noTranscript,
    findChatTranscript: noTranscript,
    getChatHistoryAround: noTranscript,
    findChatFiles: async (input) => {
      const { query } = input;
      const matches = demoFiles
        .map((path) => (query.trim() ? matchPath(path, query) : { path, score: 0, positions: [] }))
        .filter((match) => match !== null)
        .sort(query.trim() ? compareMatches : () => 0)
        .slice(0, chatFileMatchLimit)
        .map(({ path, positions }) => ({ path, positions }));
      return { query, matches, partial: false };
    },
    getChatSend: async () => null,
    stopChat: async (input) => ({ ...input, outcome: 'terminal' }) as never,
    settleChat: async (request) => {
      const id = request.target.conversationId;
      if (!request.settled) settled.delete(id);
      else if (!settled.has(id)) settled.set(id, new Date().toISOString());
      const chat =
        (activity && activityChats().find((c) => c.target.conversationId === id)) || conversation;
      return withSettled(chat);
    },
  };
  const chat = {
    ...Object.fromEntries(
      (Object.keys(chatInputSchemas) as ChatCommand[]).map((operation) => [
        operation,
        (input: never) =>
          Effect.tryPromise({
            try: (signal) => {
              calls.push(operation);
              return (commands[operation] as DemoChatCommand)(input, { signal });
            },
            catch: toApplicationError,
          }),
      ]),
    ),
    watch: () =>
      observe<ChatSnapshot>((receive) => {
        controls.receiveChat = receive;
        return () => {};
      }),
    // The list watch delivers the current page after subscribing, then each page `?activity` adds.
    watchChatList: () =>
      observe<ChatListUpdate>((receive) => {
        const deliver = (list: ChatOutput<'listChats'>) =>
          receive({ list, changed: [], dropped: 0, reset: false });
        listWatches.add(deliver);
        void Promise.resolve().then(() => {
          if (listWatches.has(deliver)) deliver(listPage());
        });
        return () => listWatches.delete(deliver);
      }),
  } as unknown as ChatPort;
  const connect = (operation: string, change: () => void) => () =>
    Effect.sync(() => {
      calls.push(operation);
      change();
      receiveConnection(connectionState);
      return connectionState;
    });
  const connection = {
    getConnection: connect('getConnection', () => {}),
    connect: connect('connect', () => {
      connectionState = {
        state: 'connected',
        connectionId: 'connection',
        profile,
        health: {
          ...context.host,
          protocol: chatProtocolVersion,
          version: '0.1.0',
          capabilities: ['chat-v0'],
        },
      };
    }),
    disconnect: connect('disconnect', () => {
      connectionState = { state: 'disconnected', connectionId: null, profile };
    }),
    watch: () =>
      observe<ConnectionSnapshot>((receive) => {
        receiveConnection = receive;
        return () => {};
      }),
  } as unknown as ConnectionPort;
  // Every host is a daemon whose chats choose their folder and model; a remote one is connected.
  const dependencies: ChatDependencies = {
    chat,
    ...(local ? {} : { connection }),
    providers: {
      watch: () => Stream.never,
      ...readOnlyProviders,
      getProviders: () =>
        Effect.succeed({
          providers: [
            {
              id: 'openai',
              name: 'Demo provider',
              auth: 'api_key' as const,
              configured: true,
              defaultModel: {
                model: { provider: 'openai', modelId: 'demo-model' },
                reasoningEffort: 'medium' as const,
              },
              models: [
                {
                  modelId: 'demo-model',
                  name: 'Demo model',
                  reasoningEfforts: ['low', 'medium', 'high'] as const,
                  defaultReasoningEffort: 'medium' as const,
                },
                {
                  modelId: 'demo-coding',
                  name: 'Demo coding model',
                  reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] as const,
                  defaultReasoningEffort: 'medium' as const,
                },
              ].map((model) => ({ ...model, reasoningEfforts: [...model.reasoningEfforts] })),
            },
            {
              id: 'claude-code',
              name: 'Claude subscription',
              auth: 'claude_code' as const,
              configured: false,
              models: [],
            },
            // `?providers` adds a second provider that is set up and one that is not.
            ...(new URLSearchParams(location.search).has('providers')
              ? [
                  {
                    id: 'anthropic',
                    name: 'Anthropic',
                    auth: 'api_key' as const,
                    configured: true,
                    models: [
                      {
                        modelId: 'demo-opus',
                        name: 'Demo Opus',
                        reasoningEfforts: [...(['low', 'medium', 'high', 'max'] as const)],
                        defaultReasoningEffort: 'high' as const,
                      },
                      { modelId: 'demo-haiku', name: 'Demo Haiku' },
                    ],
                  },
                  {
                    id: 'google',
                    name: 'Google Gemini',
                    auth: 'api_key' as const,
                    configured: false,
                    models: [{ modelId: 'demo-flash', name: 'Demo Flash' }],
                  },
                ]
              : []),
          ],
          flow: null,
        }),
    } as unknown as ProviderSetupPort,
    context,
    storage: {
      read: () => storage.value,
      write(value) {
        storage.writes++;
        storage.write(value);
        storage.value = value;
      },
    },
  };
  return {
    dependencies,
    commands,
    target,
    snapshot,
    storage,
    controls,
    calls,
    sent,
    worktrees,
    createWorktree,
    turnIntoProject,
  };
}
