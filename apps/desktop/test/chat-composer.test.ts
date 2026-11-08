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

/**
 * A chat controller's draft rules in memory: one draft per chat and one for a new chat. A new chat's
 * send creates a chat in its folder and opens it, as the controller does once the host confirms it.
 */
function makeChat(selected: ChatTarget | null = null) {
  const drafts = new Map<string, { text: string; mentions: ChatMention[] }>();
  const chats: { target: ChatTarget; cwd: string }[] = [];
  const key = () => selected?.conversationId ?? '';
  const sent: { cwd?: string; draft: string; mentions: ChatMention[] }[] = [];
  const listeners = new Set<() => void>();
  let failClose = false,
    failSend = false,
    rejectDraft = false;
  const notify = () => listeners.forEach((listener) => listener());
  const chat = {
    sent,
    drafts,
    failNextClose: () => (failClose = true),
    /** The next send's outcome is unconfirmed: no chat is created or opened. */
    failNextSend: () => (failSend = true),
    rejectNextDraft: () => (rejectDraft = true),
    /** A chat the host lists later, as when a retried create is confirmed. */
    listChat(cwd: string) {
      chats.push({ target: target(`listed-${chats.length}`), cwd });
      notify();
    },
    getSnapshot: () => ({
      selected,
      draft: drafts.get(key())?.text ?? '',
      mentions: drafts.get(key())?.mentions ?? [],
      chats,
      snapshot: selected
        ? {
            conversation: {
              cwd: chats.find((c) => c.target.conversationId === selected!.conversationId)?.cwd,
            },
          }
        : null,
    }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDraft(text: string, mentions?: readonly ChatMention[]) {
      if (rejectDraft) return void (rejectDraft = false);
      const kept = (mentions ?? drafts.get(key())?.mentions ?? []).filter(
        (mention) => findChatMentionStarts(text, mention.path).length,
      );
      drafts.set(key(), { text, mentions: kept.map(({ path }) => ({ path })) });
      notify();
    },
    send: async (creation?: ChatCreationSettings) => {
      const { draft, mentions } = chat.getSnapshot();
      sent.push({ cwd: creation?.cwd, draft, mentions });
      if (failSend) return void (failSend = false);
      drafts.delete(key());
      if (!selected) {
        chats.push({ target: target(`created-${chats.length}`), cwd: creation!.cwd });
        selected = chats.at(-1)!.target;
      }
      notify();
    },
    closeView: async () => {
      if (failClose) failClose = false;
      else selected = null;
      notify();
    },
    select: async (next: ChatTarget) => {
      selected = next;
      notify();
    },
  };
  return chat;
}
const composerOf = (chat: ReturnType<typeof makeChat>) =>
  new ChatComposer(chat as never as ConstructorParameters<typeof ChatComposer>[0]);
const settle = () => new Promise((resolve) => setTimeout(resolve));
/** Starts a worktree send from Agents in `/repo`, resolved or rejected when the test says. */
function startWorktree(composer: ChatComposer) {
  composer.updatePlace('agents', '', { cwd: '/repo', newWorktree: true });
  const made = Promise.withResolvers<string>();
  composer.sendInWorktree('agents', '', () => made.promise, settings);
  return made;
}

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

test('a worktree made after its view went away still sends, then the place returns to its folder', async () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  chat.setDraft('Tidy @src/a.ts', [{ path: 'src/a.ts' }]);
  composer.noteMentions(['src/a.ts'], '/repo');
  composer.updatePlace('agents', '', { cwd: '/repo', newWorktree: true });
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
  await settle();
  assert.ok(published > 0);
  // The worktree holds the checkout's files at the same paths, so its mentions stay.
  assert.deepEqual(chat.sent, [
    { cwd: '/repo-worktrees/chat-tidy', draft: 'Tidy @src/a.ts', mentions: [{ path: 'src/a.ts' }] },
  ]);
  assert.equal(composer.getSnapshot().creatingWorktree, false);
  // The chat was created, so the next new chat starts in the folder the worktree was made from.
  assert.deepEqual(composer.readPlace('agents', ''), {
    cwd: '/repo',
    newWorktree: false,
    folderError: null,
  });
});

test('a worktree whose send isn’t confirmed keeps the place on it, until a retry creates the chat', async () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  chat.setDraft('Fix it');
  chat.failNextSend();
  const made = startWorktree(composer);
  made.resolve('/repo-worktrees/chat-fix-it');
  await settle();
  // Another chat opened meanwhile doesn't count as the worktree's chat.
  await chat.select(target('other'));
  assert.equal(composer.readPlace('agents', '').cwd, '/repo-worktrees/chat-fix-it');
  chat.listChat('/repo-worktrees/chat-fix-it');
  assert.equal(composer.readPlace('agents', '').cwd, '/repo');
});

