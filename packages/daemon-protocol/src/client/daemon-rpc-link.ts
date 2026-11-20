import { Context, Layer, Effect, type Stream } from 'effect';
import type { Rpc, RpcGroup } from 'effect/rpc';
import type { RpcClientError } from 'effect/rpc/RpcClientError';
import { ChatRpcs } from '@moonbase/contracts/chat-rpc';
import { LocalHostRpcs, ProviderSetupRpcs } from '@moonbase/contracts/daemon-rpc';
import type { ChatError } from '@moonbase/contracts/chat-errors';
import type { FolderError } from '@moonbase/contracts/folder-errors';
import type { ProviderSetupError } from '@moonbase/contracts/provider-errors';
import { UnauthorizedError, UncertainError } from '@moonbase/contracts/errors';
import { IncompatibleHostError, type hostErrors } from '@moonbase/contracts/host-errors';
import type { ChatHostTarget } from '@moonbase/contracts/host';
import { rpcLimits, rpcPath, rpcProtocol } from '@moonbase/contracts/rpc-upgrade';
import type { ConnectionService } from '@moonbase/contracts/services';
import {
  applyWatchDelta,
  type WatchDelta,
  type WatchKind,
  type WatchValue,
} from '@moonbase/contracts/watch';
import { decodeWatchValue } from '@moonbase/contracts/watch-schema';
import { makeRpcLink, type ProcedureMethod, type RpcLink } from './rpc-link.ts';

/** Every procedure a daemon may serve over RPC. */
export const DaemonRpcs = ChatRpcs.merge(LocalHostRpcs, ProviderSetupRpcs);

/** An error a daemon's procedures declare, as the client presents it. */
export type RemoteError =
  | ChatError
  | FolderError
  | ProviderSetupError
  | InstanceType<(typeof hostErrors)[number]>;

/**
 * A daemon's own error as the client shows it (D11): its tag and literal reason, decoded into the
 * client's own classes, so its message is the client's fixed text and it carries no cause. Free
 * text a host could fill (the operation an outcome names) is the client's own, and an outcome's
 * target is dropped. A decoded number, such as a command's exit status, is kept.
 */
export function presentRemoteError<E extends RemoteError>(error: E, operation: string): E {
  // Each rebuilt error is of its tag's class, so of the type it replaces.
  switch (error._tag) {
    case 'UncertainError':
      return new UncertainError({ operation }) as E;
    case 'UnauthorizedError':
      return new UnauthorizedError({ operation }) as E;
    default:
      return error;
  }
}

/** A watch's update: a whole value, decoded as it arrived, or a delta from the one before it. */
type Update<K extends WatchKind> =
  | { kind: 'snapshot'; value: WatchValue<K> }
  | { kind: 'delta'; delta: WatchDelta<K> };
/** Every procedure a daemon may serve over its RPC socket. */
export type DaemonRpc = RpcGroup.Rpcs<typeof DaemonRpcs>;

/**
 * The RPC link to one host's daemon, shared by the chat, folder and provider setup services built
 * with it: see `makeRpcLink`.
 */
export class DaemonRpcLink extends Context.Service<DaemonRpcLink, RpcLink<DaemonRpc>>()(
  'moonbase/DaemonRpcLink',
) {}

export const DaemonRpcLinkLive = (config: {
  host: ChatHostTarget;
}): Layer.Layer<DaemonRpcLink, never, ConnectionService> =>
  Layer.effect(
    DaemonRpcLink,
    makeRpcLink({
      host: config.host,
      group: DaemonRpcs,
      path: rpcPath,
      protocol: rpcProtocol,
      inboundBytes: rpcLimits.inboundBytes,
    }),
  );

const invalidUpdate = () => new IncompatibleHostError({ reason: 'invalid-update' });
/**
 * Follows a daemon watch: its updates applied to the value they describe, the value a delta makes
 * decoded and each value checked. A resubscription after a drop starts from a fresh value.
 */
export const followWatch = <
  T extends Rpc.Tag<DaemonRpc>,
  K extends WatchKind,
  E extends RemoteError | RpcClientError,
  C = never,
>(
  link: RpcLink<DaemonRpc>,
  operation: T,
  kind: K,
  subscribe: (method: ProcedureMethod<DaemonRpc, T>) => Stream.Stream<Update<K>, E>,
  options: { capability: string; check?: (value: WatchValue<K>) => Effect.Effect<void, C> },
) =>
  link.follow<
    T,
    Update<K>,
    E,
    WatchValue<K>,
    Exclude<E, RpcClientError>,
    C | IncompatibleHostError
  >(operation, subscribe, {
    capability: options.capability,
    present: (error) => presentRemoteError(error, operation),
    next: (previous, update) =>
      Effect.gen(function* () {
        if (update.kind === 'delta' && previous === undefined)
          return yield* Effect.fail(invalidUpdate());
        // A snapshot was decoded as it arrived; the value a delta makes is new.
        const value =
          update.kind === 'snapshot'
            ? update.value
            : yield* Effect.try({
                try: () => decodeWatchValue(kind, applyWatchDelta(kind, previous!, update.delta)),
                catch: invalidUpdate,
              });
        if (options.check) yield* options.check(value);
        return value;
      }),
  });
