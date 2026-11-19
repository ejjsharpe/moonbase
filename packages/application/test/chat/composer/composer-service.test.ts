import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findChatMentionStarts,
  type ChatCreationSettings,
  type ChatMention,
  type ChatTarget,
} from '@moonbase/contracts/chat';
import { Effect, Fiber, Queue, Scope, Stream, SubscriptionRef } from 'effect';
import { CancelledError, UnauthorizedError, UncertainError } from '@moonbase/contracts/errors';
import { WorkspaceConflictError } from '@moonbase/contracts/workspace-host-errors';
import {
  ChatComposers,
  NewChatDraftError,
  findMentionClash,
  readChoices,
  type ComposerChat,
  type ComposerPlace,
} from '@moonbase/application/chat';

const target = (conversationId: string) =>
  ({ conversationId, session: { actorId: 'a', hostId: 'h', storeId: 's' } }) as never as ChatTarget;
const settings = { model: { provider: 'faux', modelId: 'faux-1' } };

/**
 * A chat's draft rules in memory: one draft per chat and one for a new chat. A new chat's send
 * creates a chat in its folder and opens it, as the chat does once the host confirms it.
 */
function makeChat(selected: ChatTarget | null = null) {
  const drafts = new Map<string, { text: string; mentions: ChatMention[] }>();
  const chats: { target: ChatTarget; cwd: string }[] = [];
  const key = () => selected?.conversationId ?? '';
  const sent: { cwd?: string; draft: string; mentions: ChatMention[] }[] = [];
  const listeners = new Set<() => void>();
  let failMove = false,
    failSend = false,
    rejectDraft = false,
    holdClose: Promise<void> | undefined;
  const notify = () => listeners.forEach((listener) => listener());
  const chat = {
    sent,
    drafts,
    /** Closes that finished. */
    closes: 0,
    /** The next move of a draft to the new chat can't be written. */
    failNextMove: () => (failMove = true),
    /** The next close waits for `released`, as a transcript closing does. */
    holdNextClose: (released: Promise<void>) => (holdClose = released),
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
        chats.push({ target: target(`created-${chats.length}`), cwd: creation!.cwd! });
        selected = chats.at(-1)!.target;
      }
      notify();
    },
    /** Deselects the open chat, empties its draft and joins the new chat's, in one step. */
    moveToNewChat(join: (draft: { text: string; mentions: readonly ChatMention[] }) => unknown) {
      if (failMove) return (failMove = false);
      const joined = join(drafts.get('') ?? { text: '', mentions: [] });
      if (joined instanceof Error) return joined;
      drafts.delete(key());
      drafts.set('', joined as { text: string; mentions: ChatMention[] });
      selected = null;
      notify();
      return true;
    },
    closeView: async () => {
      const held = holdClose;
      holdClose = undefined;
      await held;
      selected = null;
      chat.closes++;
      notify();
    },
    select: async (next: ChatTarget) => {
      selected = next;
      notify();
    },
  };
  return chat;
}
const agents: ComposerPlace = { key: 'agents', initialCwd: '' };
const dockB: ComposerPlace = { key: 'dock:/b', initialCwd: '/b' };
/** What the composer uses of the in-memory chat. */
const toComposerChat = (chat: ReturnType<typeof makeChat>): ComposerChat => ({
  state: Effect.sync(() => chat.getSnapshot() as never),
  changes: Stream.callback<void>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => chat.subscribe(() => Queue.offerUnsafe(queue, undefined))),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  ),
  setDraft: (text, mentions) => Effect.sync(() => chat.setDraft(text, mentions)),
  moveToNewChat: (join) =>
    Effect.suspend(() => {
      const moved = chat.moveToNewChat(join);
      return moved instanceof NewChatDraftError ? Effect.fail(moved) : Effect.succeed(!!moved);
    }),
  send: (creation) => Effect.promise(() => chat.send(creation)),
  closeView: Effect.promise(() => chat.closeView()),
  select: (next) => Effect.promise(() => chat.select(next)),
});
/** A composer for `chat`, in a scope the test leaves open. */
function composerOf(chat: ReturnType<typeof makeChat>) {
  const composer = Effect.runSync(
    Effect.flatMap(ChatComposers, (composers: ChatComposers['Service']) =>
      composers.make(toComposerChat(chat)),
    ).pipe(
      Effect.provideService(Scope.Scope, Scope.makeUnsafe()),
      Effect.provide(ChatComposers.layer),
    ),
  );
  const sync = <A>(effect: Effect.Effect<A>) => Effect.runSync(effect);
  return {
    composer,
    sync,
    get snapshot() {
      return SubscriptionRef.getUnsafe(composer.state);
    },
    /** The message's text, wherever it applies. */
    get message() {
      return SubscriptionRef.getUnsafe(composer.state).message?.text ?? null;
    },
    place: (place: ComposerPlace) => readChoices(SubscriptionRef.getUnsafe(composer.state), place),
    checkMentions: (folder: string) => sync(composer.checkMentions(folder)),
    noteMentions: (paths: string[], folder: string) => sync(composer.noteMentions(paths, folder)),
    startNewChat: (text: string, mentions: ChatMention[], folder: string | undefined) =>
      Effect.runPromise(composer.startNewChat(text, mentions, folder)),
    /** Sends the new chat in `place`, making a worktree with `create` if the place chose one. */
    send: (
      place: ComposerPlace,
      create?: (root: string, branch: string, id: string) => Promise<string>,
    ) =>
      sync(
        composer.send(place, {
          selection: settings,
          ...(create
            ? {
                createWorktree: (root: string, branch: string, id: string) =>
                  Effect.tryPromise({ try: () => create(root, branch, id), catch: (e) => e }),
              }
            : {}),
        }),
      ),
  };
}
type Composer = ReturnType<typeof composerOf>;
/** Waits, a turn at a time, for the composer's fibers to reach `done`. */
async function until(done: () => boolean) {
  for (let turn = 0; turn < 50 && !done(); turn++)
    await new Promise((resolve) => setTimeout(resolve));
  assert.ok(done());
}
/** Starts a worktree send from Agents in `/repo`, resolved or rejected when the test says. */
function startWorktree(composer: Composer) {
  composer.sync(composer.composer.choose(agents, { cwd: '/repo', newWorktree: true }));
  const made = Promise.withResolvers<string>();
  composer.send(agents, () => made.promise);
  return made;
}

