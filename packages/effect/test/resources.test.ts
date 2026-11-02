import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cause, Effect, Exit } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import {
  normalizeApplicationError,
  releaseResource,
  safeApplicationFailure,
} from '@moonbase/effect';

test('safe failures preserve owned identity and never inspect unknown diagnostics', () => {
  const owned = new ApplicationError({ code: 'Uncertain', message: 'Original outcome unknown' });
  assert.strictEqual(normalizeApplicationError(owned), owned);
  assert.strictEqual(safeApplicationFailure(owned, 'fallback'), owned);
  const privateFailure = new Proxy(
    {},
    {
      get() {
        throw Error('private diagnostic');
      },
    },
  );
  for (const value of [
    privateFailure,
    Error('private diagnostic'),
    { code: 'Conflict', message: 'private diagnostic' },
  ]) {
    assert.equal(normalizeApplicationError(value).message, 'Application effect failed');
    assert.equal(safeApplicationFailure(value, 'safe fallback').message, 'safe fallback');
  }
});

test('release awaits the held resource and retains a safe observable cleanup failure', async () => {
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let completed = false;
  const result = Effect.runPromiseExit(
    releaseResource(async () => {
      await held;
      throw Error('private release diagnostic');
    }),
  ).then((exit) => {
    completed = true;
    return exit;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  finish();
  const exit = await result;
  assert(Exit.isFailure(exit));
  assert(
    exit.cause.reasons.some(
      (reason) =>
        Cause.isDieReason(reason) &&
        ApplicationError.is(reason.defect) &&
        reason.defect.message === 'Application resource cleanup failed',
    ),
  );
});
