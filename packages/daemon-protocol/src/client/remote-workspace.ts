import { Effect, Layer, Semaphore, Stream } from 'effect';
import type { RpcGroup } from 'effect/rpc';
import type { RpcClientError } from 'effect/rpc/RpcClientError';
import { UnauthorizedError } from '@moonbase/contracts/errors';
import { chatHostCapabilities, type ChatHostTarget } from '@moonbase/contracts/host';
import { IncompatibleHostError } from '@moonbase/contracts/host-errors';
import {
  workspacePingTimeoutMs,
  workspaceRpcLimits,
  workspaceRpcPath,
  workspaceRpcProtocol,
} from '@moonbase/contracts/rpc-upgrade';
import {
  WorkspaceHostService,
  type ConnectionService,
  type WorkspaceHostServiceShape,
} from '@moonbase/contracts/services';
import type {
  HostCommand,
  HostInput,
  HostOutput,
  WorkspaceWatchValue,
} from '@moonbase/contracts/workspace-host';
import {
  InvalidRequestError,
  type WorkspaceHostError,
} from '@moonbase/contracts/workspace-host-errors';
import { decodeHostInput, hostInputCheckout } from '@moonbase/contracts/workspace-host-schema';
import { hostDeadlineMs, isHostStatusCall, WorkspaceRpcs } from '@moonbase/contracts/workspace-rpc';
import { makeRpcLink, type ProcedureMethod } from './rpc-link.ts';

type WorkspaceRpc = RpcGroup.Rpcs<typeof WorkspaceRpcs>;

/** Operations whose reply names a checkout: one they made or opened. */
const checkoutMakers: ReadonlySet<string> = new Set<HostCommand>([
  'openCheckout',
  'createWorktree',
  'initializeRepository',
  'createChatWorktree',
  'turnChatIntoProject',
]);
/** The checkouts a reply names: the one it made or opened, an operation's, or a feed's. */
const outputCheckouts = (operation: HostCommand, output: unknown): { hostId: string }[] => {
  if (checkoutMakers.has(operation)) return [output as { hostId: string }];
  if (operation === 'mutate' || operation === 'operationStatus')
    return output ? [(output as HostOutput<'mutate'>).checkout] : [];
  if (operation === 'listOperations')
    return (output as HostOutput<'listOperations'>).operations.map((entry) => entry.checkout);
  return [];
};

/**
 * The file host of a daemon that advertises `workspace-v2`, over the workspace's own RPC socket
 * (one connection per connection generation), so a large file never delays chat. Every operation
 * is decoded before it leaves, refused for a checkout of another host or past
 * `workspaceRpcLimits.payloadBytes`, and answered within its deadline class (`hostDeadlineMs`).
 * Mutations are never sent again: a lost reply is `Uncertain`, and `saveStatus`,
 * `operationStatus` or the request ID of a repeat resolves it. At most
 * `workspaceRpcLimits.requests` requests are in flight, plus `statusRequests` for the status
 * calls, as the daemon allows: a request waits up to its deadline for a place (`busy`, never sent,
 * past it), and keeps it until the daemon answered or the connection closed. A reply naming a
 * checkout of another host is refused (`Incompatible`, or `Uncertain` for a mutation).
 * `watch` ignores `paths`: the daemon follows the whole checkout, and every value, including the
 * first after a reconnect, is an event to refresh from.
 */
