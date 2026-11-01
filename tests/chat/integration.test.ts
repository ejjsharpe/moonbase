import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import type { ApplicationError } from '@moonbase/application/client';
import type { ChatSnapshot } from '@moonbase/application/chat-client';
import { controlledHostFixture, until } from './fixture.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }, hold = false) {
  const f = await controlledHostFixture(new URL('./host.mjs', import.meta.url), hold);
  t.after(async () => {
    await f.close();
  });
  return f;
}

test('combined public root requires explicit verified Connect, then saves/lists/streams a chat through controlled forwarding', async (t) => {
  const f = await fixture(t),
    client = f.root();
  assert.equal((await client.connection.command('getConnection', {})).state, 'disconnected');
  await assert.rejects(client.chat.command('getChatHost', { host: f.session.host }), {
    code: 'Unavailable',
  });
  const connected = await client.connection.command('connect', { profileId: client.profile.id });
  assert.equal(connected.state, 'connected');
  assert(!JSON.stringify(connected).includes(f.token));
  assert(!JSON.stringify(connected).includes('http://'));
  assert.equal((await client.chat.command('getChatHost', { host: f.session.host })).cwd, f.cwd);
  const input = { session: f.session, requestId: 'create-one', title: 'Saved remote chat' };
  const created = await client.chat.command('createChat', input);
  assert.deepEqual(await client.chat.command('createChat', input), created);
  assert.equal(
    (await client.chat.command('listChats', { session: f.session })).conversations.length,
    1,
  );
  const target = created.conversation.target,
    snapshots: ChatSnapshot[] = [],
    errors: ApplicationError[] = [];
  const unsubscribe = client.chat.watch(
    { target },
    (value) => snapshots.push(value),
    (error) => errors.push(error),
  );
  await client.chat.command('sendChat', { target, requestId: 'send-one', text: 'Send once' });
  await until(
    () => client.chat.command('getChat', { target }),
    (value) => !value.run && value.entries.some((entry) => entry.text === 'REMOTE COMPLETED'),
  );
  await until(
    async () => snapshots,
    (value) =>
      value.some((snapshot) => snapshot.entries.some((entry) => entry.text === 'REMOTE COMPLETED')),
  );
  unsubscribe();
  assert.deepEqual(errors, []);
  assert.equal((await f.stats()).calls, 1);
  const children = (await readFile(f.log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: string });
  assert.equal(
    children.filter((row) => row.event === 'forward').length,
    1,
    'Chat and Connection clients share one acquired transport',
  );
});

