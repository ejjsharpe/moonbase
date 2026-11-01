import { Context, Effect, type Stream } from "effect";
import { ApplicationError, type CommandInput, type CommandOutput, type WorkspaceCommand, type WorkspaceEvent, type CheckoutTarget } from "./client.ts";

export type WorkspaceHandler<K extends WorkspaceCommand> = (input: CommandInput<K>) => Effect.Effect<CommandOutput<K>, ApplicationError>;
export type WorkspaceHandlers = { [K in WorkspaceCommand]: WorkspaceHandler<K> };
export type WorkspaceServiceShape = WorkspaceHandlers & {
  watch(input: { checkout: CheckoutTarget; paths: string[] }): Stream.Stream<WorkspaceEvent, ApplicationError>;
};
export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceShape>()("moonbase/Workspace") {}

/** Normalize release failures before Effect combines them with a command's cause. */
export const releaseResource = (release: () => void | Promise<void>): Effect.Effect<void> =>
  Effect.tryPromise({ try: async () => { await release(); }, catch: ApplicationError.fromUnknown }).pipe(Effect.orDie);
