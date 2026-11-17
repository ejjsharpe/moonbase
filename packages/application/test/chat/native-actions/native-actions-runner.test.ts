import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deferred, Effect, Exit, Scope, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { makeNativeActions } from '@moonbase/application/chat';

test('two native actions run at once, a third is refused, and a success clears itself', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const actions = yield* makeNativeActions;
      const notice = () => SubscriptionRef.getUnsafe(actions.notice)?.text ?? null;
      const held = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      for (const gate of held) yield* actions.run(Deferred.await(gate), 'copy');
      assert.equal(notice(), 'Copying complete source…');
      yield* actions.run(Effect.void, 'open');
      assert.equal(notice(), 'Two native actions are still running. Wait for them to finish.');
      yield* Deferred.succeed(held[0]!, undefined);
      yield* Effect.yieldNow;
      assert.equal(notice(), 'Copied.');
      // A permit is free again; a failure says why and stays.
      yield* actions.run(Effect.fail(Error('The copy was refused.')), 'copy');
      assert.equal(notice(), 'The copy was refused.');
      yield* TestClock.adjust('5 seconds');
      assert.equal(notice(), 'The copy was refused.');
      yield* Deferred.succeed(held[1]!, undefined);
      yield* Effect.yieldNow;
      assert.equal(notice(), 'Copied.');
      yield* TestClock.adjust('4 seconds');
      assert.equal(notice(), null);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});

test('going offline cancels running actions, which then report nothing', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const actions = yield* makeNativeActions.pipe(Effect.provideService(Scope.Scope, scope));
      const aborted: boolean[] = [];
      const action = Effect.tryPromise({
        try: (signal) =>
          new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => {
              aborted.push(true);
              reject(Error('aborted'));
            }),
          ),
        catch: (error) => error,
      });
      // Nothing running: going offline says nothing.
      yield* actions.cancel;
      assert.equal(SubscriptionRef.getUnsafe(actions.notice), null);
      yield* actions.run(action, 'open');
      yield* actions.cancel;
      assert.deepEqual(aborted, [true]);
      assert.equal(
        SubscriptionRef.getUnsafe(actions.notice)?.text,
        'Native action cancelled because this view is offline. Reconnect and try again.',
      );
      // Closing the view's scope cancels what runs then, too.
      yield* actions.run(action, 'copy');
      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(aborted, [true, true]);
    }),
  );
});