test('a place keeps its new chat folder, worktree choice and message across views', () => {
  const composer = composerOf(makeChat());
  assert.deepEqual(composer.place(agents), { cwd: '', newWorktree: false });
  composer.sync(composer.composer.choose(agents, { cwd: '/repo', newWorktree: true }));
  composer.sync(composer.composer.report({ chat: '', place: dockB.key, text: 'Nope' }));
  assert.deepEqual(composer.place(agents), { cwd: '/repo', newWorktree: true });
  assert.deepEqual(composer.place(dockB), { cwd: '/b', newWorktree: false });
  assert.deepEqual(composer.snapshot.message, { chat: '', place: dockB.key, text: 'Nope' });
  // Dismissing another place's message leaves it.
  composer.sync(composer.composer.dismiss({ chat: '', place: agents.key }));
  assert.equal(composer.message, 'Nope');
});

test('a worktree made after its view went away still sends, then the place returns to its folder', async () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  chat.setDraft('Tidy @src/a.ts', [{ path: 'src/a.ts' }]);
  composer.noteMentions(['src/a.ts'], '/repo');
  composer.sync(composer.composer.choose(agents, { cwd: '/repo', newWorktree: true }));
  const made = Promise.withResolvers<string>();
  const asked: string[] = [];
  composer.send(agents, (root, branch) => {
    asked.push(`${root} ${branch}`);
    return made.promise;
  });
  assert.equal(composer.snapshot.creatingWorktree, true);
  // A second Send while Git works makes no second worktree.
  composer.send(agents, () => Promise.reject(Error('second')));
  assert.deepEqual(asked, ['/repo chat/tidy']);
  // No view is subscribed any more; the creation still completes.
  made.resolve('/repo-worktrees/chat-tidy');
  await until(() => !composer.snapshot.creatingWorktree);
  // The worktree holds the checkout's files at the same paths, so its mentions stay.
  assert.deepEqual(chat.sent, [
    { cwd: '/repo-worktrees/chat-tidy', draft: 'Tidy @src/a.ts', mentions: [{ path: 'src/a.ts' }] },
  ]);
  // The chat was created, so the next new chat starts in the folder the worktree was made from.
  await until(() => composer.place(agents).cwd === '/repo');
  assert.deepEqual(composer.place(agents), { cwd: '/repo', newWorktree: false });
});

