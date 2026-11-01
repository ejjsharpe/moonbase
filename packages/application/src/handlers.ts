import { Effect, Stream } from "effect";
import type { CommandInput, WorkspaceCommand } from "./client.ts";
import { ConnectionService, WorkspaceService, type ConnectionHandlers, type WorkspaceHandlers } from "./services.ts";
import type { ConnectionCommand, ConnectionInput } from "./connection-client.ts";

/** UI, native actions and transport adapters all enter these handlers. */
export const workspaceCommand = <K extends WorkspaceCommand>(operation: K, input: CommandInput<K>) =>
  Effect.flatMap(WorkspaceService, service => {
    const handlers: WorkspaceHandlers = service;
    return handlers[operation](input);
  });

export const workspaceWatch = (input: Parameters<WorkspaceService["Service"]["watch"]>[0]) =>
  Stream.unwrap(Effect.map(WorkspaceService, service => service.watch(input)));

export const connectionCommand = <K extends ConnectionCommand>(operation: K, input: ConnectionInput<K>) =>
  Effect.flatMap(ConnectionService, service => {
    const handlers: ConnectionHandlers = service;
    return handlers[operation](input);
  });

export const connectionWatch = () => Stream.unwrap(Effect.map(ConnectionService, service => service.watch()));
