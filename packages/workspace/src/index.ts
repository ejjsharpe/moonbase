import { Context, Effect, Layer } from 'effect';
import { WorkspaceService, releaseResource } from '@moonbase/application/services';
import { ApplicationError, type CheckoutTarget } from '@moonbase/application/client';
import { LocalWorkspace } from './workspace.ts';
const applicationError = (error: unknown, code: ApplicationError['code'] = 'Unavailable') =>
  ApplicationError.is(error)
    ? error
    : new ApplicationError({ code, message: ApplicationError.fromUnknown(error).message });
export type WorkspaceConfiguration = {
  /** Explicit fresh Moonbase namespace, outside approved checkouts. Never a legacy store. */
  dataDirectory: string;
  /** Stable identity supplied by this local process's composition root. */
  hostId: string;
  /** Absolute paths allow the packaged shell to ship the native asset and select system Git. */
  filesystemHelper?: string;
  gitExecutable?: string;
  /** Packaged standalone ripgrep; PATH discovery is a development convenience. */
  ripgrepExecutable?: string;
};
/** Scoped resources only; the shared application composition root supplies the runtime. */
export function WorkspaceLive(configuration: WorkspaceConfiguration) {
  const resources = Layer.effect(
    LocalResources,
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => new LocalWorkspace(configuration),
        catch: (error) => applicationError(error, 'Persistence'),
      }),
      (workspace) => releaseResource(() => workspace.close()),
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
          workspace.effect((signal) => workspace.capture(input, signal)),
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
  }
>()('moonbase/WorkspaceNative') {}
class LocalResources extends Context.Service<LocalResources, LocalWorkspace>()(
  'moonbase/LocalWorkspaceResources',
) {}
