import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import { ApplicationError } from '@moonbase/application/client';
import { runApplicationEffect } from '@moonbase/application/effect-client';
import { RendererCleanup, releaseInstance } from '../src/renderer/cleanup.ts';

test('root cleanup retains failed/pending instance ownership while another namespace works and Quit drains', async () => {
  const runtime = ManagedRuntime.make(Layer.empty),
    scope = Scope.makeUnsafe('parallel');
  const cleanup = new RendererCleanup(runtime, scope),
    held = Promise.withResolvers<void>();
  cleanup.claim('chat');
  assert.throws(() => cleanup.claim('chat'), { code: 'Unavailable' });
  cleanup.claim('editor');
  let stopped = false,
    releases = 0,
    done = false;
  const close = cleanup.close('chat', () => {
    stopped = true;
    releases++;
    return held.promise;
  });
  assert.equal(stopped, true);
  assert.equal(
    cleanup.close('chat', () => {
      throw Error('must not repeat');
    }),
    close,
  );
  assert.equal(cleanup.available('chat'), false);
  assert.throws(() => cleanup.claim('chat'), { code: 'Unavailable' });
  await cleanup.close('editor', async () => {});
  assert.equal(cleanup.available('editor'), true);
  const quit = cleanup.drain();
  void quit.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await Promise.resolve();
  assert.equal(done, false);
  held.reject(new ApplicationError({ code: 'Persistence', message: 'Finalizer failed safely' }));
  await assert.rejects(close, { code: 'Persistence' });
  await assert.rejects(quit, { code: 'Persistence' });
  assert.equal(releases, 1);
  assert.equal(cleanup.available('chat'), false);
  assert.deepEqual(cleanup.getSnapshot().errors, ['Finalizer failed safely']);
  await runApplicationEffect(runtime, Scope.close(scope, Exit.void));
  await runtime.dispose();
});

test('a namespace can be explicitly reacquired only after successful cleanup', async () => {
  const runtime = ManagedRuntime.make(Layer.empty),
    scope = Scope.makeUnsafe();
  const cleanup = new RendererCleanup(runtime, scope),
    held = Promise.withResolvers<void>();
  const close = cleanup.close('chat', () => held.promise);
  assert.throws(() => cleanup.claim('chat'));
  held.resolve();
  await close;
  cleanup.claim('chat');
  await cleanup.close('chat', async () => {});
  await cleanup.drain();
  await runtime.runPromise(Scope.close(scope, Exit.void));
  await runtime.dispose();
});

for (const fail of [false, true]) {
  test(`instance acquisition finalizers release before aggregate shutdown (model failure: ${fail})`, async () => {
    const runtime = ManagedRuntime.make(Layer.empty),
      aggregate = Scope.makeUnsafe('parallel');
    let finalized = 0;
    const instance = Scope.forkUnsafe(aggregate, 'parallel');
    runtime.runSync(
      Scope.addFinalizer(
        instance,
        Effect.sync(() => {
          finalized++;
        }),
      ),
    );
    const cleanup = new RendererCleanup(runtime, aggregate);
    const result = cleanup.close('chat', () =>
      releaseInstance(runtime, instance, async () => {
        if (fail)
          throw new ApplicationError({ code: 'Persistence', message: 'Model cleanup failed' });
      }),
    );
    if (fail) await assert.rejects(result, { code: 'Persistence' });
    else await result;
    assert.equal(finalized, 1);
    assert.equal(
      await runtime.runPromise(Effect.succeed('another model works')),
      'another model works',
    );
    assert.equal(cleanup.available('chat'), !fail);
    await runtime.runPromise(Scope.close(aggregate, Exit.void));
    assert.equal(finalized, 1);
    await runtime.dispose();
  });
}
