import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cause, Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import {
  normalizeApplicationError,
  runApplicationEffect,
  observeApplicationStream,
} from '@moonbase/application/runtime/effect-client';
import { releaseResource } from '@moonbase/effect';
import type { ObservationClose } from '@moonbase/contracts/common';

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

const privateDiagnostic = 'SYNTHETIC_PRIVATE_SENTINEL';
const target = {
  checkout: {
    hostId: 'host',
    checkoutId: 'checkout',
    projectId: 'project',
    root: '/checkout',
    branch: 'main',
  },
  path: 'file.txt',
};
function safeFailure(error: unknown, message: string) {
  assert(ApplicationError.is(error));
  assert.equal(error.code, 'Unavailable');
  assert.equal(error.message, message);
  assert(!String(error).includes(privateDiagnostic));
  assert(!JSON.stringify(error).includes(privateDiagnostic));
  assert.equal(error.target, undefined);
  return true;
}

test('unknown defects and raw Effect evidence never expose private diagnostics', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  let stringifications = 0;
  const rawError = new Error(privateDiagnostic);
  const fiberFailure = await runtime
    .runPromise(Effect.die(rawError))
    .catch((error: unknown) => error);
  const unknowns = [
    rawError,
    privateDiagnostic,
    Cause.die(rawError),
    fiberFailure,
    { _tag: 'ApplicationError', code: 'Uncertain', message: privateDiagnostic, target },
    {
      toString() {
        stringifications++;
        return privateDiagnostic;
      },
    },
  ];
  try {
    for (const unknown of unknowns) {
      await assert.rejects(runApplicationEffect(runtime, Effect.die(unknown)), (error) =>
        safeFailure(error, 'Application effect failed'),
      );
      const typed = new ApplicationError({
        code: 'Uncertain',
        message: 'Original mutation outcome remains uncertain',
        target,
      });
      await assert.rejects(
        runApplicationEffect(
          runtime,
          Effect.fail(typed).pipe(Effect.ensuring(Effect.die(unknown))),
        ),
        (error) => {
          assert(ApplicationError.is(error));
          assert.equal(error.code, typed.code);
          assert.strictEqual(error.target, target);
          assert.equal(error.message, `${typed.message}; Application effect failed`);
          assert(!String(error).includes(privateDiagnostic));
          assert(!JSON.stringify(error).includes(privateDiagnostic));
          return true;
        },
      );
    }
    assert.equal(stringifications, 0);
  } finally {
    await runtime.dispose();
  }
});

test('unknown cleanup failures cannot be rebranded into public private diagnostics', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const safeTyped = new ApplicationError({
    code: 'Persistence',
    message: 'Recovery release failed safely',
    target,
  });
  try {
    for (const release of [
      () => {
        throw new Error(privateDiagnostic);
      },
      () => Promise.reject(Cause.die(new Error(privateDiagnostic))),
    ]) {
      await assert.rejects(runApplicationEffect(runtime, releaseResource(release)), (error) =>
        safeFailure(error, 'Application resource cleanup failed'),
      );
      const uncertain = new ApplicationError({
        code: 'Uncertain',
        message: 'Mutation receipt missing',
        target,
      });
      await assert.rejects(
        runApplicationEffect(
          runtime,
          Effect.fail(uncertain).pipe(Effect.ensuring(releaseResource(release))),
        ),
        (error) => {
          assert(ApplicationError.is(error));
          assert.equal(error.code, 'Uncertain');
          assert.strictEqual(error.target, target);
          assert.equal(
            error.message,
            'Mutation receipt missing; Application resource cleanup failed',
          );
          assert(!JSON.stringify(error).includes(privateDiagnostic));
          return true;
        },
      );
    }
    await assert.rejects(
      runApplicationEffect(
        runtime,
        releaseResource(() => {
          throw safeTyped;
        }),
      ),
      (error) => error === safeTyped,
    );
  } finally {
    await runtime.dispose();
  }
});

test('unknown runner rejection and synchronous throws are redacted for commands and observations', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  try {
    for (const runPromiseExit of [
      () => Promise.reject(new Error(privateDiagnostic)),
      () => {
        throw Cause.die(new Error(privateDiagnostic));
      },
    ]) {
      const runner = { ...runtime, runPromiseExit };
      await assert.rejects(runApplicationEffect(runner, Effect.void), (error) =>
        safeFailure(error, 'Application effect failed'),
      );
      const close = observeApplicationStream(
        runner,
        Stream.never,
        () => {},
        () => {},
      );
      await assert.rejects(close(), (error) => safeFailure(error, 'Application effect failed'));
    }
  } finally {
    await runtime.dispose();
  }
});

