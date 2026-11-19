import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit, Fiber, Scope } from 'effect';
import { makeEditorPrompt } from '../../src/editor/editor-prompt.ts';

test('a second prompt is refused while one is shown, and closing the scope answers Cancel and refuses later asks', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const prompt = yield* Scope.provide(
        makeEditorPrompt<{ id: string }, string>('cancel'),
        scope,
      );
      const shown = Effect.map(prompt.shown.get, (shown) => shown?.id);

      const first = yield* Effect.forkChild(prompt.ask({ id: 'first' }), {
        startImmediately: true,
      });
      assert.equal(yield* prompt.ask({ id: 'second' }), 'cancel');
      assert.equal(yield* shown, 'first');
      yield* prompt.answer('first', 'save');
      assert.equal(yield* Fiber.join(first), 'save');
      assert.equal(yield* shown, undefined);

      const third = yield* Effect.forkChild(prompt.ask({ id: 'third' }), {
        startImmediately: true,
      });
      assert.equal(yield* shown, 'third');
      yield* Scope.close(scope, Exit.void);
      assert.equal(yield* Fiber.join(third), 'cancel');
      assert.equal(yield* prompt.ask({ id: 'fourth' }), 'cancel');
      assert.equal(yield* shown, undefined);
    }),
  ));

test('an interrupted ask takes its prompt off screen', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const prompt = yield* makeEditorPrompt<{ id: string }, string>('cancel');
        const asked = yield* Effect.forkChild(prompt.ask({ id: 'first' }), {
          startImmediately: true,
        });
        yield* Fiber.interrupt(asked);
        assert.equal(yield* prompt.shown.get, null);
        // The next ask is admitted.
        const next = yield* Effect.forkChild(prompt.ask({ id: 'next' }), {
          startImmediately: true,
        });
        yield* prompt.answer('next', 'save');
        assert.equal(yield* Fiber.join(next), 'save');
      }),
    ),
  ));