export const RemoteWorkspaceHostLive = (config: {
  host: ChatHostTarget;
}): Layer.Layer<WorkspaceHostService, never, ConnectionService> =>
  Layer.effect(
    WorkspaceHostService,
    Effect.gen(function* () {
      const { host } = config;
      const link = yield* makeRpcLink({
        host,
        group: WorkspaceRpcs,
        path: workspaceRpcPath,
        protocol: workspaceRpcProtocol,
        capability: chatHostCapabilities.workspace,
        inboundBytes: workspaceRpcLimits.messageBytes,
        pingTimeoutMs: workspacePingTimeoutMs,
      });
      const places = yield* Semaphore.make(workspaceRpcLimits.requests);
      // The daemon's in-flight input bound, kept here too by encoded bytes, so a request the daemon
      // would refuse `busy` for it waits for room instead. Waiters are not served in order: a
      // smaller later request may go first.
      const bytes = yield* Semaphore.make(workspaceRpcLimits.inFlightBytes);
      const statusPlaces = yield* Semaphore.make(workspaceRpcLimits.statusRequests);
      /** Refuses an input naming a checkout (or chat) of another host. */
      const ownHost = (operation: string, input: unknown) =>
        hostInputCheckout(input)?.hostId === undefined ||
        hostInputCheckout(input)!.hostId === host.hostId
          ? Effect.void
          : Effect.fail(new UnauthorizedError({ operation }));
      /** Decodes an input and bounds its JSON, giving its size; a refused one is never sent. */
      const prepare = <K extends HostCommand>(operation: K, raw: HostInput<K>) =>
        Effect.flatMap(
          Effect.try({
            try: () => {
              const input = decodeHostInput(operation, raw);
              // The payload as sent: what the daemon charges, and bounds, a request by.
              const size = Buffer.byteLength(JSON.stringify({ host, input }));
              if (size > workspaceRpcLimits.payloadBytes)
                throw new InvalidRequestError({ problem: 'request-too-large' });
              return { input, size };
            },
            catch: (error) =>
              error instanceof InvalidRequestError
                ? error
                : new InvalidRequestError({ problem: 'invalid-input' }),
          }),
          (prepared) => Effect.as(ownHost(operation, prepared.input), prepared),
        );
      const send =
        <K extends HostCommand, E extends WorkspaceHostError | RpcClientError>(
          operation: K,
          request: (
            method: ProcedureMethod<WorkspaceRpc, K>,
            payload: { host: ChatHostTarget; input: HostInput<K> },
          ) => Effect.Effect<HostOutput<K>, E>,
        ) =>
        (raw: HostInput<K>): Effect.Effect<HostOutput<K>, WorkspaceHostError> =>
          Effect.flatMap(prepare(operation, raw), ({ input, size }) =>
            link.call(operation, (method) => request(method, { host, input }), {
              capability: chatHostCapabilities.workspace,
              deadlineMs: hostDeadlineMs(operation),
              // Status calls have places of their own and are not charged for their input.
              places: isHostStatusCall(operation)
                ? [{ semaphore: statusPlaces, permits: 1 }]
                : [
                    { semaphore: places, permits: 1 },
                    { semaphore: bytes, permits: size },
                  ],
              check: (output) =>
                outputCheckouts(operation, output).every(
                  (checkout) => checkout.hostId === host.hostId,
                )
                  ? Effect.void
                  : Effect.fail(new IncompatibleHostError({ reason: 'invalid-reply' })),
            }),
          );
      return {
        openCheckout: send('openCheckout', (method, payload) => method(payload)),
        verifyCheckout: send('verifyCheckout', (method, payload) => method(payload)),
        readFile: send('readFile', (method, payload) => method(payload)),
        saveFile: send('saveFile', (method, payload) => method(payload)),
        listDirectory: send('listDirectory', (method, payload) => method(payload)),
        getIgnoredPaths: send('getIgnoredPaths', (method, payload) => method(payload)),
        gitStatus: send('gitStatus', (method, payload) => method(payload)),
        listWorktrees: send('listWorktrees', (method, payload) => method(payload)),
        createWorktree: send('createWorktree', (method, payload) => method(payload)),
        initializeRepository: send('initializeRepository', (method, payload) => method(payload)),
        readComparison: send('readComparison', (method, payload) => method(payload)),
        lookupFiles: send('lookupFiles', (method, payload) => method(payload)),
        searchText: send('searchText', (method, payload) => method(payload)),
        inspectEntries: send('inspectEntries', (method, payload) => method(payload)),
        mutate: send('mutate', (method, payload) => method(payload)),
        operationStatus: send('operationStatus', (method, payload) => method(payload)),
        acknowledgeOperation: send('acknowledgeOperation', (method, payload) => method(payload)),
        saveStatus: send('saveStatus', (method, payload) => method(payload)),
        acknowledgeSave: send('acknowledgeSave', (method, payload) => method(payload)),
        listOperations: send('listOperations', (method, payload) => method(payload)),
        createChatWorktree: send('createChatWorktree', (method, payload) => method(payload)),
        turnChatIntoProject: send('turnChatIntoProject', (method, payload) => method(payload)),
        captureImports: send('captureImports', (method, payload) => method(payload)),
        releaseImports: send('releaseImports', (method, payload) => method(payload)),
        watch: ({ checkout }) =>
          Stream.unwrap(
            Effect.as(
              ownHost('watchWorkspace', { checkout }),
              link
                .follow('watchWorkspace', (method) => method({ host, checkout }), {
                  capability: chatHostCapabilities.workspace,
                  next: (_previous: WorkspaceWatchValue | undefined, value: WorkspaceWatchValue) =>
                    Effect.succeed(value),
                })
                .pipe(
                  Stream.filter((update) => !('reconnecting' in update)),
                  // Only the value that first says the watch is ready is `ready`; every later
                  // one, the first after a reconnect included, is a change to read again from.
                  Stream.mapAccum(
                    () => false,
                    (readySeen, update) => {
                      const { value } = update as Exclude<typeof update, { reconnecting: true }>;
                      return [
                        readySeen || value.ready,
                        [
                          {
                            checkout,
                            paths: [''],
                            ...(!readySeen && value.ready ? { ready: true } : {}),
                            ...(value.failed ? { error: 'The workspace watch failed.' } : {}),
                          },
                        ],
                      ] as const;
                    },
                  ),
                ),
            ),
          ),
      } satisfies WorkspaceHostServiceShape;
    }),
  );
