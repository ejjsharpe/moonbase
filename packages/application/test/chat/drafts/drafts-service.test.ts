import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import { formatChatMention } from '@moonbase/contracts/chat';
import { ChatDrafts } from '@moonbase/application/chat';
import {
  Storage,
  chatFixture,
  context,
  openChat,
  settings,
  target,
  type ChatFixture,
} from '../chat-fixture.ts';

const mutations = ['createChat', 'sendChat', 'stopChat'];
const saved = (f: ChatFixture) => JSON.parse(f.storage.value!);
/** Selects 'draft-0' … and gives each a draft, filling `count` draft slots. */
async function fillDrafts(f: ChatFixture, count: number, text = (n: number) => 'retained-' + n) {
  for (let n = 0; n < count; n++) {
    await f.select({ ...target, conversationId: 'draft-' + n });
    await f.setDraft(text(n));
  }
}

test('a new chat’s draft is kept before any chat exists and reopens without reaching the host', async (t) => {
  const f = await chatFixture(t);
  await f.setDraft('A draft before opening a project or chat');
  assert.equal((await f.state()).selected, null);
  assert.equal(await f.preserve(), true);
  await f.reopen();
  assert.equal((await f.state()).draft, 'A draft before opening a project or chat');
  assert.deepEqual(f.calls, []);
});

test('/new moves the rest to the new chat’s draft in the write that leaves the chat, once', async (t) => {
  const f = await chatFixture(t);
  await f.setDraft('Waiting');
  await openChat(f);
  await f.setDraft('/new\nCarry this');
  const written: string[] = [];
  f.storage.onWrite = (value) => written.push(value);
  // The same `/new` submitted twice, both typed in the open chat.
  const newChat = () =>
    f.runtime.runPromise(
      f
        .composer()
        .startNewChat({ selected: target, text: '/new\nCarry this' }, 'Carry this', [], undefined),
    );
  const [first, repeat] = await Promise.all([newChat(), newChat()]);
  assert.deepEqual([first, repeat], [true, false]);
  // Neither chat is ever without the text: the one write has left the chat and carried it, and
  // closing the transcript writes nothing more.
  assert.equal(written.length, 1);
  const kept = JSON.parse(written[0]!);
  assert.equal(kept.selected, null);
  assert.equal(kept.newDraft, 'Waiting\nCarry this');
  assert.deepEqual(kept.drafts, []);
  assert.equal((await f.state()).snapshot, null);
  await f.reopen();
  assert.equal((await f.state()).draft, 'Waiting\nCarry this');
});

test('/new moves nothing once its chat or draft has changed, so no draft is lost', async (t) => {
  const f = await chatFixture(t);
  await f.setDraft('New chat draft');
  await openChat(f);
  const other = { ...target, conversationId: 'other' };
  let writes = 0;
  f.storage.onWrite = () => writes++;
  /** Moves the rest of `/new` typed in `selected` whose draft read `text`; why it didn't. */
  const move = async (selected: typeof target | null, text: string) => {
    writes = 0;
    const moved = await f.run(
      Effect.flatMap(ChatDrafts, (drafts) =>
        drafts.moveToNewChat({ selected, text }, () => ({ text: 'Rest', mentions: [] })),
      ).pipe(Effect.catch((error) => Effect.succeed(error.reason))),
    );
    assert.equal(writes, 0);
    return moved;
  };
  const expectUnmoved = async (selected: typeof target | null, draft: string) => {
    const state = await f.state();
    assert.equal(state.selected?.conversationId, selected?.conversationId);
    assert.equal(state.draft, draft);
    assert.equal(saved(f).newDraft, 'New chat draft');
  };
  // The open chat's draft was edited after `/new` was typed: the edit stays.
  await f.setDraft('/new\nRest, edited');
  assert.equal(await move(target, '/new\nRest'), 'stale');
  await expectUnmoved(target, '/new\nRest, edited');
  // Another chat was chosen since, even one whose draft reads the same.
  await f.select(other);
  await f.setDraft('/new\nRest');
  assert.equal(await move(target, '/new\nRest'), 'stale');
  await expectUnmoved(other, '/new\nRest');
  // The chat was left for the new chat since, as an earlier `/new` does.
  await f.closeView();
  assert.equal(await move(other, '/new\nRest'), 'stale');
  // `/new` typed in the new chat whose draft has changed since.
  assert.equal(await move(null, '/new\nOlder'), 'stale');
  await expectUnmoved(null, 'New chat draft');
  // Every draft survives a restart as it was.
  await f.reopen();
  assert.equal((await f.state()).draft, 'New chat draft');
  await f.select(target);
  assert.equal((await f.state()).draft, '/new\nRest, edited');
  await f.select(other);
  assert.equal((await f.state()).draft, '/new\nRest');
});

