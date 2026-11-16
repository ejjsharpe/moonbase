import { Effect, Stream, type ManagedRuntime } from 'effect';
import {
  observeApplicationStream,
  runApplicationEffect,
} from '@moonbase/application/chat/promises';
import { WorkspaceService } from '@moonbase/contracts/services';
import { toWireError } from '@moonbase/contracts/workspace-errors';
import type { ApplicationError } from '@moonbase/contracts/errors';
import type { CommandOptions, ObservationClose } from '@moonbase/contracts/common';
import type { RecoveryOutline } from '@moonbase/contracts/recovery';
import type {
  CheckoutTarget,
  CommandInput,
  CommandOutput,
  WorkspaceCommand,
  WorkspaceEvent,
} from '@moonbase/contracts/workspace';

/** The workspace as a test drives it: each command and watch, failing as the wire does. */
export type WorkspaceClient = {
  command<K extends WorkspaceCommand>(
    operation: K,
    input: CommandInput<K>,
    options?: CommandOptions,
  ): Promise<CommandOutput<K>>;
  watch(
    input: { checkout: CheckoutTarget; paths: string[] },
    receive: (event: WorkspaceEvent) => void,
    onError: (error: ApplicationError) => void,
  ): ObservationClose;
  watchRecovery(
    input: { clientId: string },
    receive: (outline: RecoveryOutline) => void,
    onError: (error: ApplicationError) => void,
  ): ObservationClose;
};

/** Binds the runtime's `WorkspaceService` for a test, with the legacy wire errors. */
export function makeWorkspaceClient(
  runtime: ManagedRuntime.ManagedRuntime<WorkspaceService, unknown>,
): WorkspaceClient {
  const service = <A>(
    f: (service: WorkspaceService['Service']) => Stream.Stream<A, ApplicationError>,
  ) => Stream.unwrap(Effect.flatMap(WorkspaceService, (workspace) => Effect.succeed(f(workspace))));
  return {
    command: (operation, input, options) =>
      runApplicationEffect(
        runtime,
        Effect.flatMap(WorkspaceService, (workspace) =>
          (
            workspace[operation] as (
              input: CommandInput<typeof operation>,
            ) => Effect.Effect<CommandOutput<typeof operation>, Parameters<typeof toWireError>[0]>
          )(input).pipe(Effect.mapError(toWireError)),
        ),
        options,
      ),
    watch: (input, receive, onError) =>
      observeApplicationStream(
        runtime,
        service((workspace) => workspace.watch(input).pipe(Stream.mapError(toWireError))),
        receive,
        onError,
      ),
    watchRecovery: (input, receive, onError) =>
      observeApplicationStream(
        runtime,
        service((workspace) => workspace.watchRecovery(input).pipe(Stream.mapError(toWireError))),
        receive,
        onError,
      ),
  };
}
