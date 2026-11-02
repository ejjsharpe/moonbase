import type { ManagedRuntime } from 'effect';
import { runApplicationEffect, observeApplicationStream } from './effect-client.ts';
import type { ApplicationError, EditorClient } from './client.ts';
import type { ConnectionClient } from './connection-client.ts';
import type { ChatClient } from './chat-client.ts';
import {
  chatCommand,
  chatWatch,
  connectionCommand,
  connectionWatch,
  workspaceCommand,
  workspaceWatch,
} from './handlers.ts';
import type { ChatService, ConnectionService, WorkspaceService } from './services.ts';

/** Accept the process root's runtime; never acquire a second service graph here. */
export function makeEditorClient(
  runtime: ManagedRuntime.ManagedRuntime<WorkspaceService, ApplicationError>,
): EditorClient {
  return {
    command: (operation, input, options) =>
      runApplicationEffect(runtime, workspaceCommand(operation, input), options),
    watch: (input, receive, onError) =>
      observeApplicationStream(runtime, workspaceWatch(input), receive, onError),
  };
}
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
  runtime: ManagedRuntime.ManagedRuntime<ChatService, ApplicationError>,
): ChatClient {
  return {
    command: (operation, input, options) =>
      runApplicationEffect(runtime, chatCommand(operation, input), options),
    watch: (input, receive, onError) =>
      observeApplicationStream(runtime, chatWatch(input), receive, onError),
  };
}
