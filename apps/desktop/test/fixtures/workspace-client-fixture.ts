import { Effect, Stream, type ManagedRuntime } from 'effect';
import {
  observeApplicationStream,
  runApplicationEffect,
} from '@moonbase/application/chat/promises';
import type { ApplicationError } from '@moonbase/contracts/errors';
import type { CommandOptions, ObservationClose } from '@moonbase/contracts/common';
import type { RecoveryOutline } from '@moonbase/contracts/recovery';
import { WorkspaceService, type WorkspaceServiceShape } from '@moonbase/contracts/services';
import { toWireError, type WorkspaceError } from '@moonbase/contracts/workspace-errors';
import type {
  CheckoutTarget,
  CommandInput,
  CommandOutput,
  WorkspaceCommand,
  WorkspaceEvent,
} from '@moonbase/contracts/workspace';

/** A workspace as a test writes it: Promise commands and callback watches. */
export type FakeWorkspaceClient = {
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

/** A runtime's `WorkspaceService` as a test drives it, failing with the legacy wire errors. */
export function makeWorkspaceClient(
  runtime: ManagedRuntime.ManagedRuntime<WorkspaceService, unknown>,
): FakeWorkspaceClient {
  const service = <A>(f: (workspace: WorkspaceServiceShape) => Stream.Stream<A, WorkspaceError>) =>
    Stream.unwrap(
      Effect.flatMap(WorkspaceService, (workspace) =>
        Effect.succeed(f(workspace).pipe(Stream.mapError(toWireError))),
      ),
    );
  return {
    command: (operation, input, options) =>
      runApplicationEffect(
        runtime,
        Effect.flatMap(WorkspaceService, (workspace) =>
          (
            workspace[operation] as (
              input: CommandInput<typeof operation>,
            ) => Effect.Effect<CommandOutput<typeof operation>, WorkspaceError>
          )(input).pipe(Effect.mapError(toWireError)),
        ),
        options,
      ),
    watch: (input, receive, onError) =>
      observeApplicationStream(
        runtime,
        service((workspace) => workspace.watch(input)),
        receive,
        onError,
      ),
    watchRecovery: (input, receive, onError) =>
      observeApplicationStream(
        runtime,
        service((workspace) => workspace.watchRecovery(input)),
        receive,
        onError,
      ),
  };
}
