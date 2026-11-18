import { Cause, Effect, Exit, Stream, type ManagedRuntime } from 'effect';
import { CancelledError } from '@moonbase/contracts/errors';
import { WorkspaceService } from '@moonbase/contracts/services';
import type { RecoveryOutline } from '@moonbase/contracts/recovery';
import type {
  CheckoutTarget,
  CommandInput,
  CommandOutput,
  WorkspaceCommand,
  WorkspaceEvent,
} from '@moonbase/contracts/workspace';

/** Closes a watch and joins its finalizers, rejecting with what it failed with. */
export type WatchClose = () => Promise<void>;

/** The workspace as a test drives it: each command and watch, failing with its tagged errors. */
export type WorkspaceClient = {
  command<K extends WorkspaceCommand>(
    operation: K,
    input: CommandInput<K>,
    options?: { signal?: AbortSignal },
  ): Promise<CommandOutput<K>>;
  watch(
    input: { checkout: CheckoutTarget; paths: string[] },
    receive: (event: WorkspaceEvent) => void,
    onError: (error: unknown) => void,
  ): WatchClose;
  watchRecovery(
    input: { clientId: string },
    receive: (outline: RecoveryOutline) => void,
    onError: (error: unknown) => void,
  ): WatchClose;
};

const cancelled = () => new CancelledError({ operation: 'Command' });

/** What a failed exit ends with: its first failure, else its first defect, else cancelled. */
function failureOf(cause: Cause.Cause<unknown>): unknown {
  const failure = cause.reasons.find(Cause.isFailReason);
  if (failure) return failure.error;
  const defect = cause.reasons.find(Cause.isDieReason);
  return defect ? defect.defect : cancelled();
}

/** Binds the runtime's `WorkspaceService` for a test. */
export function makeWorkspaceClient(
  runtime: ManagedRuntime.ManagedRuntime<WorkspaceService, unknown>,
): WorkspaceClient {
  const observe = <A>(
    stream: Stream.Stream<A, unknown, WorkspaceService>,
    receive: (value: A) => void,
    onError: (error: unknown) => void,
  ): WatchClose => {
    const abort = new AbortController();
    let closing = false;
    // The outcome is kept as a value, so a failure delivered while active is never unhandled.
    const completion = runtime
      .runPromiseExit(
        Stream.runForEach(stream, (value) =>
          Effect.sync(() => {
            if (!closing) receive(value);
          }),
        ),
        { signal: abort.signal },
      )
      .then((exit) =>
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
          ? { error: failureOf(exit.cause) }
          : undefined,
      )
      .then((failed) => {
        if (failed && !closing) onError(failed.error);
        return failed;
      });
    let closed: Promise<void> | undefined;
    return () => {
      if (!closed) {
        closing = true;
        abort.abort();
        closed = completion.then((failed) => {
          if (failed) throw failed.error;
        });
      }
      return closed;
    };
  };
  return {
    command: async (operation, input, options) => {
      if (options?.signal?.aborted) throw cancelled();
      const exit = await runtime.runPromiseExit(
        Effect.flatMap(WorkspaceService, (workspace) =>
          (workspace[operation] as (input: unknown) => Effect.Effect<never, unknown>)(input),
        ),
        options,
      );
      if (Exit.isFailure(exit)) throw failureOf(exit.cause);
      return exit.value;
    },
    watch: (input, receive, onError) =>
      observe(
        Stream.unwrap(Effect.map(WorkspaceService, (workspace) => workspace.watch(input))),
        receive,
        onError,
      ),
    watchRecovery: (input, receive, onError) =>
      observe(
        Stream.unwrap(Effect.map(WorkspaceService, (workspace) => workspace.watchRecovery(input))),
        receive,
        onError,
      ),
  };
}
