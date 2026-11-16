import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import { isEditorError } from '@moonbase/application/editor';
import { fauxChat, makeApplication } from './application-fixture.ts';

const isLifecycleError = (reason: string) => (error: unknown) =>
  (error as { _tag?: string; reason?: string })._tag === 'ApplicationLifecycleError' &&
  (error as { reason?: string }).reason === reason;

test('an editor application unloads once every edit is in recovery', async () => {
  const f = makeApplication({ editor: true });
  try {
    await f.start();
    await f.editor.openCheckout();
    await f.editor.open();
    await f.editor.edit('kept');
    assert.equal(f.canUnload(), false);
    await f.editor.flush();
    assert.equal(f.canUnload(), true);
    assert.deepEqual(await f.editor.drafts(), ['kept']);
    // The unload check reopens admissions once it has looked.
    assert.equal(await f.editor.admissionsOpen(), true);
  } finally {
    await f.dispose();
  }
});

test('a chat-only application needs its chat, and shows no private failure text', async () => {
  const failing = makeApplication({ chat: Effect.fail(Error('private-provider-key')) });
  await assert.rejects(failing.start(), (error: Error) =>
    isLifecycleError('unavailable')(error) && !error.message.includes('private-provider-key'),
  );
  await failing.dispose();
  const absent = makeApplication({ chat: Effect.succeed(null) });
  await assert.rejects(absent.start(), isLifecycleError('unavailable'));
  await absent.dispose();
  const nothing = makeApplication({});
  await assert.rejects(nothing.start(), isLifecycleError('nothing-composed'));
  await nothing.dispose();
  const invalid = makeApplication({
    chatTargets: [
      { id: 'same', label: 'One', acquire: Effect.succeed(null) },
      { id: 'same', label: 'Two', acquire: Effect.succeed(null) },
    ],
  });
  await assert.rejects(invalid.start(), isLifecycleError('invalid-targets'));
  await invalid.dispose();
});

test('a chat that fails to open stays visible and keeps the editor usable but blocks Quit', async () => {
  const f = makeApplication({ editor: true, chat: Effect.fail(Error('private-provider-key')) });
  try {
    await f.start();
    const { chat } = await f.snapshot();
    assert.equal(chat.state, 'initialization-failed');
    assert(chat.error && !chat.error.includes('private-provider-key'));
    await f.editor.openCheckout();
    assert.equal(f.canUnload(), false);
    assert.equal(await f.prepareQuit(), false);
    assert.equal((await f.snapshot()).phase, 'live');
    assert.equal(await f.editor.admissionsOpen(), true);
  } finally {
    await f.dispose();
  }
});

test('unreadable saved chat drafts block close, unload and Quit and are never overwritten', async () => {
  const chat = fauxChat();
  chat.storage.value = '{unfamiliar saved evidence';
  const f = makeApplication({ chat: Effect.succeed(chat.dependencies) });
  try {
    await f.start();
    assert((await f.chat())!.getSnapshot().storageError);
    assert.equal((await f.snapshot()).chat.state, 'ready');
    assert.equal(f.canUnload(), false);
    assert.equal(await f.app((a) => a.closeChat), false);
    assert.equal(await f.prepareQuit(), false);
    assert.equal(chat.storage.value, '{unfamiliar saved evidence');
    assert.equal(chat.storage.writes, 0);
  } finally {
    await f.dispose();
  }
});

test('a vetoed Quit restores admissions; a consented one fences the editor and the chat', async () => {
  const chat = fauxChat();
  const f = makeApplication({ editor: true, chat: Effect.succeed(chat.dependencies) });
  try {
    await f.start();
    await f.editor.openCheckout();
    await f.editor.open();
    await f.editor.edit('dirty');
    const controller = (await f.chat())!;
    await controller.start();
    await controller.connect();
    await controller.select(chat.target);

    const first = f.prepareQuit();
    const second = f.prepareQuit();
    const prompt = (await f.editor.closePrompt())!;
    controller.setDraft('during prompt');
    await f.editor.answer(prompt.id, 'cancel');
    assert.equal(await first, false);
    assert.equal(await second, false, 'a Quit asked for meanwhile joins the running one');
    assert.equal((await f.snapshot()).phase, 'live');
    await f.editor.edit('still live');

    const quit = f.prepareQuit();
    await f.editor.answer((await f.editor.closePrompt())!.id, 'discard');
    assert.equal(await quit, true);
    assert.equal((await f.snapshot()).phase, 'prepared');

    const raw = chat.storage.value,
      calls = chat.calls.length;
    controller.setDraft('blocked');
    await controller.send();
    assert.equal(chat.storage.value, raw);
    assert.equal(chat.calls.length, calls);
    await assert.rejects(f.editor.edit('blocked'), (error) => isEditorError(error));
    assert.equal(await f.editor.text(), 'original');
    assert.equal(await f.app((a) => a.closeChat), false);
    await assert.rejects(f.app((a) => a.openChat), isLifecycleError('closing'));
    assert.equal(f.canUnload(), true);
  } finally {
    await f.dispose();
  }
});