test('a worktree whose send isn’t confirmed keeps the place on it, until a retry creates the chat', async () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  chat.setDraft('Fix it');
  chat.failNextSend();
  const made = startWorktree(composer);
  made.resolve('/repo-worktrees/chat-fix-it');
  await until(() => !composer.snapshot.creatingWorktree);
  // Another chat opened meanwhile doesn't count as the worktree's chat.
  await chat.select(target('other'));
  await until(() => composer.snapshot.message === null);
  assert.equal(composer.place(agents).cwd, '/repo-worktrees/chat-fix-it');
  chat.listChat('/repo-worktrees/chat-fix-it');
  await until(() => composer.place(agents).cwd === '/repo');
});

test('a worktree send whose outcome is unknown is retried under its request; any other outcome or draft starts a new one', async () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  chat.setDraft('Fix it');
  composer.sync(composer.composer.choose(agents, { cwd: '/repo', newWorktree: true }));
  const requests: string[] = [];
  const send = async (failure?: Error) => {
    composer.send(agents, async (_root, _branch, requestId) => {
      requests.push(requestId);
      if (failure) throw failure;
      return '/repo-worktrees/chat-fix-it';
    });
    await until(() => !composer.snapshot.creatingWorktree);
  };
  const uncertain = new UncertainError({ operation: 'Create worktree' });
  await send(uncertain);
  await send(new CancelledError({ operation: 'Create worktree' }));
  await send(new WorkspaceConflictError({ conflict: 'location-exists' }));
  await send(uncertain);
  chat.setDraft('Fix another');
  await send();
  assert.equal(requests.length, 5);
  assert.equal(new Set(requests.slice(0, 3)).size, 1);
  assert.equal(new Set(requests.slice(2)).size, 3);
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
  await until(() => !composer.snapshot.creatingWorktree);
  assert.deepEqual(chat.sent, []);
  assert.match(composer.message!, /ready at \/wt/);
  await chat.closeView();
  const cwd = composer.place(agents).cwd;
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
  await until(() => !composer.snapshot.creatingWorktree);
  // For the new chat in every place.
  assert.equal(composer.snapshot.message?.chat, '');
  assert.equal(composer.snapshot.message?.place, undefined);
  assert.match(composer.message!, /\/repo-worktrees\/chat-fix-it/);
  // Moving between open chats, or back to the new chat, keeps it to be seen.
  await chat.select(target('another'));
  await chat.closeView();
  await new Promise((resolve) => setTimeout(resolve));
  assert.match(composer.message!, /ready at/);
  // Leaving the new chat for a chat clears it.
  await chat.select(target('other'));
  await until(() => composer.message === null);

  await chat.closeView();
  chat.setDraft('Fix it');
  const failing = Promise.withResolvers<string>();
  composer.sync(composer.composer.choose(dockB, { newWorktree: true }));
  composer.sync(composer.composer.report({ chat: '', place: dockB.key, text: 'Old' }));
  composer.send(dockB, () => failing.promise);
  assert.equal(composer.message, null);
  failing.reject(Error('Git said no.'));
  await until(() => !composer.snapshot.creatingWorktree);
  assert.equal(composer.message, 'The worktree could not be created. Git said no.');
  assert.deepEqual(composer.place(dockB), { cwd: '/b', newWorktree: true });
  composer.sync(composer.composer.dismiss({ chat: '', place: dockB.key }));
  assert.equal(composer.message, null);
  // A host's refusal shows the chat's fixed text, not the operation it names.
  const refused = Promise.withResolvers<string>();
  composer.send(dockB, () => refused.promise);
  refused.reject(new UnauthorizedError({ operation: 'checkApprovedFolder' }));
  await until(() => !composer.snapshot.creatingWorktree);
  assert.equal(
    composer.message,
    'The worktree could not be created. This request is not authorized.',
  );
  composer.sync(composer.composer.dismiss({ chat: '', place: dockB.key }));
  // Leaving the new chat for a chat clears every place's messages too.
  composer.sync(composer.composer.report({ chat: '', place: agents.key, text: 'Stale' }));
  await chat.select(target('third'));
  await until(() => composer.message === null);
});