test('lost HTTP Send response and client closure retain original receipt; reconnect/store reopen do not Send again', async (t) => {
  const f = await fixture(t, true),
    first = f.root();
  await first.connection.command('connect', { profileId: first.profile.id });
  const created = await first.chat.command('createChat', {
      session: f.session,
      requestId: 'create',
      title: 'Retained',
    }),
    target = created.conversation.target;
  const input = { target, requestId: 'immutable-send', text: 'Only one admitted input' };
  await f.loseNextSend();
  await assert.rejects(first.chat.command('sendChat', input), { code: 'Uncertain' });
  await until(f.stats, (value) => value.calls === 1);
  await first.runtime.dispose();
  f.release();
  const second = f.root();
  await second.connection.command('connect', { profileId: second.profile.id });
  const receipt = await second.chat.command('getChatSend', { target, requestId: input.requestId });
  assert.equal(receipt?.admission, 'admitted');
  await until(
    () => second.chat.command('getChat', { target }),
    (value) => !value.run && value.entries.some((entry) => entry.text === 'REMOTE COMPLETED'),
  );
  assert.equal((await f.stats()).commands.filter((name) => name === 'sendChat').length, 1);
  assert.equal(
    (await readFile(f.log, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('drop-send-response')).length,
    1,
  );
  await second.runtime.dispose();
  await f.stopHost();
  await f.startHost();
  const third = f.root();
  await third.connection.command('connect', { profileId: third.profile.id });
  assert.deepEqual(
    await third.chat.command('getChatSend', { target, requestId: input.requestId }),
    receipt,
  );
  const state = await third.chat.command('getChat', { target });
  assert.equal(
    state.entries.filter((entry) => entry.role === 'user' && entry.text === input.text).length,
    1,
  );
  assert.equal((await f.stats()).calls, 0);
});

test('disconnect denies commands without implicit reconnect; stale Disconnect and captured cooperative Stop preserve exact generations', async (t) => {
  const f = await fixture(t, true),
    first = f.root();
  const old = await first.connection.command('connect', { profileId: first.profile.id });
  assert.equal(old.state, 'connected');
  const created = await first.chat.command('createChat', {
      session: f.session,
      requestId: 'create',
      title: 'Stop exact work',
    }),
    target = created.conversation.target;
  await first.chat.command('sendChat', { target, requestId: 'send', text: 'Held work' });
  const run = await until(
      () => first.chat.command('getChat', { target }),
      (state) => !!state.run,
    ),
    stop = run.run!.stop;
  await first.connection.command('disconnect', { connectionId: old.connectionId! });
  await assert.rejects(first.chat.command('getChat', { target }), { code: 'Unavailable' });
  assert.equal((await first.connection.command('getConnection', {})).state, 'disconnected');
  const current = await first.connection.command('connect', { profileId: first.profile.id });
  assert.notEqual(current.connectionId, old.connectionId);
  await assert.rejects(
    first.connection.command('disconnect', { connectionId: old.connectionId! }),
    { code: 'Conflict' },
  );
  assert.equal((await first.connection.command('getConnection', {})).state, 'connected');
  const result = await first.chat.command('stopChat', { stop, requestId: 'stop-exact' });
  assert.deepEqual(result.stop, stop);
  assert(['pending', 'stopped', 'terminal'].includes(result.outcome));
  f.release();
  await until(
    () => first.chat.command('getChat', { target }),
    (value) => value.run === null,
  );
  assert.equal((await f.stats()).commands.filter((name) => name === 'sendChat').length, 1);
});

test('a signed health reply for another exact host cannot connect or expose a chat endpoint', async (t) => {
  const f = await fixture(t),
    wrong = f.root({ ...f.session.host, hostId: 'other-host' });
  await assert.rejects(wrong.connection.command('connect', { profileId: wrong.profile.id }), {
    code: 'Incompatible',
  });
  assert.equal((await wrong.connection.command('getConnection', {})).state, 'failed');
  await assert.rejects(wrong.chat.command('getChatHost', { host: wrong.profile.expected }));
  assert.equal((await f.stats()).calls, 0);
  assert((await f.stats()).commands.every((name) => name === 'getChatHost'));
});

for (const operation of ['createChat', 'sendChat', 'stopChat'] as const)
  test(`Disconnect after committed ${operation} preserves uncertainty and original identity across real forwarding teardown`, async (t) => {
    const f = await fixture(t, true),
      client = f.root();
    const connected = await client.connection.command('connect', { profileId: client.profile.id });
    const create = {
      session: f.session,
      requestId: 'captured-create',
      title: 'Captured conversation',
    };
    const created =
      operation === 'createChat' ? undefined : await client.chat.command('createChat', create);
    const target = created?.conversation.target;
    const send = {
      target: target!,
      requestId: 'captured-send',
      text: 'Exactly one admitted input',
    };
    const stop =
      operation === 'stopChat'
        ? await (async () => {
            await client.chat.command('sendChat', send);
            return (
              await until(
                () => client.chat.command('getChat', { target: target! }),
                (value) => !!value.run?.stop.taskId,
              )
            ).run!.stop;
          })()
        : undefined;
    await f.holdReply(operation);
    let work;
    if (operation === 'createChat') work = client.chat.command('createChat', create);
    else if (operation === 'sendChat') work = client.chat.command('sendChat', send);
    else work = client.chat.command('stopChat', { stop: stop!, requestId: 'captured-stop' });
    const outcome = work.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await until(f.stats, (value) => value.heldReplies.includes(operation));
    assert.equal(
      (await client.connection.command('getConnection', {})).state,
      'connected',
      'unrelated commands remain responsive while the mutation reply is held',
    );
    await client.connection.command('disconnect', { connectionId: connected.connectionId! });
    assert.equal((await client.connection.command('getConnection', {})).state, 'disconnected');
    const result = await outcome;
    assert.equal(
      (result.error as ApplicationError)?.code,
      'Uncertain',
      'dispatch may have committed; retain the original identity',
    );
    assert.equal((await f.stats()).commands.filter((name) => name === operation).length, 1);
    await f.releaseReply();
    const next = await client.connection.command('connect', { profileId: client.profile.id });
    assert.notEqual(next.connectionId, connected.connectionId);
    if (operation === 'createChat') {
      const listed = await client.chat.command('listChats', { session: f.session });
      assert.equal(listed.conversations.length, 1);
      const retried = await client.chat.command('createChat', create);
      assert.deepEqual(retried.conversation.target, listed.conversations[0]!.target);
      assert.equal(
        (await client.chat.command('listChats', { session: f.session })).conversations.length,
        1,
      );
      assert.equal((await f.stats()).calls, 0);
    } else {
      const receipt = await client.chat.command('getChatSend', {
        target: target!,
        requestId: send.requestId,
      });
      assert.equal(receipt?.admission, 'admitted');
      if (operation === 'stopChat') {
        const retried = await client.chat.command('stopChat', {
          stop: stop!,
          requestId: 'captured-stop',
        });
        assert.deepEqual(retried.stop, stop);
      }
      f.release();
      await until(
        () => client.chat.command('getChat', { target: target! }),
        (value) => !value.run,
      );
      const snapshot = await client.chat.command('getChat', { target: target! });
      assert.equal(
        snapshot.entries.filter((entry) => entry.role === 'user' && entry.text === send.text)
          .length,
        1,
      );
      assert.equal(
        (await f.stats()).commands.filter((name) => name === 'sendChat').length,
        1,
        'reconnect and receipt lookup never resend',
      );
      assert.equal((await f.stats()).calls, 1);
    }
  });
