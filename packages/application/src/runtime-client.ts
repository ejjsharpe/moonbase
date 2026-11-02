import type { ManagedRuntime } from 'effect';
import { runApplicationEffect, observeApplicationStream } from './effect-client.ts';
import type { ApplicationError, EditorClient } from '@moonbase/contracts/workspace';
import type { ConnectionClient } from '@moonbase/contracts/connection';
import type { ChatClient } from '@moonbase/contracts/chat';
import {
  chatCommand,
  chatWatch,
  connectionCommand,
  connectionWatch,
  workspaceCommand,
  workspaceWatch,
} from './handlers.ts';
import type {
  ChatService,
  ConnectionService,
  WorkspaceService,
} from '@moonbase/contracts/services';

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
