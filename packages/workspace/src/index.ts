import { normalizeApplicationError } from '@moonbase/effect';
import { Context, Effect, FiberSet, Layer, Scope } from 'effect';
import { WorkspaceService } from '@moonbase/contracts/services';
import { ApplicationError, type CheckoutTarget } from '@moonbase/contracts/workspace';
import { LocalWorkspace } from './workspace.ts';
import {
  decodeConfiguration,
  decodeNativeCapture,
  type WorkspaceConfigurationSchema,
} from './schema.ts';
const applicationError = (error: unknown, code: ApplicationError['code'] = 'Unavailable') =>
  ApplicationError.is(error)
    ? error
    : new ApplicationError({ code, message: normalizeApplicationError(error).message });
export type WorkspaceConfiguration = typeof WorkspaceConfigurationSchema.Type;
/** Scoped resources only; the shared application composition root supplies the runtime. */
export function WorkspaceLive(configuration: WorkspaceConfiguration) {
  const resources = Layer.effect(
    LocalResources,
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
            new LocalWorkspace(config, {
              operations,
              operationScope,
              helperScope,
              referenceScope,
              observationScope,
              runHelper,
              startExpiry,
            }),
          catch: (error) => applicationError(error, 'Persistence'),
        });
      }),
      (workspace) => workspace.close(),
    ),
  );
  return Layer.merge(
    Layer.effect(
      WorkspaceService,
      Effect.map(LocalResources, (workspace) => workspace.service),
    ),
    Layer.effect(
      WorkspaceNative,
      Effect.map(LocalResources, (workspace) => ({
        capture: (input: { checkout: CheckoutTarget; clientId: string; paths: string[] }) =>
          Effect.flatMap(
            Effect.try({ try: () => decodeNativeCapture(input), catch: applicationError }),
            (captured) =>
              workspace.effect(
                (signal) => workspace.references.capture(captured, signal),
                false,
                undefined,
                (references) => workspace.references.release({ ...captured, references }),
              ),
          ),
        release: (input: { checkout: CheckoutTarget; clientId: string; references: string[] }) =>
          Effect.try({ try: () => workspace.references.release(input), catch: applicationError }),
      })),
    ),
  ).pipe(Layer.provide(resources));
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
class LocalResources extends Context.Service<LocalResources, LocalWorkspace>()(
  'moonbase/LocalWorkspaceResources',
) {}
