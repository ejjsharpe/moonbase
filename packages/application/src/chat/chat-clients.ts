import type { ProviderSetupClient } from '@moonbase/contracts/providers';
import type { ManagedRuntime } from 'effect';
import { runApplicationEffect, observeApplicationStream } from './chat-promises.ts';
import type { ApplicationError } from '@moonbase/contracts/errors';
import type { ConnectionClient } from '@moonbase/contracts/connection';
import type { ChatClient } from '@moonbase/contracts/chat';
import {
  providerCommand,
  chatCommand,
  chatWatch,
  chatListWatch,
  connectionCommand,
  connectionWatch,
  providerWatch,
} from './chat-handlers.ts';
// Legacy (epic #273 D16): the chat, connection and provider setup Promise clients, bound to a
// runtime, until CL-22 #295 moves chat to services and atoms.
import type {
  ProviderSetupService,
  ChatService,
  ConnectionService,
} from '@moonbase/contracts/services';

export function makeConnectionClient(
  runtime: ManagedRuntime.ManagedRuntime<ConnectionService, ApplicationError>,
): ConnectionClient {
  return {
    command: (operation, input, options) =>
      runApplicationEffect(runtime, connectionCommand(operation, input), options),
    watch: (receive, onError) =>
      observeApplicationStream(runtime, connectionWatch(), receive, onError),
  };
}
export function makeChatClient(
  runtime: ManagedRuntime.ManagedRuntime<ChatService, unknown>,
): ChatClient {
  return {
    command: (operation, input, options) =>
      runApplicationEffect(runtime, chatCommand(operation, input), options),
    watch: (input, receive, onError) =>
      observeApplicationStream(runtime, chatWatch(input), receive, onError),
    watchChatList: (input, receive, onError) =>
      observeApplicationStream(runtime, chatListWatch(input), receive, onError),
  };
}

export function makeProviderSetupClient(
  runtime: ManagedRuntime.ManagedRuntime<ProviderSetupService, unknown>,
  ownerId: string,
): ProviderSetupClient {
  return {
    command: (operation, input, options) =>
      runApplicationEffect(runtime, providerCommand(ownerId, operation, input), options),
    watch: (receive, onError) =>
      observeApplicationStream(runtime, providerWatch(ownerId), receive, onError),
  };
}
