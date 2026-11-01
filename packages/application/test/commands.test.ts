import { Effect, Layer, ManagedRuntime, Stream, Queue } from 'effect';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApplicationError, emptyRecovery, type CheckoutTarget } from '../src/client.ts';
import { makeEditorClient } from '../src/runtime-client.ts';
import { WorkspaceService, type WorkspaceServiceShape } from '../src/services.ts';

const checkout: CheckoutTarget = {
  hostId: 'host',
  checkoutId: 'checkout',
  projectId: 'project',
  root: '/checkout',
  branch: 'main',
};
function fixture() {
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
              Effect.sync(() => {
                counts.interrupted++;
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
    watch: () =>
      Stream.callback((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            counts.subscriptions++;
            Queue.offerUnsafe(queue, { checkout, paths: [], ready: true });
            watching();
          }),
          () =>
            Effect.sync(() => {
              counts.unsubscribed++;
            }),
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
  return { counts, runtime, client: makeEditorClient(runtime), ready, started };
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
  const rejected = assert.rejects(pending);
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
    stop();
    await runtime.runPromise(Effect.yieldNow);
    assert.equal((await client.command('loadRecovery', { clientId: 'client' })).revision, 0);
  } finally {
    stop();
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
