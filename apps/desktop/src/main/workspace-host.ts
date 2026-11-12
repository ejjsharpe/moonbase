import { Effect, Stream } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import type { HostCommand } from '@moonbase/contracts/workspace-host';
import { hostInputSchemas } from '@moonbase/contracts/workspace-host-schema';

/** How long a failed attempt to reach the daemon is answered again without trying anew. */
const retryAfterMs = 2000;
const incompatible = new ApplicationError({
  code: 'Unavailable',
  message:
    'The local daemon does not serve files yet. An older daemon is replaced once it has no work; Restart daemon replaces it now.',
});

/**
 * The local daemon's file host as the editor's recovery store uses it, reached on demand: the
 * window opens, and the store works from its own drafts, without the daemon. Every call waits for
 * `resolve` (which finds or starts the daemon and returns its client) and fails `Unavailable` when
 * the daemon can't be reached, so files show as unavailable until a retry. A failed attempt is
 * answered again for a moment rather than started anew by every call of the editor.
 */
export function createDaemonWorkspaceHost(
  resolve: () => Promise<WorkspaceHostServiceShape>,
  now: () => number = Date.now,
): WorkspaceHostServiceShape {
  let failure: { error: ApplicationError; at: number } | undefined;
  const reach = Effect.tryPromise({
    try: async () => {
      if (failure && now() - failure.at < retryAfterMs) throw failure.error;
      try {
        const host = await resolve();
        failure = undefined;
        return host;
      } catch (error) {
        failure = {
          error: ApplicationError.is(error)
            ? error
            : new ApplicationError({
                code: 'Unavailable',
                message: 'Moonbase could not reach its local daemon.',
              }),
          at: now(),
        };
        throw failure.error;
      }
    },
    catch: (error) => error as ApplicationError,
  });
  // A daemon without the workspace answers `Incompatible`; to the editor that is unavailable.
  const answered = <A>(effect: Effect.Effect<A, ApplicationError>) =>
    Effect.mapError(effect, (error) => (error.code === 'Incompatible' ? incompatible : error));
  const handlers = Object.fromEntries(
    (Object.keys(hostInputSchemas) as HostCommand[]).map((operation) => [
      operation,
      (input: never) =>
        answered(
          Effect.flatMap(reach, (host) =>
            (host[operation] as (input: never) => Effect.Effect<unknown, ApplicationError>)(input),
          ),
        ),
    ]),
  ) as unknown as Omit<WorkspaceHostServiceShape, 'watch'>;
  return {
    ...handlers,
    watch: (input) =>
      Stream.unwrap(Effect.map(reach, (host) => host.watch(input))).pipe(
        Stream.mapError((error) => (error.code === 'Incompatible' ? incompatible : error)),
      ),
  };
}
