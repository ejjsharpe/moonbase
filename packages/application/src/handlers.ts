import { Effect, Stream } from "effect";
import type { CommandInput, WorkspaceCommand } from "./client.ts";
import { WorkspaceService, type WorkspaceHandlers } from "./services.ts";

/** UI, native actions and transport adapters all enter these handlers. */
export const workspaceCommand = <K extends WorkspaceCommand>(operation: K, input: CommandInput<K>) =>
  Effect.flatMap(WorkspaceService, service => {
    const handlers: WorkspaceHandlers = service;
    return handlers[operation](input);
  });

export const workspaceWatch = (input: Parameters<WorkspaceService["Service"]["watch"]>[0]) =>
  Stream.unwrap(Effect.map(WorkspaceService, service => service.watch(input)));
