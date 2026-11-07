import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatDependencies } from '@moonbase/application/chat';
import type {
  ChatClient,
  ChatSnapshot,
  ChatSummary,
  ChatCreationSettings,
} from '@moonbase/contracts/chat';
import type { ConnectionClient, ConnectionSnapshot } from '@moonbase/contracts/connection';
import { chatFilesFeature, chatFileMatchLimit, type ChatInput } from '@moonbase/contracts/chat';
import { compareMatches, matchPath } from '@moonbase/contracts/lookup';

/** The demo working folder's files, for @ mentions. */
export const demoFiles = [
  'README.md',
  'package.json',
  'apps/desktop/README.md',
  'apps/desktop/src/renderer/chat/view.tsx',
  'apps/desktop/src/renderer/chat/composer.tsx',
  'apps/desktop/src/main.ts',
  'packages/workbench/src/editor/workbench.tsx',
  'packages/workbench/src/editor/file-lookup.tsx',
  'docs/Release notes.md',
];

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
  let listings = 0;
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
  const chat: ChatClient = {
    async command(operation, input) {
      calls.push(operation);
      switch (operation) {
        case 'getChatHost':
          return (
            local
              ? { ...context, mode: 'local', features: [chatFilesFeature] }
              : {
                  ...context,
                  cwd: conversation.cwd,
                  model: conversation.model,
                  features: [chatFilesFeature],
                }
          ) as never;
        case 'listChats':
          // `?activity` adds chats after the first listing, which marks only that one as seen.
          return {
            conversations:
              activity && ++listings > 1 ? [conversation, ...activityChats()] : [conversation],
            nextCursor: null,
          } as never;
        case 'getChat': {
          const id = (input as ChatInput<'getChat'>).target.conversationId;
          const listed =
            activity && activityChats().find((chat) => chat.target.conversationId === id);
          return (
            listed
              ? { ...structuredClone(snapshot), conversation: listed, entries: [] }
              : structuredClone(snapshot)
          ) as never;
        }
        case 'createChat':
          if (local) {
            const creation = input as {
              title: string;
              settings: ChatCreationSettings;
            };
            conversation.title = creation.title;
            conversation.cwd = creation.settings.cwd;
            conversation.model = creation.settings.model.modelId;
            conversation.reasoningEffort = creation.settings.reasoningEffort;
          }
          return { requestId: (input as { requestId: string }).requestId, conversation } as never;
        case 'sendChat':
          sent.push(structuredClone(input as ChatInput<'sendChat'>));
          if (local) {
            const message = input as { requestId: string; text: string };
            snapshot.entries.unshift(
              {
                id: message.requestId + '-reply',
                role: 'assistant',
                text: 'I’ll inspect the desktop shell and file sidebar, then check that the editor keeps its buffers and undo history when switching views.',
                truncated: false,
              },
              { id: message.requestId, role: 'user', text: message.text, truncated: false },
            );
            controls.receiveChat(structuredClone(snapshot));
          }
          return {
            target,
            requestId: (input as { requestId: string }).requestId,
            admission: 'admitted',
            submissionId: 'submission',
          } as never;
        case 'getChatTranscriptContent':
        case 'findChatTranscript':
        case 'getChatHistoryAround':
          throw new ApplicationError({
            code: 'Incompatible',
            message: 'This legacy demo does not advertise transcript reads.',
          });
        case 'findChatFiles': {
          const { query } = input as ChatInput<'findChatFiles'>;
          const matches = demoFiles
            .map((path) =>
              query.trim() ? matchPath(path, query) : { path, score: 0, positions: [] },
            )
            .filter((match) => match !== null)
            .sort(query.trim() ? compareMatches : () => 0)
            .slice(0, chatFileMatchLimit)
            .map(({ path, positions }) => ({ path, positions }));
          return { query, matches, partial: false } as never;
        }
        case 'getChatSend':
          return null as never;
        case 'stopChat':
          return { ...input, outcome: 'terminal' } as never;
        default:
          throw Error(`Unexpected fake operation: ${operation}`);
      }
    },
    watch(_input, receive) {
      controls.receiveChat = receive;
      controls.observations++;
      return close();
    },
  };
  const connection: ConnectionClient = {
    async command(operation) {
      calls.push(operation);
      if (operation === 'connect')
        connectionState = {
          state: 'connected',
          connectionId: 'connection',
          profile,
          health: { ...context.host, protocol: 1, version: '0.1.0', capabilities: ['chat-v0'] },
        };
      if (operation === 'disconnect')
        connectionState = { state: 'disconnected', connectionId: null, profile };
      receiveConnection(connectionState);
      return connectionState as never;
    },
    watch(receive) {
      receiveConnection = receive;
      controls.observations++;
      return close();
    },
  };
  const dependencies: ChatDependencies = {
    chat,
    ...(local
      ? {
          mode: 'local' as const,
          providers: {
            command: async (operation: string) => {
              if (operation !== 'getProviders') throw Error('Demo provider setup is read-only.');
              return {
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
              };
            },
          },
        }
      : { connection }),
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
    target,
    snapshot,
    storage,
    controls,
    calls,
    sent,
    worktrees,
    createWorktree,
  };
}
