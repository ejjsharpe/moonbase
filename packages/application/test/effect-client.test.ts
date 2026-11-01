import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { ApplicationError } from '@moonbase/application/client';
import {
  runApplicationEffect,
  observeApplicationStream,
} from '@moonbase/application/effect-client';
import { releaseResource } from '@moonbase/application/services';

function event() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('two observers share a caller runtime; closing waits for finalization and fences delivery', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const started = event(),
    releasing = event(),
    gate = event();
  const applicationErrors: ApplicationError[] = [],
    activeErrors: ApplicationError[] = [];
  const received: number[] = [];
  const stream = Stream.unwrap(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.sync(started.resolve), () =>
        releaseResource(async () => {
          releasing.resolve();
          await gate.promise;
          throw new ApplicationError({ code: 'Persistence', message: 'Owned cleanup failed' });
        }),
      );
      return Stream.concat(Stream.succeed(1), Stream.never);
    }),
  );
  const close = observeApplicationStream(
    runtime,
    stream,
    (value) => received.push(value),
    (error) => activeErrors.push(error),
  );
  const other = observeApplicationStream(
    runtime,
    Stream.never,
    () => {},
    (error) => activeErrors.push(error),
  );
  try {
    await started.promise;
    const closing = close();
    assert.strictEqual(close(), closing);
    let settled = false;
    const ownedCleanup = closing
      .catch((error) => {
        assert(ApplicationError.is(error));
        applicationErrors.push(error);
      })
      .finally(() => {
        settled = true;
      });
    await releasing.promise;
    assert.equal(settled, false);
    assert.equal(
      await runApplicationEffect(runtime, Effect.succeed('another model works')),
      'another model works',
    );
    await other();
    gate.resolve();
    await ownedCleanup;
    assert.equal(settled, true);
    assert.equal(applicationErrors.length, 1);
    assert.equal(applicationErrors[0].code, 'Persistence');
    assert.deepEqual(activeErrors, []);
    const atClose = [...received];
    await runtime.runPromise(Effect.yieldNow);
    assert.deepEqual(received, atClose);
    await assert.rejects(close(), /Owned cleanup failed/);
    assert.equal(await runApplicationEffect(runtime, Effect.succeed(2)), 2);
  } finally {
    gate.resolve();
    await other();
    await runtime.dispose();
  }
});

test('public helper preserves typed identity, pre-abort and composite cleanup evidence', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const failure = new ApplicationError({ code: 'Uncertain', message: 'Possible admission' });
  let dispatched = false;
  try {
    await assert.rejects(
      runApplicationEffect(runtime, Effect.fail(failure)),
      (error) => error === failure,
    );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      runApplicationEffect(
        runtime,
        Effect.sync(() => {
          dispatched = true;
        }),
        { signal: abort.signal },
      ),
      (error) => ApplicationError.is(error) && error.code === 'Cancelled',
    );
    assert.equal(dispatched, false);
    await assert.rejects(
      runApplicationEffect(
        runtime,
        Effect.fail(failure).pipe(
          Effect.ensuring(
            releaseResource(() => {
              throw new ApplicationError({ code: 'Persistence', message: 'Release failed' });
            }),
          ),
        ),
      ),
      (error) =>
        ApplicationError.is(error) &&
        error.code === 'Uncertain' &&
        /Possible admission.*Release failed/.test(error.message),
    );
  } finally {
    await runtime.dispose();
  }
});

test('active observation failure is delivered safely and close retains its normalized outcome', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const reported = event();
  const errors: ApplicationError[] = [];
  const failure = new ApplicationError({ code: 'Unavailable', message: 'Observation failed' });
  const close = observeApplicationStream(
    runtime,
    Stream.fromEffect(Effect.fail(failure)),
    () => {},
    (error) => {
      errors.push(error);
      reported.resolve();
    },
  );
  try {
    await reported.promise;
    assert.deepEqual(errors, [failure]);
    await assert.rejects(close(), (error) => error === failure);
  } finally {
    await runtime.dispose();
  }
});

test('unexpected runner rejection is normalized at invocation and observation boundaries', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const rejection = new ApplicationError({ code: 'Unavailable', message: 'Runner unavailable' });
  const rejecting = { ...runtime, runPromiseExit: () => Promise.reject(rejection) };
  try {
    await assert.rejects(
      runApplicationEffect(rejecting, Effect.void),
      (error) => error === rejection,
    );
    const close = observeApplicationStream(
      rejecting,
      Stream.never,
      () => {},
      () => {},
    );
    await assert.rejects(close(), (error) => error === rejection);
  } finally {
    await runtime.dispose();
  }
});
