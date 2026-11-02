import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import {
  ApplicationError,
  emptyRecovery,
  type CheckoutTarget,
  type WorkspaceEvent,
} from '../src/client.ts';
import { WorkspaceService, releaseResource, type WorkspaceServiceShape } from '../src/services.ts';
import { makeEditorClient } from '@moonbase/application/runtime/clients';

const checkout: CheckoutTarget = {
  hostId: 'host',
  checkoutId: 'checkout',
  projectId: 'project',
  root: '/checkout',
  branch: 'main',
};
function fixture(
  failures: {
    watchCleanup?: Error;
    commandCleanup?: Error;
    watchAcquisition?: Effect.Effect<void>;
  } = {},
) {
  const counts = {
    acquired: 0,
    released: 0,
    subscriptions: 0,
    unsubscribed: 0,
    reads: 0,
    interrupted: 0,
  };
  let watching!: () => void;
  const ready = new Promise<void>((resolve) => {
    watching = resolve;
  });
  let entering!: () => void;
  const acquiring = new Promise<void>((resolve) => {
    entering = resolve;
  });
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const unavailable = () =>
    Effect.fail(
      new ApplicationError({ code: 'Unavailable', message: 'Unused fixture capability' }),
    );
  const service: WorkspaceServiceShape = {
    openCheckout: () => Effect.succeed(checkout),
    readFile: (input) =>
      Effect.gen(function* () {
        counts.reads++;
        if (input.path === 'slow') {
          reading();
          yield* Effect.never.pipe(
            Effect.ensuring(
              releaseResource(() => {
                counts.interrupted++;
                if (failures.commandCleanup) throw failures.commandCleanup;
              }),
            ),
          );
        }
        return { text: input.path, version: String(counts.reads) };
      }),
    loadRecovery: ({ clientId }) =>
      Effect.succeed({ revision: 0, state: emptyRecovery(clientId), errors: [], operations: [] }),
    saveFile: unavailable,
    listDirectory: unavailable,
    gitStatus: unavailable,
    readComparison: unavailable,
    lookupFiles: unavailable,
    inspectEntries: unavailable,
    mutate: unavailable,
    operationStatus: unavailable,
    acknowledgeOperation: unavailable,
    persistRecovery: unavailable,
    getRecoveryPublication: unavailable,
    watch: () =>
      Stream.unwrap(
        Effect.as(
          Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                counts.subscriptions++;
                entering();
              });
              yield* failures.watchAcquisition ?? Effect.void;
              yield* Effect.sync(() => {
                watching();
              });
            }),
            () =>
              releaseResource(() => {
                counts.unsubscribed++;
                if (failures.watchCleanup) throw failures.watchCleanup;
              }),
          ),
          Stream.concat(
            Stream.succeed<WorkspaceEvent>({ checkout, paths: [], ready: true }),
            Stream.never,
          ),
        ),
      ),
  };
  const layer = Layer.effect(
    WorkspaceService,
    Effect.acquireRelease(
      Effect.sync(() => {
        counts.acquired++;
        return service;
      }),
      () =>
        Effect.sync(() => {
          counts.released++;
        }),
    ),
  );
  const runtime = ManagedRuntime.make(layer);
  return { counts, service, runtime, client: makeEditorClient(runtime), ready, started, acquiring };
}

test('public clients share one acquired service and release it at the process scope', async () => {
  const { counts, runtime, client } = fixture();
  const second = makeEditorClient(runtime);
  try {
    assert.deepEqual(await client.command('openCheckout', { root: '/checkout' }), checkout);
    assert.equal((await client.command('readFile', { checkout, path: 'a' })).text, 'a');
    assert.equal((await second.command('readFile', { checkout, path: 'b' })).version, '2');
    assert.equal(counts.acquired, 1);
  } finally {
    await runtime.dispose();
  }
  assert.equal(counts.released, 1);
  await assert.rejects(client.command('openCheckout', { root: '/checkout' }));
});

test('cancelling one command leaves unrelated queries usable', async () => {
  const { counts, runtime, client, started } = fixture();
  const abort = new AbortController();
  const pending = client.command('readFile', { checkout, path: 'slow' }, { signal: abort.signal });
  const rejected = assert.rejects(
    pending,
    (error) => error instanceof ApplicationError && error.code === 'Cancelled',
  );
  try {
    await started;
    assert.equal(
      (await client.command('loadRecovery', { clientId: 'independent' })).state.clientId,
      'independent',
    );
    abort.abort();
    await rejected;
    assert.equal(counts.interrupted, 1);
    assert.equal((await client.command('readFile', { checkout, path: 'next' })).text, 'next');
  } finally {
    abort.abort();
    await runtime.dispose();
  }
});

test('ending a view subscription disposes its listener without ending the service', async () => {
  const { counts, runtime, client, ready } = fixture();
  let received!: () => void;
  const event = new Promise<void>((resolve) => {
    received = resolve;
  });
  const stop = client.watch(
    { checkout, paths: [''] },
    (value) => {
      assert.equal(value.ready, true);
      received();
    },
    (error) => {
      throw error;
    },
  );
  try {
    await ready;
    await event;
    await stop();
    await runtime.runPromise(Effect.yieldNow);
    assert.equal((await client.command('loadRecovery', { clientId: 'client' })).revision, 0);
  } finally {
    await stop();
    await runtime.dispose();
  }
  assert.equal(counts.subscriptions, 1);
  assert.equal(counts.unsubscribed, 1);
  assert.equal(counts.released, 1);
});

test('typed service failure crosses the same public command boundary', async () => {
  const { runtime, client } = fixture();
  try {
    await assert.rejects(
      client.command('gitStatus', { checkout }),
      (error) => error instanceof ApplicationError && error.code === 'Unavailable',
    );
  } finally {
    await runtime.dispose();
  }
});

