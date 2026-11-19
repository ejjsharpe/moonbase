import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { ChatStoreError } from '@moonbase/contracts/chat-errors';
import { Harness } from '@earendil-works/pi-durable';
import { session, fixture, runChat } from '../runtime-fixture.ts';

test('atomic creation retries and actor/request immutable binding survive restart', async (t) => {
  const f = await fixture(t);
  const target = await f.create();
  assert.deepEqual(await f.create(), target);
  await assert.rejects(
    runChat(f.runtime, (chat) =>
      chat.createChat({
        session,
        requestId: 'create',
        title: 'Changed',
        settings: f.settings,
      }),
    ),
    { _tag: 'RequestReusedError' },
  );
  const list = await runChat(f.runtime, (chat) => chat.listChats({ session }));
  assert.equal(list.conversations.length, 1);
  await f.restart();
  assert.deepEqual(await f.create(), target);
  assert.equal(f.faux.state.callCount, 0);
  await assert.rejects(
    runChat(f.runtime, (chat) => chat.listChats({ session: { ...session, actorId: 'other' } })),
    { _tag: 'ChatAccessError', refusal: 'other-actor' },
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
    await runChat(f.runtime, (chat) => chat.getChatHost({ host: session.host }));
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
          ? new ChatStoreError({ problem: 'failed' })
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
      await runChat(f.runtime, (chat) => chat.createChat(input)).catch((error) => {
        failure = error;
      });
    } finally {
      mock.restoreAll();
      await off();
    }
    assert.equal(committed.length, 1);
    assert.equal(
      (await runChat(f.runtime, (chat) => chat.listChats({ session }))).conversations.length,
      1,
    );
    await f.restart();
    const recovered = await runChat(f.runtime, (chat) => chat.createChat(input));
    assert.equal(recovered.conversation.target.conversationId, committed[0]);
    assert.deepEqual(await runChat(f.runtime, (chat) => chat.createChat(input)), recovered);
    await assert.rejects(
      runChat(f.runtime, (chat) => chat.createChat({ ...input, title: 'Changed' })),
      { _tag: 'RequestReusedError' },
    );
    assert.equal(
      (await runChat(f.runtime, (chat) => chat.listChats({ session }))).conversations.length,
      1,
    );
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(
      (failure as { _tag?: string })?._tag,
      'UncertainError',
      'a real committed conversation appeared definitively rejected',
    );
  });
