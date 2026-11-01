import { Context, Effect, type Stream } from 'effect';
import { safeApplicationFailure } from './failure.ts';
import {
  type ApplicationError,
  type CommandInput,
  type CommandOutput,
  type WorkspaceCommand,
  type WorkspaceEvent,
  type CheckoutTarget,
} from './client.ts';
import type {
  ConnectionCommand,
  ConnectionInput,
  ConnectionOutput,
  ConnectionSnapshot,
} from './connection-client.ts';
import type { ChatHostTarget, ChatHostHealth } from './host-client.ts';
import type { ChatHostEndpoint } from './host-health.ts';
import type {
  ChatCommand,
  ChatInput,
  ChatOutput,
  ChatSnapshot,
  ChatTarget,
} from './chat-client.ts';

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

/** Normalize release failures before Effect combines them with a command's cause. */
export const releaseResource = (release: () => void | Promise<void>): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      await release();
    },
    catch: (error) => safeApplicationFailure(error, 'Application resource cleanup failed'),
  }).pipe(Effect.orDie);
