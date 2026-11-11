import type { ProviderCommand, ProviderInput } from '@moonbase/contracts/providers';
import { Effect, Stream } from 'effect';
import type { CommandInput, WorkspaceCommand } from '@moonbase/contracts/workspace';
import {
  ProviderSetupService,
  ChatService,
  ConnectionService,
  WorkspaceService,
  type ChatHandlers,
  type ConnectionHandlers,
  type WorkspaceHandlers,
} from '@moonbase/contracts/services';
import type { ConnectionCommand, ConnectionInput } from '@moonbase/contracts/connection';
import type { ChatCommand, ChatInput } from '@moonbase/contracts/chat';

/** UI, native actions and transport adapters all enter these handlers. */
export const workspaceCommand = <K extends WorkspaceCommand>(
  operation: K,
  input: CommandInput<K>,
) =>
  Effect.flatMap(WorkspaceService, (service) => {
    const handlers: WorkspaceHandlers = service;
    return handlers[operation](input);
  });

export const workspaceWatch = (input: Parameters<WorkspaceService['Service']['watch']>[0]) =>
  Stream.unwrap(Effect.map(WorkspaceService, (service) => service.watch(input)));

export const connectionCommand = <K extends ConnectionCommand>(
  operation: K,
  input: ConnectionInput<K>,
) =>
  Effect.flatMap(ConnectionService, (service) => {
    const handlers: ConnectionHandlers = service;
    return handlers[operation](input);
  });

export const connectionWatch = () =>
  Stream.unwrap(Effect.map(ConnectionService, (service) => service.watch()));

export const chatCommand = <K extends ChatCommand>(operation: K, input: ChatInput<K>) =>
  Effect.flatMap(ChatService, (service) => {
    const handlers: ChatHandlers = service;
    return handlers[operation](input);
  });
export const chatWatch = (input: Parameters<ChatService['Service']['watch']>[0]) =>
  Stream.unwrap(Effect.map(ChatService, (service) => service.watch(input)));
export const chatListWatch = (input: Parameters<ChatService['Service']['watchChatList']>[0]) =>
  Stream.unwrap(Effect.map(ChatService, (service) => service.watchChatList(input)));

export const providerCommand = <K extends ProviderCommand>(
  ownerId: string,
  operation: K,
  input: ProviderInput<K>,
) => Effect.flatMap(ProviderSetupService, (service) => service.forOwner(ownerId)[operation](input));
export const providerWatch = (ownerId: string) =>
  Stream.unwrap(Effect.map(ProviderSetupService, (service) => service.watch(ownerId)));
