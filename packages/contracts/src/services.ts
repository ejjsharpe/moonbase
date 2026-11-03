import type { ProviderCommand, ProviderInput, ProviderOutput } from './providers.ts';
import { Context, type Effect, type Stream } from 'effect';
import {
  type ApplicationError,
  type CommandInput,
  type CommandOutput,
  type WorkspaceCommand,
  type WorkspaceEvent,
  type CheckoutTarget,
} from './workspace.ts';
import type {
  ConnectionCommand,
  ConnectionInput,
  ConnectionOutput,
  ConnectionSnapshot,
} from './connection.ts';
import type { ChatHostTarget, ChatHostHealth } from './host.ts';
import type { ChatCommand, ChatInput, ChatOutput, ChatSnapshot, ChatTarget } from './chat.ts';

export type WorkspaceHandler<K extends WorkspaceCommand> = (
  input: CommandInput<K>,
) => Effect.Effect<CommandOutput<K>, ApplicationError>;
export type WorkspaceHandlers = { [K in WorkspaceCommand]: WorkspaceHandler<K> };
export type WorkspaceServiceShape = WorkspaceHandlers & {
  watch(input: {
    checkout: CheckoutTarget;
    paths: string[];
  }): Stream.Stream<WorkspaceEvent, ApplicationError>;
};
export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceShape>()(
  'moonbase/Workspace',
) {}

export type ConnectionHandlers = {
  [K in ConnectionCommand]: (
    input: ConnectionInput<K>,
  ) => Effect.Effect<ConnectionOutput<K>, ApplicationError>;
};
/** Privileged configuration; never expose this shape through a renderer bridge. */
export type ChatHostEndpoint = { origin: string; token: string; expected: ChatHostTarget };
export type VerifiedChatEndpoint = ChatHostEndpoint & {
  connectionId: string;
  health: ChatHostHealth;
};
export type ConnectionServiceShape = ConnectionHandlers & {
  watch(): Stream.Stream<ConnectionSnapshot, ApplicationError>;
  /** Privileged consumers only; lookup never connects or changes the expected authority. */
  endpoint(input: { host: ChatHostTarget }): Effect.Effect<VerifiedChatEndpoint, ApplicationError>;
};
export class ConnectionService extends Context.Service<ConnectionService, ConnectionServiceShape>()(
  'moonbase/Connection',
) {}

export type ChatHandlers = {
  [K in ChatCommand]: (input: ChatInput<K>) => Effect.Effect<ChatOutput<K>, ApplicationError>;
};
export type ChatServiceShape = ChatHandlers & {
  watch(input: { target: ChatTarget }): Stream.Stream<ChatSnapshot, ApplicationError>;
};
export class ChatService extends Context.Service<ChatService, ChatServiceShape>()(
  'moonbase/Chat',
) {}

export type ProviderSetupHandlers = {
  [K in ProviderCommand]: (
    input: ProviderInput<K>,
  ) => Effect.Effect<ProviderOutput<K>, ApplicationError>;
};
/** Each privileged owner is a live document; renderer inputs never choose it. */
export class ProviderSetupService extends Context.Service<
  ProviderSetupService,
  {
    forOwner(ownerId: string): ProviderSetupHandlers;
    releaseOwner(ownerId: string): Effect.Effect<void, ApplicationError>;
  }
>()('moonbase/ProviderSetup') {}
