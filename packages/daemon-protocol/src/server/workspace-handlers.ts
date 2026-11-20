import { Effect, Stream } from 'effect';
import { Rpc, type RpcGroup } from 'effect/rpc';
import { UncertainError, UnauthorizedError } from '@moonbase/contracts/errors';
import type { ChatHostTarget } from '@moonbase/contracts/host';
import { HostUnavailableError } from '@moonbase/contracts/host-errors';
import { workspaceRpcLimits } from '@moonbase/contracts/rpc-upgrade';
import { WorkspaceHostService, type WorkspaceHostHandlers } from '@moonbase/contracts/services';
import type {
  HostCommand,
  HostInput,
  WorkspaceWatchValue,
} from '@moonbase/contracts/workspace-host';
import { InvalidRequestError } from '@moonbase/contracts/workspace-host-errors';
import { hostInputCheckout } from '@moonbase/contracts/workspace-host-schema';
import { isHostMutation, WorkspaceRpcs } from '@moonbase/contracts/workspace-rpc';
import { forHost, toWire } from './rpc-handlers.ts';

type WatchState = { ready: boolean; revision: number };

/**
 * Refuses a request for another host, or one whose input names a checkout (or chat) of another
 * host, before its handler runs.
 */
const forOwnHost = (
  served: { host: ChatHostTarget },
  host: ChatHostTarget,
  operation: string,
  input: unknown,
) =>
  Effect.andThen(
    forHost(served, host, operation),
    Effect.suspend(() =>
      hostInputCheckout(input)?.hostId === undefined ||
      hostInputCheckout(input)!.hostId === served.host.hostId
        ? Effect.void
        : Effect.fail(new UnauthorizedError({ operation })),
    ),
  );

/**
 * A reply as it is sent: at most `workspaceRpcLimits.payloadBytes` of JSON. A larger one is
 * refused before any of it is sent, as `Uncertain` for a mutation, which applied.
 */
const withinReplyBound = <A>(operation: HostCommand, output: A) =>
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

type WorkspaceRpc = RpcGroup.Rpcs<typeof WorkspaceRpcs>;

/**
 * Handlers for every file host operation and the watch, over the file host. Each checks the
 * request's host and the checkout it names. A read stops when its caller cancels or its connection
 * drops; a mutation runs to completion once it started (the host journals it by request ID, so a
 * repeat replays it).
 */
export const makeWorkspaceHandlers = (served: { host: ChatHostTarget }) =>
  Effect.gen(function* () {
    const workspace = yield* WorkspaceHostService;
    const commands: WorkspaceHostHandlers = workspace;
    const command =
      <K extends HostCommand>(operation: K) =>
      ({ host, input }: { host: ChatHostTarget; input: HostInput<K> }) => {
        const run = Effect.andThen(
          forOwnHost(served, host, operation, input),
          Effect.suspend(() => commands[operation](input)),
        ).pipe(
          Effect.flatMap((output) => withinReplyBound(operation, output)),
          Effect.mapError(toWire(WorkspaceRpcs, operation)),
        );
        return isHostMutation(operation) ? Rpc.uninterruptible(run) : run;
      };
    return {
      openCheckout: command('openCheckout'),
      verifyCheckout: command('verifyCheckout'),
      readFile: command('readFile'),
      saveFile: command('saveFile'),
      listDirectory: command('listDirectory'),
      getIgnoredPaths: command('getIgnoredPaths'),
      gitStatus: command('gitStatus'),
      listWorktrees: command('listWorktrees'),
      createWorktree: command('createWorktree'),
      initializeRepository: command('initializeRepository'),
      readComparison: command('readComparison'),
      lookupFiles: command('lookupFiles'),
      searchText: command('searchText'),
      inspectEntries: command('inspectEntries'),
      mutate: command('mutate'),
      operationStatus: command('operationStatus'),
      acknowledgeOperation: command('acknowledgeOperation'),
      saveStatus: command('saveStatus'),
      acknowledgeSave: command('acknowledgeSave'),
      listOperations: command('listOperations'),
      createChatWorktree: command('createChatWorktree'),
      turnChatIntoProject: command('turnChatIntoProject'),
      captureImports: command('captureImports'),
      releaseImports: command('releaseImports'),
      /**
       * A checkout's watch: each change the host reports raises `revision`; `ready` once it
       * watches. One the host ends is `HostUnavailableError` (`watch-ended`), so its client
       * watches again.
       */
      watchWorkspace: ({ host, checkout }) =>
        Stream.unwrap(
          Effect.as(
            forOwnHost(served, host, 'watchWorkspace', { checkout }),
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
                      [
                        {
                          ...next,
                          ...(event.error === undefined ? {} : { failed: true as const }),
                        },
                      ],
                    ];
                  },
                ),
              ),
              Stream.fail(new HostUnavailableError({ reason: 'watch-ended' })),
            ),
          ),
        ).pipe(Stream.mapError(toWire(WorkspaceRpcs, 'watchWorkspace'))),
    } satisfies RpcGroup.HandlersFrom<WorkspaceRpc>;
  });
