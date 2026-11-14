import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cause, Effect, Exit } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import { normalizeApplicationError, releaseResource, toApplicationError } from '@moonbase/effect';

const owned = new ApplicationError({ code: 'Uncertain', message: 'Original outcome unknown' });
const fallback = new ApplicationError({ code: 'Persistence', message: 'safe fallback' });

test('the normalizer keeps an application error and never inspects unknown diagnostics', () => {
  assert.strictEqual(normalizeApplicationError(owned), owned);
  assert.strictEqual(normalizeApplicationError(owned, fallback), owned);
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
    { _tag: 'ApplicationError', code: 'Conflict', message: 'private diagnostic' },
  ]) {
    assert.equal(normalizeApplicationError(value).code, 'Unavailable');
    assert.notEqual(normalizeApplicationError(value).message, 'private diagnostic');
    assert.strictEqual(normalizeApplicationError(value, fallback), fallback);
  }
});

test('a finished Effect becomes Cancelled, its application error, a combination keeping its code, or the fallback', async () => {
  const interrupted = await Effect.runPromiseExit(Effect.interrupt);
  const failed = await Effect.runPromiseExit(Effect.fail(owned));
  const died = await Effect.runPromiseExit(Effect.die(Error('private diagnostic')));
  const both = await Effect.runPromiseExit(
    Effect.failCause(Cause.combine(Cause.fail(owned), Cause.die(Error('private diagnostic')))),
  );
  assert(Exit.isFailure(interrupted) && Exit.isFailure(failed));
  assert(Exit.isFailure(died) && Exit.isFailure(both));
  assert.equal(toApplicationError(interrupted.cause, fallback).code, 'Cancelled');
  assert.strictEqual(toApplicationError(failed.cause, fallback), owned);
  assert.strictEqual(toApplicationError(died.cause, fallback), fallback);
  const combined = toApplicationError(both.cause, fallback);
  assert.equal(combined.code, owned.code);
  assert.equal(combined.message, `${owned.message}; ${fallback.message}`);
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
