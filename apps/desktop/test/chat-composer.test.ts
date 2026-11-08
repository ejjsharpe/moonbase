import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findChatMentionStarts,
  type ChatCreationSettings,
  type ChatMention,
  type ChatTarget,
} from '@moonbase/contracts/chat';
import { ChatComposer, getChatComposer } from '../src/renderer/chat/composer.ts';

const target = (conversationId: string) =>
  ({ conversationId, session: { actorId: 'a', hostId: 'h', storeId: 's' } }) as never as ChatTarget;
const settings = { model: { provider: 'faux', modelId: 'faux-1' } };

/** A chat controller's draft rules in memory: one draft per chat, and one for a new chat. */
function makeChat(selected: ChatTarget | null = null) {
  const drafts = new Map<string, { text: string; mentions: ChatMention[] }>();
  const key = () => selected?.conversationId ?? '';
  const sent: ChatCreationSettings[] = [];
  let failClose = false;
  const chat = {
    sent,
    drafts,
    failNextClose: () => (failClose = true),
    getSnapshot: () => ({
      selected,
      draft: drafts.get(key())?.text ?? '',
      mentions: drafts.get(key())?.mentions ?? [],
      active: [] as string[],
    }),
    setDraft(text: string, mentions?: readonly ChatMention[]) {
      const kept = (mentions ?? drafts.get(key())?.mentions ?? []).filter(
        (mention) => findChatMentionStarts(text, mention.path).length,
      );
      drafts.set(key(), { text, mentions: kept.map(({ path }) => ({ path })) });
    },
    send: async (creation?: ChatCreationSettings) => {
      sent.push(creation!);
    },
    closeView: async () => {
      if (failClose) failClose = false;
      else selected = null;
    },
    select: async (next: ChatTarget) => {
      selected = next;
    },
  };
  return chat;
}
const composerOf = (chat: ReturnType<typeof makeChat>) =>
  new ChatComposer(chat as never as ConstructorParameters<typeof ChatComposer>[0]);

test('a place keeps its new chat folder, worktree choice and error across views', () => {
  const chat = makeChat();
  const composer = getChatComposer(chat as never);
  assert.equal(getChatComposer(chat as never), composer);
  assert.deepEqual(composer.readPlace('agents', ''), {
    cwd: '',
    newWorktree: false,
    folderError: null,
  });
  composer.updatePlace('agents', '', { cwd: '/repo', newWorktree: true });
  composer.updatePlace('dock:/other', '/other', { folderError: 'Nope' });
  assert.deepEqual(composer.readPlace('agents', ''), {
    cwd: '/repo',
    newWorktree: true,
    folderError: null,
  });
  assert.deepEqual(composer.readPlace('dock:/other', '/other'), {
    cwd: '/other',
    newWorktree: false,
    folderError: 'Nope',
  });
  // Another controller (another chat target) starts over.
  assert.notEqual(getChatComposer(makeChat() as never), composer);
});

test('a worktree made after its view went away still sends, and keeps the place on it', async () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  chat.setDraft('Tidy @src/a.ts', [{ path: 'src/a.ts' }]);
  composer.updatePlace('agents', '', { cwd: '/repo', newWorktree: true });
  composer.moveMentions('/repo');
  const made = Promise.withResolvers<string>();
  const asked: string[] = [];
  let published = 0;
  composer.subscribe(() => published++);
  composer.sendInWorktree(
    'agents',
    '',
    (root, branch) => {
      asked.push(`${root} ${branch}`);
      return made.promise;
    },
    settings,
  );
  assert.equal(composer.getSnapshot().creatingWorktree, true);
  // A second Send while Git works makes no second worktree.
  composer.sendInWorktree('agents', '', () => Promise.reject(Error('second')), settings);
  assert.deepEqual(asked, ['/repo chat/tidy']);
  // No view is subscribed any more; the creation still completes.
  made.resolve('/repo-worktrees/chat-tidy');
  await made.promise;
  await Promise.resolve();
  assert.ok(published > 0);
  assert.deepEqual(chat.sent, [{ cwd: '/repo-worktrees/chat-tidy', ...settings }]);
  assert.equal(composer.getSnapshot().creatingWorktree, false);
  assert.deepEqual(composer.readPlace('agents', ''), {
    cwd: '/repo-worktrees/chat-tidy',
    newWorktree: false,
    folderError: null,
  });
  // The worktree holds the checkout's files at the same paths, so its mentions stay.
  assert.equal(composer.moveMentions('/repo-worktrees/chat-tidy'), 0);
  assert.deepEqual(chat.getSnapshot().mentions, [{ path: 'src/a.ts' }]);
});

