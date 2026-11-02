import { Effect, Exit, Fiber, Scope, type ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/application/client';
import {
  normalizeApplicationError,
  runApplicationEffect,
} from '@moonbase/application/effect-client';

type Task = { state: 'closing' | 'closed' | 'failed'; completion: Promise<void> };
/** Application-owned cleanup survives removal of an individual model's panel/scope. */
export class RendererCleanup {
  private tasks = new Map<string, Task>();
  private listeners = new Set<() => void>();
  private snapshot = { pending: [] as string[], errors: [] as string[] };
  private runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>;
  private scope: Scope.Scope;
  constructor(runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>, scope: Scope.Scope) {
    this.runtime = runtime;
    this.scope = scope;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(error?: unknown) {
    this.snapshot = {
      pending: [...this.tasks].filter(([, task]) => task.state === 'closing').map(([name]) => name),
      errors:
        error === undefined
          ? this.snapshot.errors
          : [...this.snapshot.errors, normalizeApplicationError(error).message.slice(0, 512)].slice(
              -4,
            ),
    };
    for (const listener of this.listeners) listener();
  }
  report(error: unknown) {
    this.publish(error);
  }
  claim(namespace: string) {
    const task = this.tasks.get(namespace);
    if (task && task.state !== 'closed')
      throw new ApplicationError({
        code: 'Unavailable',
        message: 'This panel still owns unfinished cleanup. Quit and recover before reopening it.',
      });
    this.tasks.delete(namespace);
  }
  available(namespace: string) {
    const task = this.tasks.get(namespace);
    return !task || task.state === 'closed';
  }
  close(namespace: string, dispose: () => Promise<void>): Promise<void> {
    const previous = this.tasks.get(namespace);
    if (previous) return previous.completion;
    // dispose fences model admissions synchronously, before the panel is removed.
    const disposal = dispose().then(() => undefined, normalizeApplicationError);
    const task: Task = { state: 'closing', completion: Promise.resolve() };
    this.tasks.set(namespace, task);
    task.completion = runApplicationEffect(
      this.runtime,
      Effect.promise(() => disposal).pipe(
        Effect.flatMap((error) => (error ? Effect.fail(error) : Effect.void)),
        Effect.forkIn(this.scope),
        Effect.flatMap(Fiber.join),
      ),
    ).then(
      () => {
        task.state = 'closed';
        this.publish();
      },
      (error) => {
        task.state = 'failed';
        this.publish(error);
        throw error;
      },
    );
    void task.completion.catch(() => {});
    this.publish();
    return task.completion;
  }
  async drain() {
    const results = await Promise.allSettled(
      [...this.tasks.values()].map((task) => task.completion),
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [normalizeApplicationError(result.reason)] : [],
    );
    if (errors.length)
      throw new ApplicationError({
        code: errors[0].code,
        message: errors
          .map((error) => error.message)
          .join('; ')
          .slice(0, 512),
      });
  }
}

/** Close the removable acquisition scope even when the model's own release fails. */
export function releaseInstance(
  runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>,
  scope: Scope.Closeable,
  dispose: () => Promise<void>,
): Promise<void> {
  const disposal = dispose();
  return (async () => {
    const failures: ApplicationError[] = [];
    for (const release of [
      () => disposal,
      () => runApplicationEffect(runtime, Scope.close(scope, Exit.void)),
    ]) {
      try {
        await release();
      } catch (error) {
        failures.push(normalizeApplicationError(error));
      }
    }
    if (failures.length)
      throw new ApplicationError({
        code: failures[0].code,
        message: failures.map((error) => error.message).join('; '),
      });
  })();
}
