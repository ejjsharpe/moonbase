import { Context, Layer, Effect, type Stream } from 'effect';
import { ChatRpcs, chatErrorSchemaOf } from '@moonbase/contracts/chat-rpc';
import {
  LocalHostRpcs,
  ProviderSetupRpcs,
  daemonErrorSchemas,
} from '@moonbase/contracts/daemon-rpc';
import type { ChatError } from '@moonbase/contracts/chat-errors';
import type { FolderError } from '@moonbase/contracts/folder-errors';
import type { ProviderSetupError } from '@moonbase/contracts/provider-errors';
import { UnauthorizedError, UncertainError } from '@moonbase/contracts/errors';
import {
  IncompatibleHostError,
  type DaemonLinkError,
  type hostErrors,
} from '@moonbase/contracts/host-errors';
import type { ChatHostHealth, ChatHostTarget } from '@moonbase/contracts/host';
import { rpcLimits, rpcPath, rpcProtocol } from '@moonbase/contracts/rpc-upgrade';
import type { ConnectionService } from '@moonbase/contracts/services';
import {
  applyWatchDelta,
  type WatchDelta,
  type WatchKind,
  type WatchValue,
} from '@moonbase/contracts/watch';
import { decodeWatchValue } from '@moonbase/contracts/watch-schema';
import { makeRpcLink, type ErrorClass, type WatchUpdate } from './rpc-link.ts';

export type { WatchUpdate } from './rpc-link.ts';
/** Every procedure a daemon may serve over RPC. */
export const DaemonRpcs = ChatRpcs.merge(LocalHostRpcs, ProviderSetupRpcs);

/** The errors a daemon's procedures declare: the only failures a client takes from it. */
const remoteErrors = [
  ...new Set(
    [
      chatErrorSchemaOf('getChat'),
      chatErrorSchemaOf('findChatFiles'),
      chatErrorSchemaOf('sendChat'),
      chatErrorSchemaOf('getChatSend'),
      ...Object.values(daemonErrorSchemas),
    ].flatMap((union) => union.members as readonly ErrorClass[]),
  ),
];
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
export function presentRemoteError(error: RemoteError, operation: string): RemoteError {
  switch (error._tag) {
    case 'UncertainError':
      return new UncertainError({ operation });
    case 'UnauthorizedError':
      return new UnauthorizedError({ operation });
    default:
      return error;
  }
}

/** A watch's update: a whole value, or a delta from the one before it. */
type Update<K extends WatchKind> =
  | { kind: 'snapshot'; value: WatchValue<K> }
  | { kind: 'delta'; delta: WatchDelta<K> };

/**
 * The RPC link to one host's daemon, shared by the chat, folder and provider setup services built
 * with it: see `makeRpcLink`.
 */
export class DaemonRpcLink extends Context.Service<
  DaemonRpcLink,
  {
    readonly host: ChatHostTarget;
    /**
     * Sends one request; `check` refuses a reply against the daemon's signed health. It fails with
     * `E`, the errors its procedure declares, or the link's own.
     */
    call<A, E extends RemoteError>(
      operation: string,
      payload: object,
      options: {
        mutation: boolean;
        capability: string;
        check?: (output: A, health: ChatHostHealth) => void;
      },
    ): Effect.Effect<A, E | DaemonLinkError>;
    /**
     * Follows a watch: its updates applied to the value they describe, each value decoded and
     * checked. A resubscription after a drop starts from a fresh value.
     */
    watch<K extends WatchKind, E extends RemoteError>(
      operation: string,
      kind: K,
      payload: object,
      options: { capability: string; check?: (value: WatchValue<K>) => void },
    ): Stream.Stream<WatchUpdate<WatchValue<K>>, E | DaemonLinkError>;
  }
>()('moonbase/DaemonRpcLink') {}

export const DaemonRpcLinkLive = (config: {
  host: ChatHostTarget;
}): Layer.Layer<DaemonRpcLink, never, ConnectionService> =>
  Layer.effect(
    DaemonRpcLink,
    Effect.map(
      makeRpcLink({
        host: config.host,
        group: DaemonRpcs,
        path: rpcPath,
        protocol: rpcProtocol,
        inboundBytes: rpcLimits.inboundBytes,
        errors: remoteErrors,
        present: (error, operation) => presentRemoteError(error as RemoteError, operation),
      }),
      (link) => ({
        host: link.host,
        call: (operation, payload, options) => link.call(operation, payload, options),
        watch: <K extends WatchKind, E extends RemoteError>(
          operation: string,
          kind: K,
          payload: object,
          options: { capability: string; check?: (value: WatchValue<K>) => void },
        ) =>
          link.follow<WatchValue<K>, E>(operation, payload, {
            capability: options.capability,
            next: (previous, raw) => {
              const update = raw as Update<K>;
              if (update.kind === 'delta' && previous === undefined)
                throw new IncompatibleHostError({ reason: 'invalid-update' });
              const value = decodeWatchValue(
                kind,
                update.kind === 'snapshot'
                  ? update.value
                  : applyWatchDelta(kind, previous!, update.delta),
              );
              options.check?.(value);
              return value;
            },
          }),
      }),
    ),
  );