test('a worktree finished after another chat opened waits for a new chat, and a failure says so', async () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  chat.setDraft('Fix it');
  composer.updatePlace('agents', '', { cwd: '/repo', newWorktree: true });
  const made = Promise.withResolvers<string>();
  composer.sendInWorktree('agents', '', () => made.promise, settings);
  await chat.select(target('other'));
  made.resolve('/repo-worktrees/chat-fix-it');
  await made.promise;
  await Promise.resolve();
  assert.deepEqual(chat.sent, []);
  assert.equal(composer.readPlace('agents', '').cwd, '/repo-worktrees/chat-fix-it');
  assert.match(composer.readPlace('agents', '').folderError!, /ready at \/repo-worktrees/);

  const failing = Promise.withResolvers<string>();
  composer.updatePlace('dock:/b', '/b', { newWorktree: true });
  composer.sendInWorktree('dock:/b', '/b', () => failing.promise, settings);
  failing.reject(Error('Git said no.'));
  await failing.promise.catch(() => {});
  await Promise.resolve();
  assert.equal(composer.getSnapshot().creatingWorktree, false);
  assert.deepEqual(composer.readPlace('dock:/b', '/b'), {
    cwd: '/b',
    newWorktree: true,
    folderError: 'The worktree could not be created. Git said no.',
  });
});

test('mentions follow the folder the composer shows, and ones outside it become plain text', () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  // No folder shown yet: nothing to move.
  assert.equal(composer.moveMentions(''), 0);
  composer.moveMentions('/repo');
  chat.setDraft('See @src/a.ts and @b.ts', [{ path: 'src/a.ts' }, { path: 'b.ts' }]);
  assert.equal(composer.moveMentions('/repo/src'), 1);
  assert.deepEqual(chat.getSnapshot(), {
    selected: null,
    draft: 'See @a.ts and @b.ts',
    mentions: [{ path: 'a.ts' }],
    active: [],
  });
  assert.equal(composer.moveMentions('/repo'), 0);
  assert.equal(chat.getSnapshot().draft, 'See @src/a.ts and @b.ts');
  assert.deepEqual(chat.getSnapshot().mentions, [{ path: 'src/a.ts' }]);
});

test('/new carries the rest of the message to the new chat and empties the open one', async () => {
  const chat = makeChat(target('open'));
  const composer = composerOf(chat);
  chat.setDraft('/new\nLook at @src/a.ts', [{ path: 'src/a.ts' }]);
  assert.equal(
    await composer.startNewChat('Look at @src/a.ts', [{ path: 'src/a.ts' }], '/repo'),
    null,
  );
  assert.equal(chat.getSnapshot().selected, null);
  assert.deepEqual(chat.drafts.get('open'), { text: '', mentions: [] });
  assert.deepEqual(chat.getSnapshot().mentions, [{ path: 'src/a.ts' }]);
  assert.equal(chat.getSnapshot().draft, 'Look at @src/a.ts');
  // Its mentions are relative to the open chat's folder until the composer shows another.
  assert.equal(composer.moveMentions('/repo/src'), 0);
  assert.equal(chat.getSnapshot().draft, 'Look at @a.ts');

  // A new chat draft already there keeps its text, and the rest follows it.
  await chat.select(target('second'));
  chat.setDraft('/new\nAnd @README.md', [{ path: 'README.md' }]);
  await composer.startNewChat('And @README.md', [{ path: 'README.md' }], '/repo/src');
  assert.equal(chat.getSnapshot().draft, 'Look at @a.ts\nAnd @README.md');
  assert.deepEqual(chat.getSnapshot().mentions, [{ path: 'a.ts' }, { path: 'README.md' }]);
});

test('/new keeps the rest in the open chat when the new chat cannot take it', async () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  chat.setDraft('x'.repeat(32 * 1024 - 2));
  await chat.select(target('open'));
  chat.setDraft('/new\nMore');
  assert.match(
    (await composer.startNewChat('More', [], '/repo'))!,
    /no room for the rest of this message/,
  );
  assert.equal(chat.getSnapshot().selected?.conversationId, 'open');
  assert.equal(chat.getSnapshot().draft, 'More');
  assert.equal(chat.drafts.get('')!.text.length, 32 * 1024 - 2);
  // A view that can't close keeps the rest in the open chat too.
  chat.setDraft('/new\nStill here');
  chat.failNextClose();
  assert.equal(await composer.startNewChat('Still here', [], '/repo'), null);
  assert.equal(chat.getSnapshot().selected?.conversationId, 'open');
  assert.equal(chat.getSnapshot().draft, 'Still here');
});
