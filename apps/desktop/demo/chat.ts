import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatDependencies } from '@moonbase/application/chat';
import type {
  ChatClient,
  ChatSnapshot,
  ChatSummary,
  ChatCreationSettings,
} from '@moonbase/contracts/chat';
import type { ConnectionClient, ConnectionSnapshot } from '@moonbase/contracts/connection';

/** Volatile browser demo capabilities; no host, transport or provider is installed. */
export function chatCapabilities(local = false) {
  const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'actor' };
  const target = { ...context, conversationId: 'conversation' };
  const conversation: ChatSummary = {
    target,
    title: 'Conversation',
    cwd: '/remote',
    model: 'fake',
    createdAt: '2026-01-01T00:00:00Z',
  };
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
              ? { ...context, mode: 'local' }
              : { ...context, cwd: conversation.cwd, model: conversation.model }
          ) as never;
        case 'listChats':
          return { conversations: [conversation], nextCursor: null } as never;
        case 'getChat':
          return structuredClone(snapshot) as never;
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
  return { dependencies, target, snapshot, storage, controls, calls };
}
