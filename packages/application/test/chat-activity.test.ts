import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatActivity, ChatSummary } from '@moonbase/contracts/chat';
import { groupChatsByActivity } from '@moonbase/application/chat';

const host = { hostId: 'host', storeId: 'store' };
const created = '2026-11-01T10:00:00.000Z';
function chat(id: string, activity?: Partial<ChatActivity>): ChatSummary {
  return {
    target: { host, actorId: 'actor', conversationId: id },
    title: id,
    createdAt: created,
    cwd: '/work',
    model: 'faux/model',
    ...(activity ? { activity: { state: 'idle', at: created, ...activity } } : {}),
  };
}
const at = (minute: number) => `2026-11-07T10:${String(minute).padStart(2, '0')}:00.000Z`;
const names = (rows: { chat: ChatSummary; reason: string }[]) =>
  rows.map((row) => `${row.chat.target.conversationId}:${row.reason}`);

test('chats group into Ready, Working and Idle by state and what you have seen', () => {
  const groups = groupChatsByActivity({
    chats: [
      chat('never-ran'),
      chat('finished-unseen', { at: at(5) }),
      chat('finished-seen', { at: at(6) }),
      chat('failed-unseen', { state: 'failed', at: at(7) }),
      chat('failed-seen', { state: 'failed', at: at(2) }),
      chat('stopped', { state: 'stopped', at: at(1) }),
      chat('running-old', { state: 'running', at: at(3) }),
      chat('running-new', { state: 'running', at: at(8) }),
      chat('unconfirmed', { at: at(4) }),
    ],
    seen: [
      { conversationId: 'finished-seen', at: at(6) },
      { conversationId: 'failed-seen', at: at(2) },
      // A look from before the latest activity does not cover it.
      { conversationId: 'stopped', at: at(0) },
      { conversationId: 'unconfirmed', at: at(9) },
    ],
    pending: [
      {
        operation: 'sendChat',
        input: { target: chat('unconfirmed').target, requestId: 'send', text: 'Hi' },
        message: 'Send could not be confirmed.',
      },
    ],
  });
  assert.deepEqual(names(groups.ready), [
    'failed-unseen:failed',
    'finished-unseen:finished',
    'unconfirmed:unconfirmed',
    'stopped:stopped',
  ]);
  assert.deepEqual(names(groups.working), ['running-new:running', 'running-old:running']);
  assert.deepEqual(names(groups.idle), [
    'finished-seen:idle',
    'failed-seen:idle',
    'never-ran:idle',
  ]);
  // Nothing is settled until you settle it.
  assert.deepEqual(groups.settled, []);
});

test('Settled holds the chats you settled, most recently settled first, unless running or unconfirmed', () => {
  const settled = (id: string, minute: number, activity?: Partial<ChatActivity>) => ({
    ...chat(id, activity),
    settledAt: at(minute),
  });
  const groups = groupChatsByActivity({
    chats: [
      settled('old', 1, { at: at(9) }),
      settled('new', 5),
      // Unseen work in a settled chat stays settled.
      settled('failed-unseen', 3, { state: 'failed', at: at(8) }),
      settled('running', 4, { state: 'running', at: at(6) }),
      settled('unconfirmed', 2),
      chat('idle'),
    ],
    pending: [
      {
        operation: 'sendChat',
        input: { target: chat('unconfirmed').target, requestId: 'send', text: 'Hi' },
        message: 'Send could not be confirmed.',
      },
    ],
  });
  assert.deepEqual(names(groups.settled), ['new:settled', 'failed-unseen:settled', 'old:settled']);
  // A settled row shows when it was settled.
  assert.equal(groups.settled[0]!.at, at(5));
  assert.deepEqual(names(groups.working), ['running:running']);
  assert.deepEqual(names(groups.ready), ['unconfirmed:unconfirmed']);
  assert.deepEqual(names(groups.idle), ['idle:idle']);
});

test("the open chat's snapshot overrides its listed state", () => {
  const listed = chat('open', { state: 'running', at: at(3) });
  const open = (state: 'idle' | 'running' | 'failed', run = false) =>
    groupChatsByActivity({
      chats: [listed],
      open: { conversation: listed, state, run: run ? ({} as never) : null },
    });
  assert.deepEqual(names(open('failed').ready), ['open:failed']);
  assert.deepEqual(names(open('idle').ready), ['open:finished']);
  assert.deepEqual(names(open('idle', true).working), ['open:running']);
  // The open chat's snapshot also says whether it is settled, as a Send may have unsettled it.
  const settledListing = { ...listed, settledAt: at(4) };
  const settledGroups = (settledAt?: string) =>
    groupChatsByActivity({
      chats: [settledListing],
      seen: [{ conversationId: 'open', at: at(3) }],
      open: {
        conversation: { ...listed, ...(settledAt ? { settledAt } : {}) },
        state: 'idle',
        run: null,
      },
    });
  assert.deepEqual(names(settledGroups().idle), ['open:idle']);
  assert.deepEqual(names(settledGroups(at(7)).settled), ['open:settled']);
});
