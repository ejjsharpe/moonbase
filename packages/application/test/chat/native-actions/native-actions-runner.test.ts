import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deferred, Effect, Exit, Scope, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { UnauthorizedError } from '@moonbase/contracts/errors';
import {
  busyNotice,
  doneNotice,
  makeNativeActions,
  offlineNotice,
  pendingNotice,
} from '@moonbase/application/chat';

test('two native actions run at once, a third is refused, and a success clears itself', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const actions = yield* makeNativeActions;
      const notice = () => SubscriptionRef.getUnsafe(actions.notice);
      const held = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      for (const gate of held) yield* actions.run(Deferred.await(gate), 'copy');
      assert.deepEqual(notice(), pendingNotice('copy'));
      yield* actions.run(Effect.void, 'open');
      assert.deepEqual(notice(), busyNotice);
      yield* Deferred.succeed(held[0]!, undefined);
      yield* Effect.yieldNow;
      assert.deepEqual(notice(), doneNotice('copy'));
      // A permit is free again; a failure says why and stays.
      yield* actions.run(Effect.fail(Error('The copy was refused.')), 'copy');
      const failed = notice();
      assert.equal(failed?.tone, 'error');
      yield* TestClock.adjust('5 seconds');
      assert.equal(notice(), failed);
      yield* Deferred.succeed(held[1]!, undefined);
      yield* Effect.yieldNow;
      assert.deepEqual(notice(), doneNotice('copy'));
      yield* TestClock.adjust('4 seconds');
      assert.equal(notice(), null);
      // A shared outcome shows the chat's fixed text, not the operation it names.
      yield* actions.run(
        Effect.fail(new UnauthorizedError({ operation: 'getChatTranscriptContent' })),
        'copy',
      );
      yield* Effect.yieldNow;
      assert.equal(notice()?.text, 'This request is not authorized.');
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
      assert.deepEqual(SubscriptionRef.getUnsafe(actions.notice), offlineNotice);
      // Closing the view's scope cancels what runs then, too.
      yield* actions.run(action, 'copy');
      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(aborted, [true, true]);
    }),
  );
});
