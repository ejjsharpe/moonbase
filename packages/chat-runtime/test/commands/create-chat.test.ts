import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { Harness } from '@earendil-works/pi-durable';
import { session, fixture } from '../runtime-fixture.ts';

test('atomic creation retries and actor/request immutable binding survive restart', async (t) => {
  const f = await fixture(t);
  const target = await f.create();
  assert.deepEqual(await f.create(), target);
  await assert.rejects(
    f.client.command('createChat', {
      session,
      requestId: 'create',
      title: 'Changed',
      settings: f.settings,
    }),
    { code: 'InvalidInput' },
  );
  const list = await f.client.command('listChats', { session });
  assert.equal(list.conversations.length, 1);
  await f.restart();
  assert.deepEqual(await f.create(), target);
  assert.equal(f.faux.state.callCount, 0);
  await assert.rejects(
    f.client.command('listChats', { session: { ...session, actorId: 'other' } }),
    { code: 'Unauthorized' },
  );
});
for (const typed of [false, true])
  test(`create reply-read failure after real commit is uncertain (${typed ? 'typed' : 'unknown'}) and exact retry survives restart`, async (t) => {
    const original = Harness.open;
    let harness: Harness | undefined;
    mock.method(
      Harness,
      'open',
      async (...args: Parameters<typeof original>) => (harness = await original(...args)),
    );
    const f = await fixture(t);
    await f.client.command('getChatHost', { host: session.host });
    mock.restoreAll();
    const committed: string[] = [];
    const off = harness!.subscribeCommits((publication) => {
      for (const change of publication.changes)
        if (change.type === 'conversation') committed.push(String(change.value.id));
    });
    const snapshot = harness!.snapshot.bind(harness!);
    let reads = 0;
    // The first read after the chat is committed fails.
    mock.method(harness!, 'snapshot', async (...args: Parameters<typeof snapshot>) => {
      if (committed.length && reads++ === 0)
        throw typed
          ? new ApplicationError({
              code: 'Persistence',
              message: 'Controlled post-commit read failure',
            })
          : Error('Controlled post-commit read failure');
      return snapshot(...args);
    });
    const input = {
      session,
      requestId: 'committed-create',
      title: 'Original saved chat',
      settings: f.settings,
    };
    let failure: unknown;
    try {
      await f.client.command('createChat', input).catch((error) => {
        failure = error;
      });
    } finally {
      mock.restoreAll();
      await off();
    }
    assert.equal(committed.length, 1);
    assert.equal((await f.client.command('listChats', { session })).conversations.length, 1);
    await f.restart();
    const recovered = await f.client.command('createChat', input);
    assert.equal(recovered.conversation.target.conversationId, committed[0]);
    assert.deepEqual(await f.client.command('createChat', input), recovered);
    await assert.rejects(f.client.command('createChat', { ...input, title: 'Changed' }), {
      code: 'InvalidInput',
    });
    assert.equal((await f.client.command('listChats', { session })).conversations.length, 1);
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(
      (failure as { code?: string })?.code,
      'Uncertain',
      'a real committed conversation appeared definitively rejected',
    );
  });
test('lost typed commit acknowledgement stays uncertain while a refused create stays definite', async (t) => {
  const original = Harness.open;
  let harness: Harness | undefined;
  mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof original>) => (harness = await original(...args)),
  );
  const f = await fixture(t);
  await f.client.command('getChatHost', { host: session.host });
  mock.restoreAll();
  const committed: string[] = [];
  const off = harness!.subscribeCommits((publication) => {
    for (const change of publication.changes)
      if (change.type === 'conversation') committed.push(String(change.value.id));
  });
  const commit = harness!.commit.bind(harness!);
  let calls = 0;
  mock.method(harness!, 'commit', async (...args: Parameters<typeof commit>) => {
    calls++;
    await commit(...args);
    throw new ApplicationError({
      code: 'Persistence',
      message: 'Controlled lost commit acknowledgement',
    });
  });
  const input = { session, requestId: 'lost-commit', title: 'Committed', settings: f.settings };
  try {
    await assert.rejects(
      f.client.command('createChat', { ...input, session: { ...session, actorId: 'other' } }),
      { code: 'Unauthorized' },
    );
    assert.equal(calls, 0);
    await assert.rejects(f.client.command('createChat', input), { code: 'Uncertain' });
  } finally {
    mock.restoreAll();
    await off();
  }
  assert.equal(committed.length, 1);
  await f.restart();
  const recovered = await f.client.command('createChat', input);
  assert.equal(recovered.conversation.target.conversationId, committed[0]);
  await assert.rejects(f.client.command('createChat', { ...input, title: 'Changed' }), {
    code: 'InvalidInput',
  });
  assert.equal((await f.client.command('listChats', { session })).conversations.length, 1);
  assert.equal(f.faux.state.callCount, 0);
});
