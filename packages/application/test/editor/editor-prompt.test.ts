import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit, Fiber, Scope, SubscriptionRef } from 'effect';
import { makeEditorPrompt } from '../../src/editor/editor-prompt.ts';

test('a second prompt is refused while one is shown, and closing the scope answers Cancel', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const prompt = yield* Scope.provide(
        makeEditorPrompt<{ id: string }, string>('cancel'),
        scope,
      );
      const shown = () => SubscriptionRef.getUnsafe(prompt.shown)?.id;

      const first = yield* Effect.forkChild(prompt.ask({ id: 'first' }), {
        startImmediately: true,
      });
      assert.equal(yield* prompt.ask({ id: 'second' }), 'cancel');
      assert.equal(shown(), 'first');
      yield* prompt.answer('first', 'save');
      assert.equal(yield* Fiber.join(first), 'save');
      assert.equal(shown(), undefined);

      const third = yield* Effect.forkChild(prompt.ask({ id: 'third' }), {
        startImmediately: true,
      });
      assert.equal(shown(), 'third');
      yield* Scope.close(scope, Exit.void);
      assert.equal(yield* Fiber.join(third), 'cancel');
      assert.equal(shown(), undefined);
    }),
  ));
