import type { Effect, Stream } from 'effect';
import type { IpcError } from '@moonbase/contracts/ipc-errors';
import type {
  ChatCommand,
  ChatInput,
  ChatListUpdate,
  ChatOutput,
  ChatSession,
  ChatSnapshot,
  ChatTarget,
} from '@moonbase/contracts/chat';
import type {
  ConnectionCommand,
  ConnectionInput,
  ConnectionOutput,
  ConnectionSnapshot,
} from '@moonbase/contracts/connection';
import type { ConnectionFailure } from '@moonbase/contracts/connection-errors';
import type { ProviderCommand, ProviderInput, ProviderState } from '@moonbase/contracts/providers';
import type { ChatServiceError, ProviderSetupServiceError } from '@moonbase/contracts/services';
import type { TranscriptLimits } from './transcript/transcript-state.ts';
import type { TranscriptViewMemory } from './transcript/transcript-view-memory.ts';

// What the chat runs on (D16): Effect ports, typed like the services in contracts. A chat host's
// `ChatService` is a `ChatPort` as it is; the desktop renderer builds one over IPC, which can also
// fail with desktop IPC's own errors.

/** One chat host's commands and watches. */
export type ChatPort = {
  readonly [K in ChatCommand]: (
    input: ChatInput<K>,
  ) => Effect.Effect<ChatOutput<K>, ChatServiceError | IpcError>;
} & {
  readonly watch: (input: {
    target: ChatTarget;
  }) => Stream.Stream<ChatSnapshot, ChatServiceError | IpcError>;
  readonly watchChatList: (input: {
    session: ChatSession;
  }) => Stream.Stream<ChatListUpdate, ChatServiceError | IpcError>;
};

/** How a host on another machine is connected. */
export type ConnectionPort = {
  readonly [K in ConnectionCommand]: (
    input: ConnectionInput<K>,
  ) => Effect.Effect<ConnectionOutput<K>, ConnectionFailure | IpcError>;
} & {
  readonly watch: () => Stream.Stream<ConnectionSnapshot, ConnectionFailure | IpcError>;
};

/** One owner's provider setup on a chat host. */
export type ProviderSetupPort = {
  readonly [K in ProviderCommand]: (
    input: ProviderInput<K>,
  ) => Effect.Effect<ProviderState, ProviderSetupServiceError | IpcError>;
} & {
  /** The setup state, then again after each change, so a sign-in's progress needs no polling. */
  readonly watch: () => Stream.Stream<ProviderState, ProviderSetupServiceError | IpcError>;
};

/** Where drafts are kept: synchronous, so a draft is kept before the edit returns. */
export interface DraftStorage {
  read(): string | null;
  write(value: string): void;
}

/** What one chat target's chat is built from. */
export type ChatDependencies = {
  chat: ChatPort;
  /** How a host on another machine is connected; absent for one on this machine. */
  connection?: ConnectionPort;
  providers?: ProviderSetupPort;
  context: ChatSession;
  storage: DraftStorage;
  newId?: () => string;
  backendId?: string;
  transcriptMemory?: TranscriptViewMemory;
  /** Replaces some of `defaultTranscriptLimits`. Its watch retry also paces the other watches. */
  transcriptLimits?: Partial<TranscriptLimits>;
};
