import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import { createChatBackends } from '../src/main/chat-backends.ts';

test('chat backends join explicit local retry and revoke pending folder selection on document replacement', async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const session = { host: { hostId: 'local', storeId: 'store' }, actorId: 'owner' };
  const approved: string[] = [],
    released: string[] = [];
  let attempts = 0;
  type Dependencies = Parameters<typeof createChatBackends>[0];
  type Backend = NonNullable<Dependencies['localResult']['backend']>;
  // Only folder approval and owner release are exercised; no chat/provider command is dispatched.
  const backend = {
    session,
    chat: {},
    approveFolder: async (path: string) => {
      approved.push(path);
      return path;
    },
    providers: {
      releaseOwner: (owner: string) =>
        Effect.sync(() => {
          released.push(owner);
        }),
    },
    control: { setAdmissionsOpen() {}, hasActiveWork: () => Effect.succeed(false) },
  } as unknown as Backend;
  let completeRetry!: (result: Dependencies['localResult']) => void;
  let completePicker!: (path: string | null) => void;
  const owner = createChatBackends({
    runtime,
    localResult: {
      backend: null,
      error: new ApplicationError({ code: 'Unavailable', message: 'Not ready' }),
    },
    acquireLocal: () => {
      attempts++;
      return new Promise((resolve) => {
        completeRetry = resolve;
      });
    },
    chatConfiguration: null,
    remoteChat: null,
    connection: null,
    emit: () => {
      assert.fail('No observation should be started');
    },
    pickFolder: () =>
      new Promise((resolve) => {
        completePicker = resolve;
      }),
  });
  try {
    assert.equal(attempts, 0);
    assert.equal(owner.hasLocalChat(), false);
    assert.equal(owner.getSessions().length, 0);
    const first = owner.getContext('local'),
      second = owner.getContext('local');
    assert.equal(attempts, 1);
    completeRetry({ backend, error: null });
    assert.deepEqual(await first, session);
    assert.deepEqual(await second, session);
    assert.equal(owner.hasLocalChat(), true);
    assert.deepEqual(owner.getTargets()[0].context, session);
    assert.equal(owner.getSessions().length, 1);
    const previous = owner.getSession('local');
    const picking = owner.chooseFolder();
    await owner.releaseDocument();
    completePicker('/obsolete');
    assert.equal(await picking, null);
    assert.deepEqual(approved, []);
    assert.notEqual(owner.getSession('local'), previous);
    assert.equal(released.length, 1);
    const current = owner.chooseFolder();
    completePicker('/current');
    assert.equal(await current, '/current');
    assert.deepEqual(approved, ['/current']);
    await owner.getContext('local');
    assert.equal(attempts, 1);
    await owner.releaseDocument();
    assert.equal(released.length, 2);
    assert.notEqual(released[0], released[1]);
  } finally {
    for (const session of owner.getSessions()) await session.dispose();
    await runtime.dispose();
  }
});
