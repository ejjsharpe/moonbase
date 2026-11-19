import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit, Fiber, Scope, SubscriptionRef } from 'effect';
import { makeEditorPrompt } from '../../src/editor/editor-prompt.ts';

test('a prompt takes only its own answer, and closing its scope answers Cancel', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const prompt = yield* Scope.provide(
        makeEditorPrompt<{ id: string }, string>('cancel'),
        scope,
      );
      const shown = () => SubscriptionRef.getUnsafe(prompt.pending)?.prompt.id;

      const first = yield* Effect.forkChild(prompt.ask({ id: 'first' }), {
        startImmediately: true,
      });
      yield* prompt.answer('stale', 'save');
      assert.equal(shown(), 'first');
      yield* prompt.answer('first', 'save');
      assert.equal(yield* Fiber.join(first), 'save');
      assert.equal(shown(), undefined);

      const second = yield* Effect.forkChild(prompt.ask({ id: 'second' }), {
        startImmediately: true,
      });
      assert.equal(shown(), 'second');
      yield* Scope.close(scope, Exit.void);
      assert.equal(yield* Fiber.join(second), 'cancel');
      assert.equal(shown(), undefined);
    }),
  ));
