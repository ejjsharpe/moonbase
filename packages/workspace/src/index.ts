import { Context, Effect, FiberSet, Layer, Scope } from 'effect';
import { WorkspaceHostService, WorkspaceService } from '@moonbase/contracts/services';
import type { WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import type { ApplicationError, CheckoutTarget } from '@moonbase/contracts/workspace';
import { applicationError } from './admission.ts';
import { ClientWorkspace } from './client.ts';
import { decodeClientConfiguration } from './client-schema.ts';
import { FileHost } from './host.ts';
import { decodeConfiguration, decodeNativeCapture, type WorkspaceConfiguration } from './schema.ts';

export type { WorkspaceConfiguration } from './schema.ts';
export type WorkspaceRecoveryConfiguration = { dataDirectory: string; installationId: string };

/**
 * The file host: approvals, reads, saves, file operations, Git, search and watching, with the
 * journals of the saves and operations it admitted. It keeps no client recovery. Scoped resources
 * only; the shared application composition root supplies the runtime. `now` is the journal clock.
 */
export function WorkspaceHostLive(configuration: WorkspaceConfiguration, now?: () => number) {
  const resources = Layer.effect(
    HostResources,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const config = yield* Effect.try({
          try: () => decodeConfiguration(configuration),
          catch: applicationError,
        });
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
            ),
          catch: (error) => applicationError(error, 'Persistence'),
        });
      }),
      (host) => host.close(),
    ),
  );
  return Layer.merge(
    Layer.effect(
      WorkspaceHostService,
      Effect.map(HostResources, (host) => host.service),
    ),
    Layer.effect(
      WorkspaceNative,
      Effect.map(HostResources, (host) => ({
        capture: (input: { checkout: CheckoutTarget; clientId: string; paths: string[] }) =>
          Effect.flatMap(
            Effect.try({ try: () => decodeNativeCapture(input), catch: applicationError }),
            (captured) =>
              host.effect(
                (signal) => host.references.capture(captured, signal),
                false,
                undefined,
                (references) => host.references.release({ ...captured, references }),
              ),
          ),
        release: (input: { checkout: CheckoutTarget; clientId: string; references: string[] }) =>
          Effect.try({ try: () => host.references.release(input), catch: applicationError }),
      })),
    ),
  ).pipe(Layer.provide(resources));
}

/**
 * One client's workspace over a file host: the editor's `WorkspaceService`, with this client's
 * recovery, intents and operation-feed cursor in `dataDirectory`. Compose it with the host in the
 * same process, or over a remote one. `installationId` names this client store to the host.
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
            catch: applicationError,
          });
          const parent = yield* Effect.scope;
          const operationScope = yield* Scope.fork(parent, 'parallel');
          const operations = yield* FiberSet.make<unknown, ApplicationError>().pipe(
            Scope.provide(operationScope),
          );
          return yield* Effect.try({
            try: () => new ClientWorkspace(config, { operations, operationScope }, host),
            catch: (error) => applicationError(error, 'Persistence'),
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
  configuration: WorkspaceConfiguration & { installationId: string },
  now?: () => number,
) {
  const { installationId, ...hostConfiguration } = configuration;
  return Layer.unwrap(
    Effect.map(WorkspaceHostService, (host) =>
      WorkspaceRecoveryLive({ dataDirectory: configuration.dataDirectory, installationId }, host),
    ),
  ).pipe(Layer.provideMerge(WorkspaceHostLive(hostConfiguration, now)));
}

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