test('a model and effort preference survives selection, new chats and a restart', async (t) => {
  const f = await chatFixture(t);
  assert.equal((await f.state()).modelPreference, null);
  const preference = {
    model: { provider: 'openai', modelId: 'gpt-6.1-sol' },
    reasoningEffort: 'xhigh' as const,
  };
  await f.setModelPreference(preference);
  preference.model.modelId = 'changed by caller';
  const expected = {
    model: { provider: 'openai', modelId: 'gpt-6.1-sol' },
    reasoningEffort: 'xhigh',
  };
  assert.deepEqual((await f.state()).modelPreference, expected);
  await openChat(f);
  await f.closeView();
  await f.setDraft('First new chat');
  await f.send(settings);
  await f.closeView();
  assert.deepEqual((await f.state()).modelPreference, expected);
  assert.equal(await f.preserve(), true);
  await f.reopen();
  await f.start();
  assert.deepEqual((await f.state()).modelPreference, expected);
  assert.equal(f.count('createChat'), 1);
});

test('an invalid preference, or one set after the chat closed, keeps the saved one', async (t) => {
  const f = await chatFixture(t);
  const preference = {
    model: { provider: 'openai', modelId: 'gpt-6.1-sol' },
    reasoningEffort: 'high' as const,
  };
  await f.setModelPreference(preference);
  const raw = f.storage.value;
  await f.setModelPreference({ ...preference, reasoningEffort: 'invented' as 'high' });
  const state = await f.state();
  assert.equal(f.storage.value, raw);
  assert.deepEqual(state.modelPreference, preference);
  assert.ok(state.error);
  assert.equal(state.storageError, null);
  await f.close();
  await f.setModelPreference({ ...preference, reasoningEffort: 'medium' });
  assert.equal(f.storage.value, raw);
});

test('a refused write keeps the latest live edit on screen and blocks preservation and Send', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.setDraft('saved');
  f.storage.fail = true;
  await f.setDraft('latest live text');
  const state = await f.state();
  assert.equal(state.draft, 'latest live text');
  assert.ok(state.storageError);
  assert.equal(await f.preserve(), false);
  assert.equal(saved(f).drafts[0].text, 'saved');
  // Storage that recovers doesn't lift the block: the chat's lifetime is blocked.
  f.storage.fail = false;
  await f.send(settings);
  assert.equal(f.count('sendChat'), 0);
  assert.equal((await f.state()).draft, 'latest live text');
});

test('another client’s write to storage is never overwritten', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.setDraft('Original');
  f.storage.value = 'external change';
  await f.setDraft('third');
  assert.equal(f.storage.value, 'external change');
  const state = await f.state();
  assert.ok(state.storageError);
  assert.equal(state.draft, 'third');
});

test('too long or ill-formed text never replaces the draft', async (t) => {
  const f = await chatFixture(t);
  await f.setDraft('keep');
  await f.setDraft('a'.repeat(32769));
  assert.equal((await f.state()).draft, 'keep');
  await f.setDraft('\ud800');
  const state = await f.state();
  assert.equal(state.draft, 'keep');
  assert.ok(state.error);
  assert.equal(state.storageError, null);
});

test('drafts past the saved count keep the live edit and block preservation', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await fillDrafts(f, 32);
  await f.select({ ...target, conversationId: 'overflow' });
  await f.setDraft('latest live overflow');
  const state = await f.state();
  assert.equal(state.draft, 'latest live overflow');
  assert.ok(state.storageError);
  assert.equal(await f.preserve(), false);
  assert.equal(saved(f).drafts.length, 32);
});

test('a draft that would push the saved data past its byte bound is kept live, not written', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  // Each draft escapes to six bytes a character, so ten fit and an eleventh doesn't.
  const value = '\u0001'.repeat(32768);
  await fillDrafts(f, 10, () => value);
  assert.equal((await f.state()).storageError, null);
  await f.select({ ...target, conversationId: 'escaped-overflow' });
  const kept = f.storage.value,
    writes = f.storage.writes;
  await f.setDraft(value);
  assert.equal(await f.preserve(), false);
  const state = await f.state();
  assert.ok(state.storageError);
  assert.equal(state.draft, value);
  assert.equal(f.storage.value, kept);
  assert.equal(f.storage.writes, writes);
  assert.equal(JSON.parse(kept!).drafts.length, 10);
});

const familiar = {
  version: 1,
  session: context,
  selected: target,
  drafts: [{ target, text: 'Existing unsent draft' }],
  pending: [
    {
      operation: 'createChat',
      input: { session: context, requestId: 'retained-create', title: 'Saved', settings },
      message: 'Pending',
    },
    {
      operation: 'sendChat',
      input: { target, requestId: 'existing-request', text: 'Original uncertain Send' },
      message: 'Uncertain: response lost',
    },
  ],
};

test('saved drafts and pending commands reopen unchanged, and keeping them changes nothing', async (t) => {
  const storage = new Storage();
  storage.value = JSON.stringify(familiar);
  const f = await chatFixture(t, { storage });
  const state = await f.state();
  assert.equal(state.draft, 'Existing unsent draft');
  assert.deepEqual(state.pending, familiar.pending);
  assert.equal(state.storageError, null);
  assert.equal(await f.preserve(), true);
  assert.deepEqual(JSON.parse(storage.value), familiar);
  assert.deepEqual(f.calls, []);
});