test('unsubscribe rejects with a failing finalizer without duplicate active delivery', async () => {
  const { counts, runtime, client, ready } = fixture({
    watchCleanup: Error('Watch cleanup failed'),
  });
  const errors: ApplicationError[] = [];
  const stop = client.watch(
    { checkout, paths: [''] },
    () => {},
    (error) => errors.push(error),
  );
  await ready;
  const close = stop();
  assert.strictEqual(stop(), close);
  await assert.rejects(
    close,
    (error) =>
      ApplicationError.is(error) &&
      error.code === 'Unavailable' &&
      /Application resource cleanup failed/.test(error.message),
  );
  await runtime.dispose();
  assert.equal(counts.unsubscribed, 1);
  assert.deepEqual(errors, []);
});

test('command cancellation preserves a failing cleanup instead of labelling it cancelled', async () => {
  const { runtime, client, started } = fixture({ commandCleanup: Error('Read cleanup failed') });
  const abort = new AbortController();
  const pending = client.command('readFile', { checkout, path: 'slow' }, { signal: abort.signal });
  const rejected = assert.rejects(
    pending,
    (error) =>
      error instanceof ApplicationError &&
      error.code === 'Unavailable' &&
      /Application resource cleanup failed/.test(error.message),
  );
  try {
    await started;
    abort.abort();
    await rejected;
  } finally {
    abort.abort();
    await runtime.dispose();
  }
});

for (const concurrentDispose of [false, true])
  test(`pending watch acquisition retains cleanup failure; concurrent disposal=${concurrentDispose}`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime, client, counts, acquiring } = fixture({
      watchAcquisition: Effect.promise(() => gate),
      watchCleanup: Error('Pending watch cleanup failed'),
    });
    const errors: ApplicationError[] = [];
    const stop = client.watch(
      { checkout, paths: [''] },
      () => {},
      (error) => {
        errors.push(error);
      },
    );
    await acquiring;
    const close = assert.rejects(stop(), /Application resource cleanup failed/);
    const disposal = concurrentDispose ? runtime.dispose() : undefined;
    release();
    await disposal;
    await close;
    await runtime.dispose();
    assert.equal(counts.unsubscribed, 1);
    assert.deepEqual(errors, []);
  });

test('unprintable defects reach command and watch application error boundaries', async () => {
  const { service, runtime, client } = fixture();
  const defect = Object.create(null);
  service.gitStatus = () => Effect.die(defect);
  service.watch = () => Stream.fromEffect(Effect.die(defect));
  try {
    await assert.rejects(
      client.command('gitStatus', { checkout }),
      (error) => error instanceof ApplicationError && error.code === 'Unavailable',
    );
    const errors: ApplicationError[] = [];
    client.watch(
      { checkout, paths: [''] },
      () => {},
      (error) => {
        errors.push(error);
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'Unavailable');
  } finally {
    await runtime.dispose();
  }
});

test('an already-aborted command is rejected before runtime acquisition or service dispatch', async () => {
  const { service, counts, runtime, client } = fixture();
  let saves = 0;
  service.saveFile = () =>
    Effect.sync(() => {
      saves++;
      return { kind: 'saved', disk: { text: 'text', version: 'new' }, recoveryChanges: [] };
    });
  const abort = new AbortController();
  abort.abort();
  try {
    await assert.rejects(
      client.command(
        'saveFile',
        {
          target: { checkout, path: 'a' },
          clientId: 'client',
          requestId: 'request',
          text: 'text',
          expectedVersion: 'old',
        },
        { signal: abort.signal },
      ),
      (error) => error instanceof ApplicationError && error.code === 'Cancelled',
    );
    assert.equal(saves, 0);
    assert.equal(counts.acquired, 0);
  } finally {
    await runtime.dispose();
  }
});

for (const cleanup of ['ensuring', 'scoped'])
  for (const proxy of [false, true])
    test(`combined ${cleanup} failures retain uncertainty and exact target; proxy=${proxy}`, async () => {
      const { service, runtime, client } = fixture();
      const target = { checkout, path: 'a.txt' };
      const failure = Effect.fail(
        new ApplicationError({ code: 'Uncertain', message: 'File outcome uncertain', target }),
      );
      const defect = proxy
        ? new Proxy(Error('Cleanup also failed'), {
            getPrototypeOf() {
              throw Error('Cleanup prototype trap');
            },
          })
        : Error('Cleanup also failed');
      const finalizer = releaseResource(
        cleanup === 'ensuring'
          ? () => {
              throw defect;
            }
          : () => Promise.reject(defect),
      );
      const combined =
        cleanup === 'ensuring'
          ? failure.pipe(Effect.ensuring(finalizer))
          : Effect.scoped(
              Effect.gen(function* () {
                yield* Effect.acquireRelease(Effect.void, () => finalizer);
                return yield* failure;
              }),
            );
      service.gitStatus = () => combined;
      service.watch = () => Stream.fromEffect(combined);
      try {
        await assert.rejects(client.command('gitStatus', { checkout }), (error) => {
          assert(error instanceof ApplicationError);
          assert.equal(error.code, 'Uncertain');
          assert.deepEqual(error.target, target);
          assert.match(error.message, /Application resource cleanup failed/);
          return true;
        });
        const errors: ApplicationError[] = [];
        client.watch(
          { checkout, paths: [''] },
          () => {},
          (error) => {
            errors.push(error);
          },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(errors.length, 1);
        assert.equal(errors[0].code, 'Uncertain');
        assert.deepEqual(errors[0].target, target);
        assert.match(errors[0].message, /Application resource cleanup failed/);
      } finally {
        await runtime.dispose();
      }
    });
