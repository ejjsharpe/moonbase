import { Context, Effect, Layer } from 'effect';
import { WorkspaceHostService, WorkspaceService } from '@moonbase/contracts/services';
import type { WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import { makeClientWorkspace } from './client/client.ts';
import { asWorkspaceError } from './owned-work.ts';
import { openClientStore } from './client/client-store.ts';
import { decodeClientConfiguration } from './client/client-schema.ts';
import { FileHost, makeFileHostLayer } from './host/host.ts';
import type { WorkspaceHostConfiguration } from './schema.ts';
import type { WorkspaceHostError } from '@moonbase/contracts/workspace-host-errors';
import type { WorkspaceError } from '@moonbase/contracts/workspace-errors';

export type {
  ChatFolders,
  RootPredicate,
  WorkspaceConfiguration,
  WorkspaceHostConfiguration,
} from './schema.ts';
export type WorkspaceRecoveryConfiguration = {
  dataDirectory: string;
  /** The store's identity to a file host; when absent, the one the store holds or a new one. */
  installationId?: string;
  /**
   * How long loading recovery waits on the host before it stops asking it for this load, so a
   * host that is slow to start never holds back drafts; what was skipped is retried on the next
   * load. Default 5000.
   */
  hostWaitMs?: number;
};

/**
 * The file host: approvals, reads, saves, file operations, Git, search and watching, with the
 * journals of the saves and operations it admitted. It keeps no client recovery. Scoped resources
 * only; the shared application composition root supplies the runtime. Its journal keeps time by
 * the `Clock` it is composed with.
 */
export function WorkspaceHostLive(configuration: WorkspaceHostConfiguration) {
  return Layer.mergeAll(
    Layer.effect(
      WorkspaceHostService,
      Effect.map(FileHost, (host) => host.service),
    ),
    Layer.effect(
      WorkspaceFolders,
      Effect.map(FileHost, (host) => ({ has: host.hasFolder })),
    ),
  ).pipe(Layer.provide(makeFileHostLayer(configuration)));
}

/**
 * The installation ID of the client recovery store in `dataDirectory`: the one it holds, or a new
 * one it keeps from now on. Open it before composing `WorkspaceRecoveryLive` over the same folder.
 */
export const readInstallationId = (dataDirectory: string): Effect.Effect<string, WorkspaceError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* decodeClientConfiguration({ dataDirectory });
      return (yield* openClientStore(config.dataDirectory)).installationId;
    }),
  ).pipe(
    // A client store that cannot open fails with a workspace error, never a system call's own.
    Effect.mapError((failure) => asWorkspaceError(failure, true)),
  );

/**
 * One client's workspace over a file host: the editor's `WorkspaceService`, with this client's
 * recovery, intents and operation-feed positions in `dataDirectory`. Compose it with the host in
 * the same process, or over a remote one. `installationId` names this client store to the host.
 */
export function WorkspaceRecoveryLive(
  configuration: WorkspaceRecoveryConfiguration,
  host: WorkspaceHostServiceShape,
) {
  return Layer.effect(
    WorkspaceService,
    Effect.gen(function* () {
      const config = yield* decodeClientConfiguration(configuration);
      const { store, installationId } = yield* openClientStore(
        config.dataDirectory,
        config.installationId,
      );
      return yield* makeClientWorkspace({
        store,
        installationId,
        host,
        hostWaitMs: config.hostWaitMs ?? 5000,
      });
    }).pipe(
      // A client store that cannot open fails with a workspace error, never a system call's own.
      Effect.mapError((failure) => asWorkspaceError(failure, true)),
    ),
  );
}

/**
 * The file host and one client recovery store in one process, for a process that runs both (tests
 * and `examples/local.ts`; Electron main composes only `WorkspaceRecoveryLive`, over the daemon's
 * host): the host journals and the client recovery share `dataDirectory`, in separate files.
 * Provides `WorkspaceService` and `WorkspaceHostService`.
 */
export function WorkspaceLocalLive(
  configuration: WorkspaceHostConfiguration & { installationId: string },
) {
  const { installationId, ...hostConfiguration } = configuration;
  return Layer.unwrap(
    Effect.map(WorkspaceHostService, (host) =>
      WorkspaceRecoveryLive({ dataDirectory: configuration.dataDirectory, installationId }, host),
    ),
  ).pipe(Layer.provideMerge(WorkspaceHostLive(hostConfiguration)));
}

/**
 * Whether a folder is the root of a checkout the host approved, re-checked by identity and root
 * policy on every call. A daemon's chats use it to accept the folders of the editor's projects
 * without a separate grant. It approves nothing.
 */
export class WorkspaceFolders extends Context.Service<
  WorkspaceFolders,
  { has(path: string): Effect.Effect<boolean, WorkspaceHostError> }
>()('moonbase/WorkspaceFolders') {}
