import { Effect, Layer, Semaphore, Stream } from 'effect';
import { CancelledError, UnauthorizedError, UncertainError } from '@moonbase/contracts/errors';
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
  BranchTakenError,
  GitStatusFormatError,
  IncompleteCleanupError,
  InterruptedRequestError,
  InvalidBaseError,
  InvalidPatternError,
  InvalidRequestError,
  RecordedRefusalError,
  WorkspaceStoreError,
  WorktreeGitError,
  type WorkspaceHostError,
} from '@moonbase/contracts/workspace-host-errors';
import {
  decodeHostInput,
  hostInputCheckout,
  hostInputSchemas,
} from '@moonbase/contracts/workspace-host-schema';
import {
  hostDeadlineMs,
  isHostMutation,
  isHostStatusCall,
  workspaceErrorSchemaOf,
  WorkspaceRpcs,
} from '@moonbase/contracts/workspace-rpc';
import { makeRpcLink, type ErrorClass } from './rpc-link.ts';

/** The errors the workspace's procedures declare: the only failures a client takes from them. */
const remoteErrors = [
  ...new Set(
    [workspaceErrorSchemaOf('readFile'), workspaceErrorSchemaOf('turnChatIntoProject')].flatMap(
      (union) => union.members as readonly ErrorClass[],
    ),
  ),
];
/** The client's own text for a refusal a host recorded, by its kind. */
const recordedRefusals = {
  invalid: 'The host refused this request as invalid.',
  unauthorized: 'The host did not authorize this request.',
  conflict: 'The host found a conflict with this request.',
  incompatible: 'The host’s authority or protocol is incompatible.',
} as const;

/**
 * A file host's error as the client shows it (D11): decoded into the client's own classes, with
 * every field a host could fill with text (Git's output, paths, a pattern's reason, a refusal's
 * text) dropped or replaced by the client's own, so its message is the client's. A branch
 * `createWorktree` found taken is named as the client asked for it, from its `input`; a chat
 * worktree's derives its own, so it names none.
 */
export function presentWorkspaceError(
  error: WorkspaceHostError,
  operation: string,
  input?: unknown,
) {
  switch (error._tag) {
    case 'BranchTakenError': {
      const branch =
        operation === 'createWorktree'
          ? (input as { branch?: unknown } | undefined)?.branch
          : undefined;
      return new BranchTakenError({
        inside: error.inside,
        ...(typeof branch === 'string' ? { branch } : {}),
      });
    }
    case 'UncertainError':
      return new UncertainError({ operation });
    case 'UnauthorizedError':
      return new UnauthorizedError({ operation });
    case 'CancelledError':
      return new CancelledError({ operation });
    case 'InterruptedRequestError':
      return new InterruptedRequestError({ operation });
    case 'InvalidBaseError':
      return new InvalidBaseError({});
    case 'InvalidPatternError':
      return new InvalidPatternError({});
    case 'WorktreeGitError':
      return new WorktreeGitError({});
    case 'GitStatusFormatError':
      return new GitStatusFormatError({});
    case 'IncompleteCleanupError':
      return new IncompleteCleanupError({});
    case 'WorkspaceStoreError':
      return new WorkspaceStoreError({ failure: error.failure });
    case 'RecordedRefusalError':
      return new RecordedRefusalError({
        refusal: error.refusal,
        text: recordedRefusals[error.refusal],
      });
    default:
      return error;
  }
}

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
        errors: remoteErrors,
        present: (error, operation, payload) =>
          presentWorkspaceError(
            error as WorkspaceHostError,
            operation,
            (payload as { input?: unknown }).input,
          ),
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
        <K extends HostCommand>(operation: K) =>
        (raw: HostInput<K>): Effect.Effect<HostOutput<K>, WorkspaceHostError> =>
          Effect.flatMap(prepare(operation, raw), ({ input, size }) =>
            link.call<HostOutput<K>, WorkspaceHostError>(
              operation,
              { host, input },
              {
                mutation: isHostMutation(operation),
                capability: chatHostCapabilities.workspace,
                deadlineMs: hostDeadlineMs(operation),
                // Status calls have places of their own and are not charged for their input.
                places: isHostStatusCall(operation)
                  ? [{ semaphore: statusPlaces, permits: 1 }]
                  : [
                      { semaphore: places, permits: 1 },
                      { semaphore: bytes, permits: size },
                    ],
                check: (output) => {
                  for (const checkout of outputCheckouts(operation, output))
                    if (checkout.hostId !== host.hostId)
                      throw new IncompatibleHostError({ reason: 'invalid-reply' });
                },
              },
            ),
          );
      const handlers = Object.fromEntries(
        (Object.keys(hostInputSchemas) as HostCommand[]).map((operation) => [
          operation,
          send(operation),
        ]),
      ) as { [K in HostCommand]: ReturnType<typeof send<K>> };
      return {
        ...handlers,
        watch: ({ checkout }) =>
          Stream.unwrap(
            Effect.as(
              ownHost('watchWorkspace', { checkout }),
              link
                .follow<WorkspaceWatchValue, WorkspaceHostError>(
                  'watchWorkspace',
                  { host, checkout },
                  {
                    capability: chatHostCapabilities.workspace,
                    next: (_previous, value) => value as WorkspaceWatchValue,
                  },
                )
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
