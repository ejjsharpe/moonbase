import { Effect, Fiber, type ManagedRuntime } from 'effect';
import { WorkspaceService, type WorkspaceServiceShape } from '@moonbase/contracts/services';

/** A runtime that provides a `WorkspaceService`, as a test drives it. */
type WorkspaceRuntime = Pick<
  ManagedRuntime.ManagedRuntime<WorkspaceService, unknown>,
  'runPromise' | 'runFork'
>;
/** Runs `use` of a runtime's `WorkspaceService`: its value, or a rejection with its error itself. */
export type WorkspaceRunner = <A, E>(
  use: (workspace: WorkspaceServiceShape) => Effect.Effect<A, E>,
  options?: { signal?: AbortSignal },
) => Promise<A>;

/** `runtime`'s workspace runner, for a Promise test. */
export const makeWorkspaceRunner =
  (runtime: WorkspaceRuntime): WorkspaceRunner =>
  (use, options) =>
    runtime.runPromise(Effect.flatMap(WorkspaceService, use), options);

/** Forks `use` (a watch, say) of `runtime`'s workspace; the returned close interrupts it. */
export function forkWorkspace<A, E>(
  runtime: WorkspaceRuntime,
  use: (workspace: WorkspaceServiceShape) => Effect.Effect<A, E>,
) {
  const fiber = runtime.runFork(Effect.flatMap(WorkspaceService, use));
  return () => runtime.runPromise(Fiber.interrupt(fiber)).then(() => undefined);
}
