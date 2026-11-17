import { Effect, Exit, Layer, ManagedRuntime, Scope, type FileSystem } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import * as NodeServices from '@effect/platform-node/NodeServices';
import {
  makeCredentialStore,
  makeKeyEncryption,
  type CredentialEncryption,
  type CredentialKeySource,
} from '@moonbase/chat-runtime/credentials';

type Services = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

/**
 * Runs credential effects on the Node platform, in one scope that lives until the test ends, so a
 * store keeps serving the Promise calls Pi would make. `spawner` replaces the process spawner.
 */
export function makeCredentialsFixture(
  t: { after(fn: () => unknown): void },
  spawner?: (
    real: ChildProcessSpawner.ChildProcessSpawner['Service'],
  ) => ChildProcessSpawner.ChildProcessSpawner['Service'],
) {
  const replaced = spawner
    ? Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          return spawner(yield* ChildProcessSpawner.ChildProcessSpawner);
        }),
      ).pipe(Layer.provide(NodeServices.layer))
    : Layer.empty;
  // The later layer wins, so a replaced spawner stands in for Node's.
  const runtime = ManagedRuntime.make(Layer.merge(NodeServices.layer, replaced));
  const scope = Scope.makeUnsafe();
  t.after(async () => {
    try {
      await runtime.runPromise(Scope.close(scope, Exit.void));
    } finally {
      await runtime.dispose();
    }
  });
  const run = <A, E>(effect: Effect.Effect<A, E, Services | Scope.Scope>) =>
    runtime.runPromise(Scope.provide(scope)(effect));
  const encryption = (source: CredentialKeySource) => run(makeKeyEncryption(source));
  const store = (directory: string, encryption: CredentialEncryption) =>
    run(makeCredentialStore(directory, encryption));
  return {
    run,
    encryption,
    store,
    /** A store encrypting under `source`'s key, as the daemon composes one. */
    keyedStore: async (directory: string, source: CredentialKeySource) =>
      store(directory, await encryption(source)),
  };
}
