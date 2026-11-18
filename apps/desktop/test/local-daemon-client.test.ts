import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit, Scope } from 'effect';
import { makeLocalDaemonClient, type DaemonChat } from '../src/main/daemon/local-daemon-client.ts';

test('Quit releases what was built after the client while its clients, acquired later, still answer', async () => {
  const steps: string[] = [];
  let open = false;
  // The daemon's clients, which answer only while their scope is open.
  const backend = {
    workspace: {
      releaseImports: ({ references }: { references: string[] }) =>
        Effect.suspend(() => {
          if (!open) return Effect.die(new Error('The daemon link is closed.'));
          steps.push(`released ${references.join()}`);
          return Effect.void;
        }),
    },
  } as unknown as DaemonChat;
  const acquire = Effect.acquireRelease(
    Effect.sync(() => {
      open = true;
      return backend;
    }),
    () =>
      Effect.sync(() => {
        open = false;
        steps.push('clients closed');
      }),
  );
  // Main's services scope: the client first, then a document holding a captured import, as
  // `captureImports` registers it, and only then the first request that reaches the daemon.
  const services = Scope.makeUnsafe('sequential');
  const local = await Effect.runPromise(Scope.provide(makeLocalDaemonClient(acquire), services));
  await Effect.runPromise(
    Scope.addFinalizer(
      services,
      Effect.flatMap(local.peek, (bound) =>
        bound ? bound.workspace.releaseImports({ references: ['captured'] } as never) : Effect.void,
      ).pipe(Effect.orDie),
    ),
  );
  await Effect.runPromise(local.get);
  const closed = await Effect.runPromise(Effect.exit(Scope.close(services, Exit.void)));
  assert(Exit.isSuccess(closed), 'Quit releases everything without a cleanup failure');
  assert.deepEqual(steps, ['released captured', 'clients closed']);
  // Nothing reaches the released clients afterwards.
  assert.equal(await Effect.runPromise(local.peek), undefined);
  const after = await Effect.runPromise(Effect.flip(local.get));
  assert.equal(after.code, 'Unavailable');
});
