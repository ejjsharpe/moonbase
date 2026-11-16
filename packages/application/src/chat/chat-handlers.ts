import type { ProviderCommand, ProviderInput } from '@moonbase/contracts/providers';
import { Effect, Stream } from 'effect';
import {
  ProviderSetupService,
  ChatService,
  ConnectionService,
  type ChatHandlers,
  type ConnectionHandlers,
} from '@moonbase/contracts/services';
import type { ConnectionCommand, ConnectionInput } from '@moonbase/contracts/connection';
import { toConnectionApplicationError } from '@moonbase/contracts/connection-errors';
import type { ChatCommand, ChatInput } from '@moonbase/contracts/chat';
import { toChatApplicationError } from '@moonbase/contracts/chat-legacy-errors';

// Connection failures become the legacy `ApplicationError` here, the one place they reach
// clients and renderers, with the codes they have always had.
export const connectionCommand = <K extends ConnectionCommand>(
  operation: K,
  input: ConnectionInput<K>,
) =>
  Effect.flatMap(ConnectionService, (service) => {
    const handlers: ConnectionHandlers = service;
    return handlers[operation](input);
  }).pipe(Effect.mapError(toConnectionApplicationError));

export const connectionWatch = () =>
  Stream.unwrap(Effect.map(ConnectionService, (service) => service.watch())).pipe(
    Stream.mapError(toConnectionApplicationError),
  );

// Chat and provider setup errors become the legacy `ApplicationError` here, with the codes they
// have always had, until the chat UI reads tags (CL-22).
export const chatCommand = <K extends ChatCommand>(operation: K, input: ChatInput<K>) =>
  Effect.flatMap(ChatService, (service) => {
    const handlers: ChatHandlers = service;
    return handlers[operation](input);
  }).pipe(Effect.mapError(toChatApplicationError));
export const chatWatch = (input: Parameters<ChatService['Service']['watch']>[0]) =>
  Stream.unwrap(Effect.map(ChatService, (service) => service.watch(input))).pipe(
    Stream.mapError(toChatApplicationError),
  );
export const chatListWatch = (input: Parameters<ChatService['Service']['watchChatList']>[0]) =>
  Stream.unwrap(Effect.map(ChatService, (service) => service.watchChatList(input))).pipe(
    Stream.mapError(toChatApplicationError),
  );

export const providerCommand = <K extends ProviderCommand>(
  ownerId: string,
  operation: K,
  input: ProviderInput<K>,
) =>
  Effect.flatMap(ProviderSetupService, (service) =>
    service.forOwner(ownerId)[operation](input),
  ).pipe(Effect.mapError(toChatApplicationError));
export const providerWatch = (ownerId: string) =>
  Stream.unwrap(Effect.map(ProviderSetupService, (service) => service.watch(ownerId))).pipe(
    Stream.mapError(toChatApplicationError),
  );