test('active observation defects and deliberate-close cleanup failures are redacted', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const reported = event(),
    entered = event();
  const errors: ApplicationError[] = [];
  const close = observeApplicationStream(
    runtime,
    Stream.fromEffect(Effect.die(new Error(privateDiagnostic))),
    () => {},
    (error) => {
      errors.push(error);
      reported.resolve();
    },
  );
  try {
    await reported.promise;
    safeFailure(errors[0], 'Application effect failed');
    await assert.rejects(close(), (error) => error === errors[0]);
    const closeOwned = observeApplicationStream(
      runtime,
      Stream.unwrap(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(Effect.sync(entered.resolve), () =>
            releaseResource(() => {
              throw new Error(privateDiagnostic);
            }),
          );
          return Stream.never;
        }),
      ),
      () => {},
      (error) => errors.push(error),
    );
    await entered.promise;
    const completion = closeOwned();
    assert.strictEqual(closeOwned(), completion);
    await assert.rejects(completion, (error) =>
      safeFailure(error, 'Application resource cleanup failed'),
    );
    assert.equal(errors.length, 1);
  } finally {
    await runtime.dispose();
  }
});

test('public error normalizer preserves typed identity and safely adapts unknown Promise failures', async () => {
  const typed = new ApplicationError({
    code: 'Uncertain',
    message: 'Original mutation outcome remains uncertain',
    target,
  });
  assert.strictEqual(normalizeApplicationError(typed), typed);
  for (const value of [
    new Error(privateDiagnostic),
    Cause.die(new Error(privateDiagnostic)),
    { _tag: 'ApplicationError', code: 'Uncertain', message: privateDiagnostic, target },
    {
      toString() {
        throw new Error(privateDiagnostic);
      },
    },
  ]) {
    safeFailure(normalizeApplicationError(value), 'Application effect failed');
    const exit = await Effect.runPromiseExit(
      Effect.tryPromise({ try: () => Promise.reject(value), catch: normalizeApplicationError }),
    );
    assert.equal(exit._tag, 'Failure');
    if (exit._tag === 'Failure') {
      assert(Cause.hasFails(exit.cause));
      for (const reason of exit.cause.reasons)
        if (Cause.isFailReason(reason)) safeFailure(reason.error, 'Application effect failed');
    }
  }
});

test('a throwing receiver retains its failure when onError reenters close and throws', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const reported = event();
  const received: number[] = [];
  let closed: Promise<void> | undefined;
  let close: ObservationClose = async () => {};
  let failure: ApplicationError | undefined;
  close = observeApplicationStream(
    runtime,
    Stream.fromIterable([1, 2]),
    (value) => {
      received.push(value);
      throw new Error(privateDiagnostic);
    },
    (error) => {
      failure = error;
      closed = close();
      void closed.catch(() => {});
      reported.resolve();
      throw new Error(privateDiagnostic);
    },
  );
  try {
    await reported.promise;
    assert.deepEqual(received, [1]);
    assert.strictEqual(close(), closed);
    safeFailure(failure, 'Application effect failed');
    await assert.rejects(closed!, (error) => error === failure);
    assert.equal(await runApplicationEffect(runtime, Effect.succeed('still live')), 'still live');
  } finally {
    await close().catch(() => {});
    await runtime.dispose();
  }
});

test('receiver-driven close fences later events and joins held release without reacquisition', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const releasing = event(),
    gate = event();
  const received: number[] = [];
  let acquisitions = 0,
    releases = 0;
  let closed: Promise<void> | undefined;
  let close: ObservationClose = async () => {};
  close = observeApplicationStream(
    runtime,
    Stream.unwrap(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            acquisitions++;
          }),
          () =>
            releaseResource(async () => {
              releases++;
              releasing.resolve();
              await gate.promise;
            }),
        );
        return Stream.concat(Stream.fromIterable([1, 2]), Stream.never);
      }),
    ),
    (value) => {
      received.push(value);
      closed = close();
    },
    (error) => {
      throw error;
    },
  );
  try {
    await releasing.promise;
    assert.strictEqual(close(), closed);
    let settled = false;
    const completion = closed!.then(() => {
      settled = true;
    });
    await runtime.runPromise(Effect.yieldNow);
    assert.equal(settled, false);
    assert.deepEqual(received, [1]);
    assert.equal(acquisitions, 1);
    gate.resolve();
    await completion;
    assert.equal(releases, 1);
    assert.equal(await runApplicationEffect(runtime, Effect.succeed('still live')), 'still live');
  } finally {
    gate.resolve();
    await close();
    await runtime.dispose();
  }
});
