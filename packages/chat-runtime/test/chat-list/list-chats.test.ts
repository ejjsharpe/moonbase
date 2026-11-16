import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { session, until, fixture } from '../runtime-fixture.ts';

test('a listing reports each chat activity as its snapshot does, with when it last ran', async (t) => {
  const f = await fixture(t);
  const fresh = await f.create('fresh'),
    finished = await f.create('finished'),
    failed = await f.create('failed'),
    stopped = await f.create('stopped');
  const listed = async () =>
    new Map(
      (await f.client.command('listChats', { session })).conversations.map((chat) => [
        chat.target.conversationId,
        chat,
      ]),
    );
  const before = (await listed()).get(fresh.conversationId)!;
  assert.deepEqual(before.activity, { state: 'idle', at: before.createdAt });

  f.faux.setResponses([fauxAssistantMessage('Done')]);
  await f.client.command('sendChat', { target: finished, requestId: 'send-finished', text: 'Go' });
  await until(
    () => f.client.command('getChat', { target: finished }),
    (s) => !s.run && s.state === 'idle' && s.entries.some((e) => e.text === 'Done'),
  );
  f.faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'x' })]);
  await f.client.command('sendChat', { target: failed, requestId: 'send-failed', text: 'Fail' });
  await until(
    () => f.client.command('getChat', { target: failed }),
    (s) => !s.run && s.state === 'failed',
  );
  f.faux.setResponses([fauxAssistantMessage('a'.repeat(10000))]);
  await f.client.command('sendChat', { target: stopped, requestId: 'send-stopped', text: 'Long' });
  const running = await until(
    () => f.client.command('getChat', { target: stopped }),
    (s) => !!s.run,
  );
  assert.equal((await listed()).get(stopped.conversationId)!.activity!.state, 'running');
  await f.client.command('stopChat', { stop: running.run!.stop, requestId: 'stop' });
  await until(
    () => f.client.command('getChat', { target: stopped }),
    (s) => s.run === null,
  );

  const after = await listed();
  for (const target of [finished, failed, stopped]) {
    const chat = after.get(target.conversationId)!;
    const snapshot = await f.client.command('getChat', { target });
    assert.equal(chat.activity!.state, snapshot.state, target.conversationId);
    assert(Date.parse(chat.activity!.at) >= Date.parse(chat.createdAt));
  }
  assert.equal(after.get(finished.conversationId)!.activity!.state, 'idle');
  assert.equal(after.get(failed.conversationId)!.activity!.state, 'failed');
  assert.notEqual(
    after.get(finished.conversationId)!.activity!.at,
    after.get(finished.conversationId)!.createdAt,
  );
});