test('files from the tree join the draft relative to its folder, or say why not', async () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  const mention = (files: string[]) => composer.sync(composer.composer.mention(dockB, files));
  mention(['/b/src/a.ts', '/elsewhere/x.ts']);
  assert.equal(chat.getSnapshot().draft, '@src/a.ts ');
  assert.deepEqual(composer.snapshot.folders, { 'src/a.ts': '/b' });
  assert.equal(composer.snapshot.message?.chat, '');
  assert.match(composer.message!, /outside/);
  // A mention that lands clears the message; one the draft has from another folder can't.
  composer.noteMentions(['src/a.ts'], '/a');
  mention(['/b/src/a.ts']);
  assert.equal(chat.getSnapshot().draft, '@src/a.ts ');
  assert.match(composer.message!, /src\/a\.ts/);
  // An open chat whose folder hasn't loaded mentions nothing.
  await chat.select(target('open'));
  mention(['/b/c.ts']);
  assert.equal(chat.getSnapshot().draft, '');
  assert.equal(composer.snapshot.message?.chat, 'open');
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
  composer.sync(composer.composer.choose(agents, { cwd: '/notes' }));
  composer.send(agents);
  assert.equal(composer.snapshot.message?.place, 'agents');
  assert.deepEqual(chat.sent, []);
  assert.equal(chat.getSnapshot().draft, 'Fix @index.md and /repo/src/a.ts');
  assert.deepEqual(chat.getSnapshot().mentions, [{ path: 'index.md' }]);
  // Now every mention is relative to it, so the next Send goes ahead.
  assert.equal(composer.checkMentions('/notes'), null);
  assert.equal(chat.getSnapshot().draft, 'Fix @index.md and /repo/src/a.ts');
  // A chat without a project runs in a new empty folder, so a picked file is written out in full.
  chat.setDraft('Plan from @plan.md', [{ path: 'plan.md' }]);
  composer.noteMentions(['plan.md'], '/notes');
  assert.equal(
    composer.checkMentions(''),
    "A mentioned file isn't in the chat’s new folder, so it is written out as a full path instead. Send again to send the message.",
  );
  assert.equal(chat.getSnapshot().draft, 'Plan from /notes/plan.md');
  assert.deepEqual(chat.getSnapshot().mentions, []);
  assert.equal(composer.checkMentions(''), null);
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
  const clash = (path: string, folder: string) =>
    findMentionClash(composer.snapshot.folders, chat.getSnapshot(), path, folder);
  assert.equal(
    clash('src/x.ts', '/repoB'),
    "The draft already mentions src/x.ts in /repoA, so the one in /repoB can't be mentioned too.",
  );
  assert.equal(clash('src/x.ts', '/repoA'), null);
  assert.equal(clash('src/y.ts', '/repoB'), null);
  // Once the mention is gone, the path is free in any folder.
  chat.setDraft('Compare');
  assert.equal(clash('src/x.ts', '/repoB'), null);
});

test('a sent or emptied new chat draft forgets its mentions’ folders', async () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  chat.setDraft('Fix @a.ts', [{ path: 'a.ts' }]);
  composer.noteMentions(['a.ts'], '/notes');
  composer.sync(composer.composer.choose(agents, { cwd: '/notes' }));
  composer.send(agents);
  assert.equal(chat.sent.length, 1);
  // `/new` from a chat whose folder hasn't loaded doesn't inherit the sent draft's folders.
  chat.setDraft('/new\nAgain @a.ts', [{ path: 'a.ts' }]);
  assert.equal(await composer.startNewChat('Again @a.ts', [{ path: 'a.ts' }], undefined), true);
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
    true,
  );
  assert.equal(chat.getSnapshot().selected, null);
  assert.equal(chat.drafts.has('open'), false);
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