const unreadable: [string, string][] = [
  ['broken JSON', '{broken'],
  ['another actor', JSON.stringify({ ...familiar, session: { ...context, actorId: 'other' } })],
  [
    'an unknown host field',
    JSON.stringify({
      ...familiar,
      selected: { ...target, host: { ...context.host, extra: true } },
    }),
  ],
  [
    'an unknown session field in a pending Create',
    JSON.stringify({
      ...familiar,
      pending: [
        {
          ...familiar.pending[0],
          input: { ...familiar.pending[0]!.input, session: { ...context, extra: true } },
        },
      ],
    }),
  ],
  [
    'an unknown draft field',
    JSON.stringify({
      ...familiar,
      drafts: [{ target, text: 'Prior producer text', futureField: { evidence: 'unknown' } }],
    }),
  ],
];
for (const [kind, value] of unreadable)
  test(`saved data with ${kind} stays untouched and blocks every mutation`, async (t) => {
    const storage = new Storage();
    storage.value = value;
    const f = await chatFixture(t, { storage });
    await f.start();
    await f.connect();
    await f.create('Do not send', settings);
    await f.setDraft('Cannot publish into an incompatible namespace');
    assert.equal(await f.preserve(), false);
    assert.ok((await f.state()).storageError);
    assert.equal(storage.value, value);
    assert.equal(storage.writes, 0);
    assert(!f.calls.some((call) => mutations.includes(call.operation)));
  });

test('draft mentions persist with their text, drop when their text is deleted, and go out with Send', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.closeView();
  await f.setDraft('Compare @src/a.ts and @"docs/My notes.md" ', [
    { path: 'src/a.ts' },
    { path: 'docs/My notes.md' },
    { path: 'not/spelled.ts' },
  ]);
  assert.deepEqual((await f.state()).mentions, [
    { path: 'src/a.ts' },
    { path: 'docs/My notes.md' },
  ]);
  // Ordinary typing keeps the mentions its text still spells, as whole tokens.
  await f.setDraft('Compare @src/a.tsx and @"docs/My notes.md" ');
  assert.deepEqual((await f.state()).mentions, [{ path: 'docs/My notes.md' }]);
  await f.setDraft('Compare @src/a.ts and @"docs/My notes.md" ', [
    { path: 'src/a.ts' },
    { path: 'docs/My notes.md' },
  ]);
  await f.setDraft('Compare @src/a.ts and ');
  assert.deepEqual((await f.state()).mentions, [{ path: 'src/a.ts' }]);
  // Mentioning more files than a message carries leaves the draft as it was.
  const many = Array.from({ length: 33 }, (_, n) => ({ path: `f${n}` }));
  await f.setDraft(many.map((mention) => `@${mention.path}`).join(' '), many);
  assert.equal((await f.state()).draft, 'Compare @src/a.ts and ');
  assert.match((await f.state()).error ?? '', /at most 32 files/);
  assert.deepEqual(saved(f).newDraftMentions, [{ path: 'src/a.ts' }]);
  await f.send(settings);
  const send = f.calls.find((call) => call.operation === 'sendChat')!.input as {
    text: string;
    mentions?: unknown;
  };
  assert.equal(send.text, 'Compare @src/a.ts and ');
  assert.deepEqual(send.mentions, [{ path: 'src/a.ts' }]);
  assert.deepEqual((await f.state()).mentions, []);
  // A reply in the open chat carries its own mentions, and a plain one none.
  await f.setDraft('Now @b.ts', [{ path: 'b.ts' }]);
  await f.send();
  await f.setDraft('No mentions');
  await f.send();
  const [, reply, plain] = f.calls.filter((call) => call.operation === 'sendChat');
  assert.deepEqual((reply!.input as { mentions?: unknown }).mentions, [{ path: 'b.ts' }]);
  assert(!('mentions' in (plain!.input as object)));
});

test('a mention the saved format rejects is refused without blocking storage, Send or Quit', async (t) => {
  const f = await chatFixture(t);
  await openChat(f);
  await f.setDraft('Before');
  for (const path of [
    'a"b.ts',
    'a\\b.ts',
    'x\u0001.ts',
    '../up.ts',
    'a/./b.ts',
    'd/'.repeat(600),
  ]) {
    await f.setDraft(`Look at ${formatChatMention(path)} `, [{ path }]);
    const state = await f.state();
    assert.match(state.error ?? '', /relative path/, path);
    assert.equal(state.storageError, null);
    assert.equal(state.draft, 'Before');
    assert.deepEqual(state.mentions, []);
  }
  assert.equal(saved(f).drafts[0].text, 'Before');
  assert.equal(await f.preserve(), true);
  await f.setDraft('Now @ok.ts', [{ path: 'ok.ts' }]);
  await f.send();
  const send = f.calls.find((call) => call.operation === 'sendChat')!.input as {
    mentions?: unknown;
  };
  assert.deepEqual(send.mentions, [{ path: 'ok.ts' }]);
  assert.equal(await f.preserve(), true);
});
