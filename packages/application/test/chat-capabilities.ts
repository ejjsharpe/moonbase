import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatDependencies } from '@moonbase/application/chat';
import type { ChatClient, ChatSnapshot } from '@moonbase/contracts/chat';
import type { ConnectionClient, ConnectionSnapshot } from '@moonbase/contracts/connection';

/** Pure controlled capabilities, shared by lifecycle tests and portable consumers. */
export function chatCapabilities() {
  const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'actor' };
  const target = { ...context, conversationId: 'conversation' };
  const conversation = {
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
    transcriptBoundary: null,
  };
  const profile = {
    id: 'profile',
    label: 'Controlled',
    destination: 'controlled',
    remotePort: 8787,
    expected: context.host,
  };
  let connectionGeneration = 0;
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
  // Trusted ChatClient: it stands in for a boundary that already decoded and bounded replies.
  const chat: ChatClient = {
    async command(operation, input) {
      calls.push(operation);
      switch (operation) {
        case 'getChatHost':
          return { ...context, cwd: conversation.cwd, model: conversation.model } as never;
        case 'listChats':
          return { conversations: [conversation], nextCursor: null } as never;
        case 'getChat':
          return structuredClone(snapshot) as never;
        case 'createChat':
          return { requestId: (input as { requestId: string }).requestId, conversation } as never;
        case 'sendChat':
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
            message: 'This fixture serves no transcript reads.',
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
          connectionId: 'connection-' + ++connectionGeneration,
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
    connection,
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
