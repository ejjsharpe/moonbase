import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import { ChatSelection } from '@moonbase/application/chat';
import { chatProtocolVersion } from '@moonbase/contracts/host';
import {
  chatFixture,
  context,
  makeEntry,
  openChat,
  profile,
  snapshot,
  target,
  turn,
  unavailable,
  until,
} from '../chat-fixture.ts';

// The open chat's transcript as the selection owns it: its reads end with its connection, and
// refresh reopens it.

test('a new connection generation cancels the open chat’s held reads, and their replies never land', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  const held = Promise.withResolvers<unknown>();
  f.answers.set('getChatHistoryAround', () => held.promise);
  const jumping = f.run(Effect.flatMap(ChatSelection, (s) => s.jumpToEntry('missing')));
  await until(f, () => f.signals.has('getChatHistoryAround'));
  f.publishConnection({
    state: 'connected',
    connectionId: 'generation-replacement',
    profile,
    health: {
      ...context.host,
      protocol: chatProtocolVersion,
      version: '0.1.0',
      capabilities: ['chat-v0'],
    },
  });
  await jumping;
  assert.equal(f.signals.get('getChatHistoryAround')![0]!.aborted, true);
  held.resolve({
    target,
    entryId: 'missing',
    entries: [makeEntry('missing', 'late')],
    olderCursor: null,
    newerCursor: null,
    upperEntryId: 'missing',
    cursor: null,
  });
  // The new generation's refresh reopens the selection; the late page never reaches it.
  const state = await until(f, (s) => s.transcript.observation === 'streaming');
  assert(!state.transcript.entries.some((entry) => entry.text === 'late'));
});

test('a chat selected before its host is verified opens once refresh verifies it', async (t) => {
  const f = await chatFixture(t, { local: true });
  const verified = Promise.withResolvers<void>();
  f.answers.set('getChatHost', async () => {
    await verified.promise;
    return { ...context, mode: 'local' };
  });
  const starting = f.start();
  await until(f, (s) => s.active.includes('refresh'));
  await f.select(target);
  assert.equal((await f.state()).snapshot, null, 'nothing opens on an unverified host');
  verified.resolve();
  await starting;
  const state = await until(f, (s) => !!s.snapshot);
  assert.equal(state.snapshot?.conversation.target.conversationId, target.conversationId);
});

test('a failed chat list does not prevent opening chats on the verified host', async (t) => {
  const f = await chatFixture(t, { local: true });
  f.answers.set('listChats', () => {
    throw unavailable();
  });
  await f.start();
  let state = await f.state();
  assert.ok(state.error);
  assert.ok(state.host);
  await f.select(target);
  state = await until(f, (s) => !!s.snapshot);
  assert.equal(state.snapshot?.conversation.title, snapshot.conversation.title);
});

test('refresh reopens a transcript that failed', async (t) => {
  const f = await chatFixture(t, { local: true });
  await f.start();
  await f.select(target);
  f.publish({
    ...snapshot,
    conversation: { ...snapshot.conversation, target: { ...target, conversationId: 'other' } },
  });
  await until(f, (s) => s.transcript.observation === 'failed');
  await f.refresh();
  const state = await until(f, (s) => s.transcript.observation === 'local');
  assert.equal(state.snapshot?.conversation.target.conversationId, target.conversationId);
  await turn();
  assert.equal(f.subscriptions, 1, 'the failed watch was released');
});
