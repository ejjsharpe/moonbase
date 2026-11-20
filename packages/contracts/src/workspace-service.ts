import { Context, type Effect, type Stream } from 'effect';
import type {
  CheckoutTarget,
  CommandInput,
  CommandOutput,
  WorkspaceCommand,
  WorkspaceEvent,
} from './workspace.ts';
import type { IpcError } from './ipc-errors.ts';
import type { WorkspaceError } from './workspace-errors.ts';
import type { RecoveryOutline } from './recovery.ts';

// The client-facing workspace port. Unlike `services`, it carries no endpoint or credential, so
// the renderer's editor may take it, over desktop IPC: so it may fail with IPC's errors too.

/** What a `WorkspaceService` fails with: the workspace's errors, or a window's IPC's. */
export type WorkspacePortError = WorkspaceError | IpcError;
export type WorkspaceHandler<K extends WorkspaceCommand> = (
  input: CommandInput<K>,
) => Effect.Effect<CommandOutput<K>, WorkspacePortError>;
export type WorkspaceHandlers = { [K in WorkspaceCommand]: WorkspaceHandler<K> };
/** The file commands and the recovery store's (each of its edits returns once committed). */
export type WorkspaceServiceShape = WorkspaceHandlers & {
  watch(input: {
    checkout: CheckoutTarget;
    paths: string[];
  }): Stream.Stream<WorkspaceEvent, WorkspacePortError>;
  /** A client's recovery without draft text, then again each time that changes. */
  watchRecovery(input: { clientId: string }): Stream.Stream<RecoveryOutline, WorkspacePortError>;
};
export class WorkspaceService extends Context.Service<WorkspaceService, WorkspaceServiceShape>()(
  'moonbase/Workspace',
) {}