for (const fails of [false, true])
  test(`a closed chat owns its release, which blocks reopening until it ends (release fails: ${fails})`, async () => {
    const chat = fauxChat(),
      held = Promise.withResolvers<void>();
    const f = makeApplication({ editor: true, chat: Effect.succeed(chat.dependencies) });
    try {
      await f.start();
      const old = (await f.chat())!;
      await old.start();
      await old.connect();
      await old.select(chat.target);
      chat.controls.release = () => held.promise;
      assert.equal(await f.app((a) => a.closeChat), true);
      assert.equal(await f.chat(), null);
      assert.deepEqual((await f.snapshot()).cleanup.pending, ['chat']);
      await assert.rejects(
        f.app((a) => a.openChat),
        isLifecycleError('cleanup-pending'),
      );
      // The released chat writes nothing more.
      const writes = chat.storage.writes;
      old.setDraft('late');
      assert.equal(chat.storage.writes, writes);
      if (fails)
        held.reject(new ApplicationError({ code: 'Persistence', message: 'Cleanup failed safely' }));
      else held.resolve();
      await f.cleanupSettled();
      if (fails) {
        const snapshot = await f.snapshot();
        assert.equal(snapshot.chat.state, 'cleanup-blocked');
        assert(snapshot.cleanup.errors.some((message) => message.includes('Cleanup failed safely')));
        await assert.rejects(
          f.app((a) => a.openChat),
          isLifecycleError('cleanup-pending'),
        );
        await assert.rejects(f.app((a) => a.release), isLifecycleError('cleanup-failed'));
        assert.equal((await f.snapshot()).phase, 'failed');
      } else assert(await f.app((a) => a.openChat));
    } finally {
      await f.dispose();
    }
  });

test('opens asked for together share one acquisition, and Quit waits for it', async () => {
  const chat = fauxChat(),
    held = Promise.withResolvers<typeof chat.dependencies | null>();
  let opens = 0;
  const f = makeApplication({
    chat: Effect.promise(() => (++opens === 1 ? Promise.resolve(chat.dependencies) : held.promise)),
  });
  try {
    await f.start();
    assert.equal(await f.app((a) => a.closeChat), true);
    await f.cleanupSettled();
    const opening = f.app((a) => a.openChat);
    const again = f.app((a) => a.openChat);
    const quit = f.prepareQuit();
    held.resolve(chat.dependencies);
    const [first, second] = await Promise.all([opening, again]);
    assert(first);
    assert.equal(first, second);
    assert.equal(await quit, true);
    assert.equal(opens, 2);
    const writes = chat.storage.writes;
    first.setDraft('blocked');
    assert.equal(chat.storage.writes, writes);
  } finally {
    await f.dispose();
  }
});

test('named targets keep separate drafts and switch only once the old chat is released', async () => {
  const local = fauxChat(),
    remote = fauxChat();
  const localDependencies = { ...local.dependencies, connection: undefined };
  const localChat = localDependencies.chat;
  localDependencies.chat = {
    ...localChat,
    command: async (op, input, options) =>
      op === 'getChatHost'
        ? ({ ...localDependencies.context, mode: 'local' } as never)
        : localChat.command(op, input, options),
  };
  const f = makeApplication({
    chatTargets: [
      { id: 'local', label: 'Local', acquire: Effect.succeed(localDependencies) },
      { id: 'remote', label: 'Remote', acquire: Effect.succeed(remote.dependencies) },
    ],
  });
  try {
    await f.start();
    assert.equal((await f.snapshot()).chatTargetId, 'local');
    const first = (await f.chat())!;
    await first.start();
    await first.create('Local', { cwd: '/local', model: { provider: 'fake', modelId: 'first' } });
    first.setDraft('local draft');
    const held = Promise.withResolvers<void>();
    local.controls.release = () => held.promise;
    const switching = f.app((a) => a.selectChatTarget('remote'));
    assert.equal(f.canUnload(), false);
    await assert.rejects(
      f.app((a) => a.selectChatTarget('local')),
      isLifecycleError('target-unavailable'),
    );
    held.resolve();
    const second = (await switching)!;
    assert.equal((await f.snapshot()).chatTargetId, 'remote');
    await second.start();
    await second.connect();
    await second.create('Remote', { cwd: '/remote', model: { provider: 'fake', modelId: 'first' } });
    second.setDraft('remote draft');
    const back = (await f.app((a) => a.selectChatTarget('local')))!;
    assert.equal(back.getSnapshot().draft, 'local draft');
    assert.equal(JSON.parse(remote.storage.value!).drafts[0].text, 'remote draft');
    assert(![...local.calls, ...remote.calls].some((call) => ['sendChat', 'stopChat'].includes(call)));
  } finally {
    await f.dispose();
  }
});

test('release ends the chat first and leaves the editor fenced until it closes', async () => {
  const chat = fauxChat();
  const f = makeApplication({ editor: true, chat: Effect.succeed(chat.dependencies) });
  try {
    await f.start();
    await f.editor.openCheckout();
    await f.app((a) => a.release);
    const snapshot = await f.snapshot();
    assert.equal(snapshot.phase, 'disposed');
    assert.equal(await f.chat(), null, 'the chat was released');
    assert.equal(await f.editor.admissionsOpen(), false);
    assert.equal(f.canUnload(), false);
  } finally {
    await f.dispose();
  }
});
