import type { ProviderCommand, ProviderInput, ProviderOutput, ProviderState } from './providers.ts';
import { Context, type Effect, type Stream } from 'effect';
import {
  type CommandInput,
  type CommandOutput,
  type WorkspaceCommand,
  type WorkspaceEvent,
  type CheckoutTarget,
} from './workspace.ts';
import type { HostCommand, HostInput, HostOutput } from './workspace-host.ts';
import type { WorkspaceHostError } from './workspace-host-errors.ts';
import type { WorkspaceError } from './workspace-errors.ts';
import type { RecoveryOutline } from './recovery.ts';
import type {
  ConnectionCommand,
  ConnectionInput,
  ConnectionOutput,
  ConnectionSnapshot,
} from './connection.ts';
import type { ChatHostTarget, ChatHostHealth } from './host.ts';
import type { ConnectionFailure } from './connection-errors.ts';
import type {
  ChatCommand,
  ChatInput,
  ChatListUpdate,
  ChatOutput,
  ChatSession,
  ChatSnapshot,
  ChatTarget,
} from './chat.ts';
import type { LocalHostCommand, LocalHostInput, LocalHostOutput } from './daemon.ts';
import type { ChatError } from './chat-errors.ts';
import type { FolderError } from './folder-errors.ts';
import type { DaemonLinkError } from './host-errors.ts';
import type { ProviderSetupError } from './provider-errors.ts';

export type WorkspaceHandler<K extends WorkspaceCommand> = (
  input: CommandInput<K>,
) => Effect.Effect<CommandOutput<K>, WorkspaceError>;
export type WorkspaceHandlers = { [K in WorkspaceCommand]: WorkspaceHandler<K> };
/** The file commands and the recovery store's (each of its edits returns once committed). */
export type WorkspaceServiceShape = WorkspaceHandlers & {
  watch(input: {
    checkout: CheckoutTarget;
    paths: string[];
  }): Stream.Stream<WorkspaceEvent, WorkspaceError>;
  /** A client's recovery without draft text, then again each time that changes. */
  watchRecovery(input: { clientId: string }): Stream.Stream<RecoveryOutline, WorkspaceError>;
};
export type WorkspaceHostHandlers = {
  [K in HostCommand]: (input: HostInput<K>) => Effect.Effect<HostOutput<K>, WorkspaceHostError>;
};
export type WorkspaceHostServiceShape = WorkspaceHostHandlers & {
  watch(input: {
    checkout: CheckoutTarget;
    paths: string[];
  }): Stream.Stream<WorkspaceEvent, WorkspaceHostError>;
};
/** A checkout's files and Git, with the save and operation journals; it holds no client recovery. */
export class WorkspaceHostService extends Context.Service<
  WorkspaceHostService,
  WorkspaceHostServiceShape
>()('moonbase/WorkspaceHost') {}
export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceShape>()(
  'moonbase/Workspace',
) {}

export type ConnectionHandlers = {
  [K in ConnectionCommand]: (
    input: ConnectionInput<K>,
  ) => Effect.Effect<ConnectionOutput<K>, ConnectionFailure>;
};
/** Privileged configuration; never expose this shape through a renderer bridge. */
export type ChatHostEndpoint = { origin: string; token: string; expected: ChatHostTarget };
export type VerifiedChatEndpoint = ChatHostEndpoint & {
  connectionId: string;
  health: ChatHostHealth;
};
export type ConnectionServiceShape = ConnectionHandlers & {
  watch(): Stream.Stream<ConnectionSnapshot, ConnectionFailure>;
  /** Privileged consumers only; lookup never connects or changes the expected authority. */
  endpoint(input: { host: ChatHostTarget }): Effect.Effect<VerifiedChatEndpoint, ConnectionFailure>;
};
export class ConnectionService extends Context.Service<ConnectionService, ConnectionServiceShape>()(
  'moonbase/Connection',
) {}

// A service's errors: its own, and over a daemon link the link's too (epic #273 D14).
export type ChatServiceError = ChatError | DaemonLinkError;
export type LocalHostServiceError = FolderError | ChatError | DaemonLinkError;
export type ProviderSetupServiceError = ProviderSetupError | DaemonLinkError;

export type ChatHandlers = {
  [K in ChatCommand]: (input: ChatInput<K>) => Effect.Effect<ChatOutput<K>, ChatServiceError>;
};
export type ChatServiceShape = ChatHandlers & {
  watch(input: { target: ChatTarget }): Stream.Stream<ChatSnapshot, ChatServiceError>;
  /** The chat list's first page, then again after each change to it. */
  watchChatList(input: { session: ChatSession }): Stream.Stream<ChatListUpdate, ChatServiceError>;
};
export class ChatService extends Context.Service<ChatService, ChatServiceShape>()(
  'moonbase/Chat',
) {}

export type ProviderSetupHandlers = {
  [K in ProviderCommand]: (
    input: ProviderInput<K>,
  ) => Effect.Effect<ProviderOutput<K>, ProviderSetupServiceError>;
};
/** Each privileged owner is a live document; renderer inputs never choose it. */
export class ProviderSetupService extends Context.Service<
  ProviderSetupService,
  {
    forOwner(ownerId: string): ProviderSetupHandlers;
    releaseOwner(ownerId: string): Effect.Effect<void, ProviderSetupServiceError>;
    /** The owner's setup state, then again after each change to it. */
    watch(ownerId: string): Stream.Stream<ProviderState, ProviderSetupServiceError>;
    /**
     * The validated sign-in URL of the owner's running flow, for a client to open itself. Unlike
     * `openProviderUrl`, it opens nothing.
     */
    getProviderUrl(
      ownerId: string,
      flowId: string,
    ): Effect.Effect<string, ProviderSetupServiceError>;
  }
>()('moonbase/ProviderSetup') {}

export type LocalHostHandlers = {
  [K in LocalHostCommand]: (
    input: LocalHostInput<K>,
  ) => Effect.Effect<LocalHostOutput<K>, LocalHostServiceError>;
};
/** Privileged: a local-mode host's folder approvals and control; only a token holder grants them. */
export class LocalHostService extends Context.Service<LocalHostService, LocalHostHandlers>()(
  'moonbase/LocalHost',
) {}
