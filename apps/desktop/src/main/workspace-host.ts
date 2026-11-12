import { Effect, Stream } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import { chatHostCapabilities } from '@moonbase/contracts/host';
import type { VerifiedChatEndpoint, WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import type { HostCommand } from '@moonbase/contracts/workspace-host';
import {
  hostDeadlineMs,
  hostDeadlinesMs,
  hostInputSchemas,
} from '@moonbase/contracts/workspace-host-schema';
import type { LocalDaemonClient } from '../chat/daemon.ts';

const unreachable = () =>
  new ApplicationError({
    code: 'Unavailable',
    message: 'Moonbase could not reach its local daemon in time. Retry; drafts are kept.',
  });
const withoutFiles = () =>
  new ApplicationError({
    code: 'Unavailable',
    message:
      'The local daemon does not serve files yet. An older daemon is replaced once it has no work; Restart daemon replaces it now.',
  });

/**
 * The local daemon's file host as the editor's recovery store uses it, reached on demand: the
 * window opens, and the store works from its own drafts, without the daemon. Every call first
 * reaches the daemon through `local` (finding or starting it, at most as often as it allows)
 * within the call's own deadline, and fails `Unavailable`, never sent, when it can't; files then
 * show as unavailable until a retry.
 */
export function createDaemonWorkspaceHost(
  local: Pick<LocalDaemonClient, 'connect'>,
  deadlineMs: (operation: HostCommand | 'watch') => number = (operation) =>
    operation === 'watch' ? hostDeadlinesMs.read : hostDeadlineMs(operation),
): WorkspaceHostServiceShape {
  const reach = (operation: HostCommand | 'watch') =>
    local.connect().pipe(
      Effect.timeoutOrElse({
        duration: deadlineMs(operation),
        orElse: () => Effect.fail(unreachable()),
      }),
    );
  // A daemon without the workspace refuses it as `Incompatible`; to the editor that is unavailable.
  // Any other `Incompatible` failure, such as an invalid reply, is the editor's to see.
  const explain = (endpoint: VerifiedChatEndpoint) => (error: ApplicationError) =>
    error.code === 'Incompatible' &&
    !endpoint.health.capabilities.includes(chatHostCapabilities.workspace)
      ? withoutFiles()
      : error;
  const handlers = Object.fromEntries(
    (Object.keys(hostInputSchemas) as HostCommand[]).map((operation) => [
      operation,
      (input: never) =>
        Effect.flatMap(reach(operation), ({ workspace, endpoint }) =>
          Effect.mapError(
            (workspace[operation] as (input: never) => Effect.Effect<unknown, ApplicationError>)(
              input,
            ),
            explain(endpoint),
          ),
        ),
    ]),
  ) as unknown as Omit<WorkspaceHostServiceShape, 'watch'>;
  return {
    ...handlers,
    watch: (input) =>
      Stream.unwrap(
        Effect.map(reach('watch'), ({ workspace, endpoint }) =>
          workspace.watch(input).pipe(Stream.mapError(explain(endpoint))),
        ),
      ),
  };
}
