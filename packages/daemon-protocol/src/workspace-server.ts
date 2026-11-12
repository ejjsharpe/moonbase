import { Cause, Effect, Exit, Fiber, Stream } from 'effect';
import type { WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import type { HostCommand, WorkspaceHostClient } from '@moonbase/contracts/workspace-host';
import { ApplicationError } from '@moonbase/contracts/workspace';

const cancelled = () =>
  new ApplicationError({ code: 'Cancelled', message: 'The request was cancelled.' });
const failure = (cause: Cause.Cause<unknown>) => {
  const error = cause.reasons.find(Cause.isFailReason)?.error;
  return ApplicationError.is(error)
    ? error
    : new ApplicationError({ code: 'Unavailable', message: 'Workspace operation failed.' });
};

/**
 * Binds a file host's operations and watch to what the socket server calls. A checkout's watch
 * is the host's own: each change it reports bumps `revision`. A watch that fails ends the
 * subscription with its code, and one that finishes with `Unavailable`, so its client watches
 * again; one that reports an error asks its client to watch again.
 */
export function makeWorkspaceClient(host: WorkspaceHostServiceShape): WorkspaceHostClient {
  return {
    command: async (operation: HostCommand, input, options) => {
      const handler = host[operation] as (input: unknown) => Effect.Effect<unknown, unknown>;
      const exit = await Effect.runPromiseExit(handler(input), { signal: options?.signal });
      if (Exit.isSuccess(exit)) return exit.value as never;
      throw options?.signal?.aborted && Cause.hasInterruptsOnly(exit.cause)
        ? cancelled()
        : failure(exit.cause);
    },
    watch({ checkout }, receive, onError) {
      let ready = false,
        revision = 0;
      const watching = Effect.runFork(
        Stream.runForEach(host.watch({ checkout, paths: [''] }), (event) =>
          Effect.sync(() => {
            ready ||= event.ready === true;
            receive({
              ready,
              revision: ++revision,
              ...(event.error === undefined ? {} : { error: 'Unavailable' as const }),
            });
          }),
        ).pipe(
          Effect.andThen(
            Effect.fail(
              new ApplicationError({ code: 'Unavailable', message: 'The workspace watch ended.' }),
            ),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.sync(() => onError(failure(cause))),
          ),
        ),
      );
      return async () => {
        await Effect.runPromise(Fiber.interrupt(watching));
      };
    },
  };
}