test('/new moves the rest before the chat closes, so a view gone meanwhile loses nothing', async () => {
  const chat = makeChat(target('open'));
  const composer = composerOf(chat);
  chat.setDraft('/new\nKeep this');
  const released = Promise.withResolvers<void>();
  chat.holdNextClose(released.promise);
  // The view that typed `/new` unmounts while the transcript closes.
  const view = Effect.runFork(composer.composer.startNewChat('Keep this', [], '/repo'));
  await until(() => chat.getSnapshot().draft === 'Keep this' && !chat.getSnapshot().selected);
  await Effect.runPromise(Fiber.interrupt(view));
  assert.equal(chat.drafts.has('open'), false);
  assert.equal(chat.drafts.get('')?.text, 'Keep this');
  // The composer still closes the chat it left.
  released.resolve();
  await until(() => chat.closes === 1);
  assert.equal(chat.getSnapshot().draft, 'Keep this');
});

test('a chat turning into a project outlives the view that asked, once at a time', async () => {
  const chat = makeChat(target('open'));
  const composer = composerOf(chat);
  const held = Promise.withResolvers<void>();
  let turns = 0;
  const turn = Effect.promise(() => (turns++, held.promise));
  const view = Effect.runFork(composer.composer.turnIntoProject('open', turn));
  await until(() => turns === 1);
  await Effect.runPromise(Fiber.interrupt(view));
  assert.deepEqual(composer.snapshot.turning, ['open']);
  composer.sync(composer.composer.turnIntoProject('open', turn));
  held.resolve();
  await until(() => composer.snapshot.turning.length === 0);
  assert.equal(turns, 1);
});

test('/new keeps the rest in the open chat when the new chat cannot take it', async () => {
  const chat = makeChat();
  const composer = composerOf(chat);
  chat.setDraft('x'.repeat(32 * 1024 - 2));
  await chat.select(target('open'));
  chat.setDraft('/new\nMore');
  assert.equal(await composer.startNewChat('More', [], '/repo'), false);
  // The message is for the open chat while it still holds the rest.
  assert.equal(composer.snapshot.message?.chat, 'open');
  assert.equal(composer.snapshot.message?.draft, 'More');
  assert.equal(chat.getSnapshot().selected?.conversationId, 'open');
  assert.equal(chat.getSnapshot().draft, 'More');
  assert.equal(chat.drafts.get('')!.text.length, 32 * 1024 - 2);
  // The same spelling mentioning a file in another folder can't join the new chat's draft.
  await chat.closeView();
  chat.setDraft('See @a.ts', [{ path: 'a.ts' }]);
  composer.noteMentions(['a.ts'], '/notes');
  await chat.select(target('open'));
  chat.setDraft('/new\nAnd @a.ts', [{ path: 'a.ts' }]);
  assert.equal(await composer.startNewChat('And @a.ts', [{ path: 'a.ts' }], '/repo'), false);
  assert.match(composer.message!, /already mentions a\.ts in another folder/);
  assert.equal(chat.getSnapshot().draft, 'And @a.ts');
  assert.equal(chat.drafts.get('')!.text, 'See @a.ts');
  // A chat whose drafts can't move keeps the rest in the open chat too.
  chat.setDraft('/new\nStill here');
  chat.failNextMove();
  assert.equal(await composer.startNewChat('Still here', [], '/repo'), true);
  assert.equal(chat.getSnapshot().selected?.conversationId, 'open');
  assert.equal(chat.getSnapshot().draft, 'Still here');
});

test('/new after a restart joins a draft whose mention folders are unknown, for Send to ask', async () => {
  const chat = makeChat();
  chat.setDraft('See @a.ts', [{ path: 'a.ts' }]);
  await chat.select(target('open'));
  chat.setDraft('/new\nAnd @a.ts', [{ path: 'a.ts' }]);
  const restarted = composerOf(chat);
  assert.equal(await restarted.startNewChat('And @a.ts', [{ path: 'a.ts' }], '/repo'), true);
  assert.equal(chat.getSnapshot().draft, 'See @a.ts\nAnd @a.ts');
});
