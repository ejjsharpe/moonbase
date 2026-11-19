import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit, Fiber, Result } from 'effect';
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
  assert.equal(empty._tag === 'Failure' && empty.failure.failure, 'no-finder-files');
  assert.deepEqual([f.prompts, f.reads], [2, 1]);
  assert.equal(await Effect.runPromise(actions.chooseCheckout), '/picked');
  assert.deepEqual(await Effect.runPromise(actions.choosePaths(f.checkout, 'picker')), ['/picked']);
  f.cancelled = true;
  assert.equal(await Effect.runPromise(actions.chooseCheckout), null);
  assert.deepEqual(await Effect.runPromise(actions.choosePaths(f.checkout, 'picker')), []);
});

test('a chat folder choice cancelled while the picker is open waits for it to close, and none opens once Quit is closing', async () => {
  const f = nativeActionsFixture(new Uint8Array());
  const shown: string[] = [];
  f.options.window = {
    isDestroyed: () => false,
    show: () => void shown.push('show'),
    focus: () => void shown.push('focus'),
  } as never;
  let close!: (result: { canceled: boolean; filePaths: string[] }) => void;
  let opened = 0;
  f.options.dialog.showOpenDialog = (() =>
    new Promise((resolve) => {
      // Only the first picker waits to be answered; a later one would choose at once.
      if (opened++) resolve({ canceled: false, filePaths: ['/late'] });
      else close = resolve;
    })) as typeof f.options.dialog.showOpenDialog;
  const actions = await Effect.runPromise(
    makeNativeActions(f.options).pipe(Effect.provide(NodeServices.layer)),
  );
  await Effect.runPromise(actions.surfacePickers);
  assert.deepEqual(shown, []);
  const choosing = Effect.runFork(actions.chooseFolder);
  await new Promise((resolve) => setImmediate(resolve));
  // Quit shows the window, so the user can answer the picker it waits for.
  await Effect.runPromise(actions.surfacePickers);
  assert.deepEqual(shown, ['show', 'focus']);
  let cancelled = false;
  const cancelling = Effect.runPromise(Fiber.interrupt(choosing)).then(() => {
    cancelled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, false);
  close({ canceled: false, filePaths: ['/obsolete'] });
  await cancelling;
  assert.equal(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(choosing))), true);
  await Effect.runPromise(actions.surfacePickers);
  assert.equal(shown.length, 2);
  // A request that reaches its picker after Quit surfaced the open ones answers as cancelled.
  f.closing = true;
  assert.equal(await Effect.runPromise(actions.chooseFolder), null);
  assert.equal(opened, 1);
});