test('a worktree ready while another chat is open keeps the mentions in the worktree', async () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  chat.setDraft('Tidy @src/a.ts', [{ path: 'src/a.ts' }]);
  composer.noteMentions(['src/a.ts'], '/repo');
  assert.equal(composer.checkMentions('/repo'), null);
  const made = startWorktree(composer);
  await chat.select(target('other'));
  made.resolve('/wt');
  await settle();
  assert.deepEqual(chat.sent, []);
  assert.match(composer.getSnapshot().notice!, /ready at \/wt/);
  await chat.closeView();
  const cwd = composer.readPlace('agents', '').cwd;
  assert.equal(cwd, '/wt');
  // Sending from there finds them where they were picked, at the same paths.
  assert.equal(composer.checkMentions(cwd), null);
  assert.equal(chat.getSnapshot().draft, 'Tidy @src/a.ts');
});

test('a worktree outcome reaches every view, until the new chat is left for a chat', async () => {
  const chat = makeChat(target('first'));
  const composer = composerOf(chat);
  await chat.closeView();
  chat.setDraft('Fix it');
  const made = startWorktree(composer);
  await chat.select(target('other'));
  made.resolve('/repo-worktrees/chat-fix-it');
  await settle();
  assert.match(composer.getSnapshot().notice!, /ready at \/repo-worktrees\/chat-fix-it/);
  // Moving between open chats, or back to the new chat, keeps it to be seen.
  await chat.select(target('another'));
  await chat.closeView();
  assert.match(composer.getSnapshot().notice!, /ready at/);
  // Leaving the new chat for a chat clears it.
  await chat.select(target('other'));
  assert.equal(composer.getSnapshot().notice, null);

  await chat.closeView();
  chat.setDraft('Fix it');
  const failing = Promise.withResolvers<string>();
  composer.updatePlace('dock:/b', '/b', { newWorktree: true, folderError: 'Old' });
  composer.sendInWorktree('dock:/b', '/b', () => failing.promise, settings);
  assert.equal(composer.readPlace('dock:/b', '/b').folderError, null);
  failing.reject(Error('Git said no.'));
  await settle();
  assert.equal(composer.getSnapshot().creatingWorktree, false);
  assert.equal(composer.getSnapshot().notice, 'The worktree could not be created. Git said no.');
  assert.deepEqual(composer.readPlace('dock:/b', '/b'), {
    cwd: '/b',
    newWorktree: true,
    folderError: null,
  });
  composer.clearMessages('dock:/b');
  assert.equal(composer.getSnapshot().notice, null);
  // Leaving the new chat for a chat clears every place's errors too.
  composer.updatePlace('agents', '', { folderError: 'Stale' });
  await chat.select(target('third'));
  assert.equal(composer.readPlace('agents', '').folderError, null);
});

test('showing the draft elsewhere leaves its mentions; Send checks them against its folder', () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  // Mentions picked in Agents' folder, then the draft is shown in a dock with another folder.
  chat.setDraft('Fix @index.md and @src/a.ts', [{ path: 'index.md' }, { path: 'src/a.ts' }]);
  composer.noteMentions(['index.md'], '/notes');
  composer.noteMentions(['src/a.ts'], '/repo');
  assert.deepEqual(chat.getSnapshot().mentions, [{ path: 'index.md' }, { path: 'src/a.ts' }]);
  // Sending from the notes folder writes out the file from elsewhere and holds the send.
  assert.equal(
    composer.checkMentions('/notes'),
    "A mentioned file isn't in /notes, so it is written out as a full path instead. Send again to send the message.",
  );
  assert.equal(chat.getSnapshot().draft, 'Fix @index.md and /repo/src/a.ts');
  assert.deepEqual(chat.getSnapshot().mentions, [{ path: 'index.md' }]);
  // Now every mention is relative to it, so the next Send goes ahead.
  assert.equal(composer.checkMentions('/notes'), null);
  assert.equal(chat.getSnapshot().draft, 'Fix @index.md and /repo/src/a.ts');
  // A mention inside a subfolder is respelled without holding the send.
  chat.setDraft('See @docs/x.md', [{ path: 'docs/x.md' }]);
  composer.noteMentions(['docs/x.md'], '/notes');
  assert.equal(composer.checkMentions('/notes/docs'), null);
  assert.equal(chat.getSnapshot().draft, 'See @x.md');
});

test('a mention whose folder is unknown, as after a restart, holds the first Send', () => {
  const chat = makeChat();
  chat.setDraft('See @x.md', [{ path: 'x.md' }]);
  const restarted = composerOf(chat);
  assert.match(
    restarted.checkMentions('/elsewhere')!,
    /^Moonbase can't tell which folder a mention was picked in, as after a restart, so it is now taken as a file in \/elsewhere\. Send again/,
  );
  assert.equal(chat.getSnapshot().draft, 'See @x.md');
  assert.equal(restarted.checkMentions('/elsewhere'), null);
});

test('the same path picked in two folders is refused rather than merged', () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  chat.setDraft('Compare @src/x.ts', [{ path: 'src/x.ts' }]);
  composer.noteMentions(['src/x.ts'], '/repoA');
  assert.equal(
    composer.findMentionClash('src/x.ts', '/repoB'),
    "The draft already mentions src/x.ts in /repoA, so the one in /repoB can't be mentioned too.",
  );
  assert.equal(composer.findMentionClash('src/x.ts', '/repoA'), null);
  assert.equal(composer.findMentionClash('src/y.ts', '/repoB'), null);
  // Once the mention is gone, the path is free in any folder.
  chat.setDraft('Compare');
  assert.equal(composer.findMentionClash('src/x.ts', '/repoB'), null);
});

