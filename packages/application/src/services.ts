import { Context, Effect, type Stream } from "effect";
import { ApplicationError, type CommandInput, type CommandOutput, type WorkspaceCommand, type WorkspaceEvent, type CheckoutTarget } from "./client.ts";
import type { ConnectionCommand, ConnectionInput, ConnectionOutput, ConnectionSnapshot } from "./connection-client.ts";
import type { ChatHostTarget, ChatHostHealth } from "./host-client.ts";
import type { ChatHostEndpoint } from "./host-health.ts";

export type WorkspaceHandler<K extends WorkspaceCommand> = (input: CommandInput<K>) => Effect.Effect<CommandOutput<K>, ApplicationError>;
export type WorkspaceHandlers = { [K in WorkspaceCommand]: WorkspaceHandler<K> };
export type WorkspaceServiceShape = WorkspaceHandlers & {
  watch(input: { checkout: CheckoutTarget; paths: string[] }): Stream.Stream<WorkspaceEvent, ApplicationError>;
};
export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceShape>()("moonbase/Workspace") {}

export type ConnectionHandlers = { [K in ConnectionCommand]: (input: ConnectionInput<K>) => Effect.Effect<ConnectionOutput<K>, ApplicationError> };
export type VerifiedChatEndpoint = ChatHostEndpoint & { connectionId: string; health: ChatHostHealth };
export type ConnectionServiceShape = ConnectionHandlers & {
  watch(): Stream.Stream<ConnectionSnapshot, ApplicationError>;
  /** Privileged consumers only; lookup never connects or changes the expected authority. */
  endpoint(input: { host: ChatHostTarget }): Effect.Effect<VerifiedChatEndpoint, ApplicationError>;
};
export class ConnectionService extends Context.Service<ConnectionService, ConnectionServiceShape>()("moonbase/Connection") {}

/** Normalize release failures before Effect combines them with a command's cause. */
export const releaseResource = (release: () => void | Promise<void>): Effect.Effect<void> =>
  Effect.tryPromise({ try: async () => { await release(); }, catch: ApplicationError.fromUnknown }).pipe(Effect.orDie);
