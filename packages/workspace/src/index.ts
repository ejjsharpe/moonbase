import { Context, Effect, Layer } from 'effect';
import { WorkspaceHostService, WorkspaceService } from '@moonbase/contracts/services';
import type { WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import type { ApplicationError } from '@moonbase/contracts/workspace';
import { makeClientWorkspace } from './client/client.ts';
import { attempt } from './attempt.ts';
import { asWorkspaceError } from './owned-work.ts';
import { ClientStore } from './client/client-store.ts';
import { decodeClientConfiguration } from './client/client-schema.ts';
import { FileHost, makeFileHostLayer } from './host/host.ts';
import type { WorkspaceHostConfiguration } from './schema.ts';
import { toWireError } from '@moonbase/contracts/workspace-errors';

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
 * only; the shared application composition root supplies the runtime. `now` is the journal clock.
 */
export function WorkspaceHostLive(configuration: WorkspaceHostConfiguration, now?: () => number) {
  return Layer.mergeAll(
    Layer.effect(
      WorkspaceHostService,
      Effect.map(FileHost, (host) => host.service),
    ),
    Layer.effect(
      WorkspaceFolders,
      // The daemon reads its refusals as wire errors, until CL-07.
      Effect.map(FileHost, (host) => ({
        has: (path: string) => host.hasFolder(path).pipe(Effect.mapError(toWireError)),
      })),
    ),
  ).pipe(Layer.provide(makeFileHostLayer(configuration, now)));
}

/**
 * The installation ID of the client recovery store in `dataDirectory`: the one it holds, or a new
 * one it keeps from now on. Open it before composing `WorkspaceRecoveryLive` over the same folder.
 */
export function readInstallationId(dataDirectory: string) {
  const store = new ClientStore(decodeClientConfiguration({ dataDirectory }).dataDirectory);
  try {
    return store.installationId;
  } finally {
    store.close();
  }
}

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
      const config = yield* attempt(() => decodeClientConfiguration(configuration));
      const store = yield* Effect.acquireRelease(
        attempt(() => new ClientStore(config.dataDirectory, config.installationId)),
        (store) => Effect.sync(() => store.close()),
      );
      return yield* makeClientWorkspace({ store, host, hostWaitMs: config.hostWaitMs ?? 5000 });
    }).pipe(
      // A client store that cannot open fails its composition with the wire error its owners
      // expect, until the workspace moves to Effect RPC (CL-07).
      Effect.mapError((failure) => toWireError(asWorkspaceError(failure, true))),
    ),
  );
}

/**
 * The file host and one client recovery store in one process, as Electron main composes them: the
 * host journals and the client recovery share `dataDirectory`, in separate files. Provides
 * `WorkspaceService` and `WorkspaceHostService`.
 */
export function WorkspaceLocalLive(
  configuration: WorkspaceHostConfiguration & { installationId: string },
  now?: () => number,
) {
  const { installationId, ...hostConfiguration } = configuration;
  return Layer.unwrap(
    Effect.map(WorkspaceHostService, (host) =>
      WorkspaceRecoveryLive({ dataDirectory: configuration.dataDirectory, installationId }, host),
    ),
  ).pipe(Layer.provideMerge(WorkspaceHostLive(hostConfiguration, now)));
}

/**
 * Whether a folder is the root of a checkout the host approved, re-checked by identity and root
 * policy on every call. A daemon's chats use it to accept the folders of the editor's projects
 * without a separate grant. It approves nothing.
 */
export class WorkspaceFolders extends Context.Service<
  WorkspaceFolders,
  { has(path: string): Effect.Effect<boolean, ApplicationError> }
>()('moonbase/WorkspaceFolders') {}
