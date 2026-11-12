import { Cause, Effect, Exit, Fiber, Stream } from 'effect';
import { followChanges } from '@moonbase/effect/changes';
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
 * is the host's own, plus the operation feed's sequence: each change the host reports bumps
 * `revision` and rereads `operations`, one read at a time. A watch that fails ends the
 * subscription with its code; one that reports an error asks its client to watch again.
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
        revision = 0,
        error: 'Unavailable' | undefined,
        stopped = false;
      let notify = () => {};
      // The watch ends the subscription when it fails; the first event says it is ready.
      const watching = Effect.runFork(
        Stream.runForEach(host.watch({ checkout, paths: [''] }), (event) =>
          Effect.sync(() => {
            ready = ready || event.ready === true;
            error = event.error === undefined ? undefined : 'Unavailable';
            revision++;
            notify();
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.sync(() => onError(failure(cause))),
          ),
        ),
      );
      const stopFollowing = followChanges(
        (listener) => {
          notify = listener;
          return () => {
            notify = () => {};
          };
        },
        async () => {
          const feed = await Effect.runPromise(host.listOperations({ checkout, after: null }));
          return {
            ready,
            revision,
            operations: feed.through,
            ...(error ? { error } : {}),
          };
        },
        (value) => !stopped && receive(value),
        (reason) => !stopped && onError(reason),
      );
      return async () => {
        stopped = true;
        stopFollowing();
        await Effect.runPromise(Fiber.interrupt(watching));
      };
    },
  };
}
