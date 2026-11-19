import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope, SubscriptionRef } from 'effect';
import { ChatActions, ChatConfig } from '@moonbase/application/chat';
import { listActive } from '../../../src/chat/actions/actions.ts';

const config = Layer.succeed(ChatConfig, {
  connection: undefined,
} as unknown as ChatConfig['Service']);

test('closing the chat interrupts its actions, which settle without reporting, and admits nothing after', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(Layer.provide(ChatActions.layer, config), scope);
      const actions = Context.get(context, ChatActions);
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const caller = yield* Effect.forkChild(
        actions.run(
          'send',
          Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        ),
      );
      yield* Deferred.await(started);
      assert.deepEqual(listActive(yield* SubscriptionRef.get(actions.state)), ['send']);

      yield* Scope.close(scope, Exit.void);
      yield* Deferred.await(interrupted);
      yield* Fiber.join(caller);
      const closed = yield* SubscriptionRef.get(actions.state);
      assert.deepEqual(closed.counts, {});
      assert.equal(closed.error, null);

      let ran = false;
      yield* actions.run(
        'late',
        Effect.sync(() => {
          ran = true;
        }),
      );
      assert.equal(ran, false);
    }),
  ));
