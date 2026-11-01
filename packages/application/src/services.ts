import { Context, type Effect, type Stream } from "effect";
import type { ApplicationError, CommandInput, CommandOutput, WorkspaceCommand, WorkspaceEvent, CheckoutTarget } from "./client.ts";

export type WorkspaceHandler<K extends WorkspaceCommand> = (input: CommandInput<K>) => Effect.Effect<CommandOutput<K>, ApplicationError>;
export type WorkspaceHandlers = { [K in WorkspaceCommand]: WorkspaceHandler<K> };
export type WorkspaceServiceShape = WorkspaceHandlers & {
  watch(input: { checkout: CheckoutTarget; paths: string[] }): Stream.Stream<WorkspaceEvent, ApplicationError>;
};
export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceShape>()("moonbase/Workspace") {}
