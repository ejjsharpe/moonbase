import { Context, Effect, FiberSet, Layer, Scope } from 'effect';
import { WorkspaceHostService, WorkspaceService } from '@moonbase/contracts/services';
import type { WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import { ApplicationError, type CheckoutTarget } from '@moonbase/contracts/workspace';
import { normalizeApplicationError } from '@moonbase/effect';
import { ClientWorkspace } from './client.ts';
import { ClientStore } from './client-store.ts';
import { decodeClientConfiguration } from './client-schema.ts';
import { FileHost } from './host.ts';
import { decodeConfiguration, type WorkspaceHostConfiguration } from './schema.ts';

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
  const resources = Layer.effect(
    HostResources,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const config = yield* Effect.try({
          try: () => decodeConfiguration(configuration),
          catch: normalizeApplicationError,
        });
        const { allowRoot, chats } = configuration;
        const parent = yield* Effect.scope;
        const operationScope = yield* Scope.fork(parent, 'parallel');
        const helperScope = yield* Scope.fork(parent, 'parallel');
        const referenceScope = yield* Scope.fork(parent, 'parallel');
        const observationScope = yield* Scope.fork(parent, 'parallel');
        const operations = yield* FiberSet.make<unknown, ApplicationError>().pipe(
          Scope.provide(operationScope),
        );
        const helpers = yield* FiberSet.make<unknown, unknown>().pipe(Scope.provide(helperScope));
        const references = yield* FiberSet.make<void, never>().pipe(Scope.provide(referenceScope));
        const runHelper = yield* FiberSet.runtimePromise(helpers)();
        const startExpiry = yield* FiberSet.runtime(references)();
        return yield* Effect.try({
          try: () =>
            new FileHost(
              config,
              {
                operations,
                operationScope,
                helperScope,
                referenceScope,
                observationScope,
                runHelper,
                startExpiry,
              },
              now,
              allowRoot,
              chats,
            ),
          catch: (error) =>
            normalizeApplicationError(
              error,
              new ApplicationError({ code: 'Persistence', message: 'Application effect failed' }),
            ),
        });
      }),
      (host) => host.close(),
    ),
  );
  return Layer.mergeAll(
    Layer.effect(
      WorkspaceHostService,
      Effect.map(HostResources, (host) => host.service),
    ),
    Layer.effect(
      WorkspaceNative,
      Effect.map(HostResources, (host) => ({
        capture: (input: { checkout: CheckoutTarget; clientId: string; paths: string[] }) =>
          Effect.map(host.service.captureImports(input), (captured) => captured.references),
        release: (input: { checkout: CheckoutTarget; clientId: string; references: string[] }) =>
          host.service.releaseImports(input),
      })),
    ),
    Layer.effect(
      WorkspaceFolders,
      Effect.map(HostResources, (host) => ({
        has: (path: string) => host.effect(() => host.hasFolder(path)),
      })),
    ),
  ).pipe(Layer.provide(resources));
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
    Effect.map(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const config = yield* Effect.try({
            try: () => decodeClientConfiguration(configuration),
            catch: normalizeApplicationError,
          });
          const parent = yield* Effect.scope;
          const operationScope = yield* Scope.fork(parent, 'parallel');
          const operations = yield* FiberSet.make<unknown, ApplicationError>().pipe(
            Scope.provide(operationScope),
          );
          return yield* Effect.try({
            try: () => new ClientWorkspace(config, { operations, operationScope }, host),
            catch: (error) =>
              normalizeApplicationError(
                error,
                new ApplicationError({ code: 'Persistence', message: 'Application effect failed' }),
              ),
          });
        }),
        (client) => client.close(),
      ),
      (client) => client.service,
    ),
  );
}

/**
 * The file host and one client recovery store in one process, as Electron main composes them: the
 * host journals and the client recovery share `dataDirectory`, in separate files. Provides
 * `WorkspaceService`, `WorkspaceHostService` and `WorkspaceNative`.
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

/** Main/native adapter only: approved picker/drop paths become short-lived, single-use tokens. */
export class WorkspaceNative extends Context.Service<
  WorkspaceNative,
  {
    capture(input: {
      checkout: CheckoutTarget;
      clientId: string;
      paths: string[];
    }): Effect.Effect<string[], ApplicationError>;
    release(input: {
      checkout: CheckoutTarget;
      clientId: string;
      references: string[];
    }): Effect.Effect<void, ApplicationError>;
  }
>()('moonbase/WorkspaceNative') {}
class HostResources extends Context.Service<HostResources, FileHost>()(
  'moonbase/WorkspaceHostResources',
) {}
