import { Effect, Queue, Stream } from 'effect';
import { chatProtocolVersion } from '@moonbase/contracts/host';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import { HostUnavailableError } from '@moonbase/contracts/host-errors';
import type { ChatDependencies, ChatPort, ConnectionPort } from '../chat/chat-ports.ts';

/** Controlled chat and connection ports, shared by lifecycle tests and portable consumers. */
export function fauxChat() {
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
  const connectionWatches = new Set<(state: ConnectionSnapshot) => void>();
  const calls: string[] = [];
  const storage = { value: null as string | null, writes: 0, write: (_value: string) => {} };
  const controls = {
    /** Holds each watch's close until it settles. */
    release: async () => {},
    /** Delivers a snapshot to the open chat's watch. */
    receiveChat: (_snapshot: ChatSnapshot) => {},
    /** Watches opened, and watches that have since closed. */
    observations: 0,
    closed: 0,
  };
  /** A watch that counts its opening and closing. */
  const observed = <A>(stream: Stream.Stream<A>) =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.sync(() => {
          controls.observations++;
          return stream;
        }),
        () =>
          Effect.promise(() =>
            controls.release().then(
              () => {
                controls.closed++;
              },
              () => {
                controls.closed++;
              },
            ),
          ),
      ),
    ).pipe(Stream.scoped);
  const record = <A>(operation: string, value: () => A) =>
    Effect.sync(() => {
      calls.push(operation);
      return value();
    });
  const noTranscript = () => Effect.fail(new HostUnavailableError({ reason: 'failed' }));
  // A trusted port: it stands in for a boundary that already decoded and bounded replies.
  const chat: ChatPort = {
    getChatHost: () => record('getChatHost', () => ({ ...context, mode: 'local' as const })),
    listChats: () =>
      record('listChats', () => ({ conversations: [conversation], nextCursor: null })),
    getChat: () => record('getChat', () => structuredClone(snapshot)),
    createChat: (input) =>
      record('createChat', () => ({ requestId: input.requestId, conversation })),
    sendChat: (input) =>
      record('sendChat', () => ({
        target,
        requestId: input.requestId,
        admission: 'admitted' as const,
        submissionId: 'submission',
      })),
    getChatSend: () => record('getChatSend', () => null),
    stopChat: (input) => record('stopChat', () => ({ ...input, outcome: 'terminal' as const })),
    settleChat: (input) =>
      record('settleChat', () => ({
        ...conversation,
        ...(input.settled ? { settledAt: '2026-01-02T00:00:00Z' } : {}),
      })),
    getChatHistory: noTranscript,
    getChatTranscriptContent: noTranscript,
    findChatTranscript: noTranscript,
    getChatHistoryAround: noTranscript,
    findChatFiles: (input) =>
      record('findChatFiles', () => ({ query: input.query, matches: [], partial: false })),
    watch: () =>
      observed(
        Stream.callback<ChatSnapshot>((queue) =>
          Effect.sync(() => {
            controls.receiveChat = (value) => Queue.offerUnsafe(queue, value);
          }),
        ),
      ),
    watchChatList: () => observed(Stream.never),
  } as ChatPort;
  const deliver = () => {
    for (const offer of connectionWatches) offer(connectionState);
  };
  const connection: ConnectionPort = {
    getConnection: () => record('getConnection', () => connectionState),
    connect: () =>
      record('connect', () => {
        connectionState = {
          state: 'connected',
          connectionId: 'connection-' + ++connectionGeneration,
          profile,
          health: {
            ...context.host,
            protocol: chatProtocolVersion,
            version: '0.1.0',
            capabilities: ['chat-v0'],
          },
        };
        deliver();
        return connectionState;
      }),
    disconnect: () =>
      record('disconnect', () => {
        connectionState = { state: 'disconnected', connectionId: null, profile };
        deliver();
      }),
    watch: () =>
      observed(
        Stream.callback<ConnectionSnapshot>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const offer = (state: ConnectionSnapshot) => Queue.offerUnsafe(queue, state);
              connectionWatches.add(offer);
              return offer;
            }),
            (offer) => Effect.sync(() => connectionWatches.delete(offer)),
          ),
        ),
      ),
  } as ConnectionPort;
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
