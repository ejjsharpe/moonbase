import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { Effect, Result } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { makeNativeActions } from '../../src/main/native-actions.ts';
import { nativeActionsFixture } from '../fixtures/native-actions-fixture.ts';

/** What an Effect's result succeeded with, or `failed`. */
const succeeded = <A, E>(result: Result.Result<A, E>) =>
  Result.isSuccess(result) ? result.success : 'failed';

test('Finder files on the clipboard are read through plutil, and a list that is not one is refused', async () => {
  const plist = (value: unknown) =>
    new Uint8Array(
      execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', '-', '-'], {
        input: JSON.stringify(value),
      }),
    );
  for (const [value, expected] of [
    [
      ['/Users/me/a.txt', '/Users/me/b c'],
      ['/Users/me/a.txt', '/Users/me/b c'],
    ],
    [{ not: 'a list' }, 'InvalidInput'],
  ] as const) {
    const f = nativeActionsFixture(plist(value));
    f.finderFiles = true;
    f.consent = 1;
    const actions = await Effect.runPromise(
      makeNativeActions(f.options).pipe(Effect.provide(NodeServices.layer)),
    );
    const result = await Effect.runPromise(
      Effect.result(actions.choosePaths(f.checkout, 'clipboard')),
    );
    if (typeof expected === 'string')
      assert.equal(result._tag === 'Failure' && result.failure.code, expected);
    else assert.deepEqual(succeeded(result), expected);
  }
});
