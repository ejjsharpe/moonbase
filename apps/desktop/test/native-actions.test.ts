import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Result } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { makeNativeActions } from '../src/main/native-actions.ts';
import { nativeActionsFixture } from './fixtures/native-actions-fixture.ts';

/** What an Effect's result succeeded with, or `failed`. */
const succeeded = <A, E>(result: Result.Result<A, E>) =>
  Result.isSuccess(result) ? result.success : 'failed';

test('clipboard imports ask only when Finder files are there, and read them only after consent', async () => {
  const f = nativeActionsFixture(new Uint8Array());
  const actions = await Effect.runPromise(
    makeNativeActions(f.options).pipe(Effect.provide(NodeServices.layer)),
  );
  const paste = () =>
    Effect.runPromise(Effect.result(actions.choosePaths(f.checkout, 'clipboard')));
  // A clipboard without Finder files has nothing to import or ask about, and isn't read.
  f.consent = 1;
  assert.deepEqual(succeeded(await paste()), []);
  assert.deepEqual([f.prompts, f.reads], [0, 0]);
  // Finder files are read only after consent; declining is told apart from having none.
  f.finderFiles = true;
  f.consent = 0;
  assert.deepEqual(succeeded(await paste()), null);
  assert.deepEqual([f.prompts, f.reads], [1, 0]);
  f.consent = 1;
  const empty = await paste();
  assert.equal(empty._tag === 'Failure' && empty.failure.code, 'InvalidInput');
  assert.deepEqual([f.prompts, f.reads], [2, 1]);
  assert.equal(await Effect.runPromise(actions.chooseCheckout), '/picked');
  assert.deepEqual(await Effect.runPromise(actions.choosePaths(f.checkout, 'picker')), ['/picked']);
  f.cancelled = true;
  assert.equal(await Effect.runPromise(actions.chooseCheckout), null);
  assert.deepEqual(await Effect.runPromise(actions.choosePaths(f.checkout, 'picker')), []);
});