test('a sent or emptied new chat draft forgets its mentions’ folders', async () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  chat.setDraft('Fix @a.ts', [{ path: 'a.ts' }]);
  composer.noteMentions(['a.ts'], '/notes');
  composer.updatePlace('agents', '', { cwd: '/notes' });
  assert.equal(composer.checkMentions('/notes'), null);
  await chat.send({ cwd: '/notes', ...settings });
  // `/new` from a chat whose folder hasn't loaded doesn't inherit the sent draft's folders.
  chat.setDraft('/new\nAgain @a.ts', [{ path: 'a.ts' }]);
  assert.equal(await composer.startNewChat('Again @a.ts', [{ path: 'a.ts' }], undefined), null);
  assert.match(composer.checkMentions('/repo')!, /can't tell which folder/);
  assert.equal(chat.getSnapshot().draft, 'Again @a.ts');
});

test('a draft that refuses the rewrite holds the send and keeps the mentions’ folders', () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  chat.setDraft('Fix @a.ts', [{ path: 'a.ts' }]);
  composer.noteMentions(['a.ts'], '/notes');
  chat.rejectNextDraft();
  assert.match(composer.checkMentions('/repo')!, /couldn't be made relative/);
  assert.equal(chat.getSnapshot().draft, 'Fix @a.ts');
  // The mention is still known to be in /notes.
  assert.match(composer.checkMentions('/repo')!, /isn't in \/repo/);
  assert.equal(chat.getSnapshot().draft, 'Fix /notes/a.ts');
});

test('/new carries the rest of the message to the new chat and empties the open one', async () => {
  const chat = makeChat(target('open'));
  const composer = composerOf(chat);
  chat.setDraft('/new\nLook at @src/a.ts', [{ path: 'src/a.ts' }]);
  assert.equal(
    await composer.startNewChat('Look at @src/a.ts', [{ path: 'src/a.ts' }], '/repo-wt'),
    null,
  );
  assert.equal(chat.getSnapshot().selected, null);
  assert.deepEqual(chat.drafts.get('open'), { text: '', mentions: [] });
  assert.equal(chat.getSnapshot().draft, 'Look at @src/a.ts');
  assert.deepEqual(chat.getSnapshot().mentions, [{ path: 'src/a.ts' }]);
  // Its mentions stay in the open chat's folder: sending elsewhere says so before sending.
  assert.match(composer.checkMentions('/repo')!, /isn't in \/repo/);
  assert.equal(chat.getSnapshot().draft, 'Look at /repo-wt/src/a.ts');

  // A new chat draft already there keeps its text, and the rest follows it.
  chat.setDraft('Mine @b.ts', [{ path: 'b.ts' }]);
  composer.noteMentions(['b.ts'], '/repo');
  await chat.select(target('second'));
  chat.setDraft('/new\nAnd @README.md', [{ path: 'README.md' }]);
  await composer.startNewChat('And @README.md', [{ path: 'README.md' }], '/repo');
  assert.equal(chat.getSnapshot().draft, 'Mine @b.ts\nAnd @README.md');
  assert.deepEqual(chat.getSnapshot().mentions, [{ path: 'b.ts' }, { path: 'README.md' }]);
  assert.equal(composer.checkMentions('/repo'), null);
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
  // The same spelling mentioning a file in another folder can't join the new chat's draft.
  await chat.closeView();
  chat.setDraft('See @a.ts', [{ path: 'a.ts' }]);
  composer.noteMentions(['a.ts'], '/notes');
  await chat.select(target('open'));
  chat.setDraft('/new\nAnd @a.ts', [{ path: 'a.ts' }]);
  assert.match(
    (await composer.startNewChat('And @a.ts', [{ path: 'a.ts' }], '/repo'))!,
    /already mentions a\.ts in another folder/,
  );
  assert.equal(chat.getSnapshot().draft, 'And @a.ts');
  assert.equal(chat.drafts.get('')!.text, 'See @a.ts');
  // A view that can't close keeps the rest in the open chat too.
  chat.setDraft('/new\nStill here');
  chat.failNextClose();
  assert.equal(await composer.startNewChat('Still here', [], '/repo'), null);
  assert.equal(chat.getSnapshot().selected?.conversationId, 'open');
  assert.equal(chat.getSnapshot().draft, 'Still here');
});

test('/new after a restart joins a draft whose mention folders are unknown, for Send to ask', async () => {
  const chat = makeChat();
  chat.setDraft('See @a.ts', [{ path: 'a.ts' }]);
  await chat.select(target('open'));
  chat.setDraft('/new\nAnd @a.ts', [{ path: 'a.ts' }]);
  const restarted = composerOf(chat);
  assert.equal(await restarted.startNewChat('And @a.ts', [{ path: 'a.ts' }], '/repo'), null);
  assert.equal(chat.getSnapshot().draft, 'See @a.ts\nAnd @a.ts');
});
