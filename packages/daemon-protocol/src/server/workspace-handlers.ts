import { Effect, Stream } from 'effect';
import { Rpc } from 'effect/rpc';
import { UncertainError, UnauthorizedError } from '@moonbase/contracts/errors';
import type { ChatHostTarget } from '@moonbase/contracts/host';
import { HostUnavailableError } from '@moonbase/contracts/host-errors';
import { workspaceRpcLimits } from '@moonbase/contracts/rpc-upgrade';
import type { WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { HostCommand, WorkspaceWatchValue } from '@moonbase/contracts/workspace-host';
import { InvalidRequestError } from '@moonbase/contracts/workspace-host-errors';
import { hostInputCheckout, hostInputSchemas } from '@moonbase/contracts/workspace-host-schema';
import { isHostMutation, workspaceErrorSchemaOf } from '@moonbase/contracts/workspace-rpc';
import { forHost, toWire } from './rpc-handlers.ts';

type WatchState = { ready: boolean; revision: number };
/** The file host a daemon serves on the workspace's socket, and the host it serves for. */
export type WorkspaceRpcServices = { host: ChatHostTarget; workspace: WorkspaceHostServiceShape };

/**
 * Refuses a request for another host, or one whose input names a checkout (or chat) of another
 * host, before its handler runs.
 */
const forOwnHost = (
  services: WorkspaceRpcServices,
  host: ChatHostTarget,
  operation: string,
  input: unknown,
) =>
  Effect.andThen(
    forHost(services, host, operation),
    Effect.suspend(() =>
      hostInputCheckout(input)?.hostId === undefined ||
      hostInputCheckout(input)!.hostId === services.host.hostId
        ? Effect.void
        : Effect.fail(new UnauthorizedError({ operation })),
    ),
  );

/**
 * A reply as it is sent: at most `workspaceRpcLimits.payloadBytes` of JSON. A larger one is
 * refused before any of it is sent, as `Uncertain` for a mutation, which applied.
 */
const withinReplyBound = (operation: HostCommand, output: unknown) =>
  Effect.suspend(() => {
    const json = JSON.stringify(output);
    if (json === undefined || Buffer.byteLength(json) <= workspaceRpcLimits.payloadBytes)
      return Effect.succeed(output);
    return Effect.fail(
      isHostMutation(operation)
        ? new UncertainError({ operation })
        : new InvalidRequestError({ problem: 'reply-too-large' }),
    );
  });

/**
 * Handlers for every file host operation and the watch. Each checks the request's host and the
 * checkout it names. A read stops when its caller cancels or its connection drops; a mutation
 * runs to completion once it started (the host journals it by request ID, so a repeat replays it).
 */
export function makeWorkspaceHandlers(services: WorkspaceRpcServices) {
  const { workspace } = services;
  const handlers: Record<string, unknown> = {
    /**
     * A checkout's watch: each change the host reports raises `revision`; `ready` once it watches.
     * One the host ends is `HostUnavailableError` (`watch-ended`), so its client watches again.
     */
    watchWorkspace: ({ host, checkout }: { host: ChatHostTarget; checkout: CheckoutTarget }) =>
      Stream.unwrap(
        Effect.as(
          forOwnHost(services, host, 'watchWorkspace', { checkout }),
          Stream.concat(
            workspace.watch({ checkout, paths: [''] }).pipe(
              Stream.mapAccum(
                (): WatchState => ({ ready: false, revision: 0 }),
                (state, event): readonly [WatchState, readonly WorkspaceWatchValue[]] => {
                  const next = {
                    ready: state.ready || event.ready === true,
                    revision: state.revision + 1,
                  };
                  return [
                    next,
                    [{ ...next, ...(event.error === undefined ? {} : { failed: true as const }) }],
                  ];
                },
              ),
            ),
            Stream.fail(new HostUnavailableError({ reason: 'watch-ended' })),
          ),
        ),
      ).pipe(Stream.mapError(toWire(workspaceErrorSchemaOf('watchWorkspace')))),
  };
  for (const operation of Object.keys(hostInputSchemas) as HostCommand[]) {
    handlers[operation] = ({ host, input }: { host: ChatHostTarget; input: never }) => {
      const run = Effect.andThen(
        forOwnHost(services, host, operation, input),
        Effect.suspend(() =>
          (workspace[operation] as (input: never) => Effect.Effect<unknown, unknown>)(input),
        ),
      ).pipe(
        Effect.flatMap((output) => withinReplyBound(operation, output)),
        Effect.mapError(toWire(workspaceErrorSchemaOf(operation))),
      );
      return isHostMutation(operation) ? Rpc.uninterruptible(run) : run;
    };
  }
  return handlers as never;
}
