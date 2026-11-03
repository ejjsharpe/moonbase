import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMoonbaseApplication, type MoonbaseApplication } from '@moonbase/application';
import { ApplicationError } from '@moonbase/contracts/errors';
import { emptyRecovery, type EditorClient, type CommandInput } from '@moonbase/contracts/workspace';
import type { EditorController, ClosePrompt } from '@moonbase/application/editor';
import { chatCapabilities, editorCapabilities, checkout, target } from './application-fixture.ts';

async function tick() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
async function cleanupSettled(app: MoonbaseApplication) {
  if (!app.getSnapshot().cleanup.pending.length) return;
  const done = Promise.withResolvers<void>();
  const off = app.subscribe(() => {
    if (!app.getSnapshot().cleanup.pending.length) done.resolve();
  });
  try {
    await done.promise;
  } finally {
    off();
  }
}

function closePrompt(editor: EditorController): Promise<ClosePrompt> {
  const current = editor.getSnapshot().closePrompt;
  if (current) return Promise.resolve(current);
  const prompt = Promise.withResolvers<ClosePrompt>();
  const off = editor.subscribe(() => {
    const current = editor.getSnapshot().closePrompt;
    if (current) prompt.resolve(current);
  });
  return prompt.promise.finally(off);
}

test('public factory composes independent editors and optional chat without remote admissions', async () => {
  const editor = editorCapabilities(),
    chat = chatCapabilities();
  const app = await createMoonbaseApplication({
    editors: [
      { client: editor.client, clientId: 'one' },
      { client: editor.client, clientId: 'two' },
    ],
    chat: async () => chat.dependencies,
  });
  try {
    assert.equal(app.editors.length, 2);
    assert.notEqual(app.editors[0].instanceId, app.editors[1].instanceId);
    assert(app.editors.every((model) => model.getSnapshot().ready));
    assert.deepEqual(chat.calls, []);
    await app.editors[0].openCheckout(checkout.root);
    await app.editors[0].open(target);
    app.editors[0].edit(target, 'first only');
    assert.equal(app.editors[1].buffer(target), undefined);
    assert.equal(app.canUnload(), false);
    for (const model of app.editors) await model.flush();
    assert.equal(app.canUnload(), true);
  } finally {
    await app.dispose();
    await editor.runtime.dispose();
  }
});

test('throwing chat view subscribers cannot veto unload or Quit after a successful draft write', async () => {
  const chat = chatCapabilities();
  const app = await createMoonbaseApplication({ chat: async () => chat.dependencies });
  try {
    const controller = app.chat!;
    await controller.start();
    await controller.connect();
    await tick();
    await controller.select(chat.target);
    let notifications = 0;
    controller.subscribe(() => {
      if (++notifications > 1) throw Error('Controlled view failure after draft update');
    });
    controller.setDraft('Retained draft');
    assert.equal(JSON.parse(chat.storage.value!).drafts[0].text, 'Retained draft');
    assert.equal(controller.getSnapshot().storageError, null);
    assert.equal(app.canUnload(), true);
    assert.equal(await app.prepareQuit(), true);
  } finally {
    await app.dispose();
  }
});

test('sole chat is required, combined optional startup failure stays visible and keeps editor usable', async () => {
  const editor = editorCapabilities();
  const fail = async () => {
    throw Error('private-provider-key');
  };
  const app = await createMoonbaseApplication({
    editors: [{ client: editor.client, clientId: 'one' }],
    chat: fail,
  });
  try {
    assert.equal(app.getSnapshot().chat.state, 'initialization-failed');
    assert(!app.getSnapshot().chat.error?.includes('private-provider-key'));
    await app.editors[0].openCheckout(checkout.root);
    assert.equal(app.canUnload(), false);
    assert.equal(await app.prepareQuit(), false);
    assert.equal(app.getSnapshot().phase, 'live');
  } finally {
    await app.dispose();
    await editor.runtime.dispose();
  }
  await assert.rejects(
    createMoonbaseApplication({ chat: fail }),
    (error) => ApplicationError.is(error) && !error.message.includes('private-provider-key'),
  );
  await assert.rejects(createMoonbaseApplication({ chat: async () => null }), {
    code: 'Unavailable',
  });
  await assert.rejects(createMoonbaseApplication({}), { code: 'InvalidInput' });
  await assert.rejects(
    createMoonbaseApplication({
      editors: [
        { client: editor.client, clientId: 'same' },
        { client: editor.client, clientId: 'same' },
      ],
    }),
    { code: 'InvalidInput' },
  );
});

test('invalid saved chat bytes remain in a live model and block unsafe close without reset', async () => {
  const chat = chatCapabilities();
  chat.storage.value = '{unfamiliar saved evidence';
  const app = await createMoonbaseApplication({ chat: async () => chat.dependencies });
  try {
    assert(app.chat?.getSnapshot().storageError);
    assert.equal(app.getSnapshot().chat.state, 'ready');
    assert.equal(app.canUnload(), false);
    assert.equal(app.closeChat(), false);
    assert.equal(await app.prepareQuit(), false);
    assert.equal(chat.storage.value, '{unfamiliar saved evidence');
    assert.equal(chat.storage.writes, 0);
  } finally {
    await app.dispose();
  }
});

test('quit veto restores admissions and a later successful preparation fences every head entry', async () => {
  const editor = editorCapabilities(),
    chat = chatCapabilities();
  const app = await createMoonbaseApplication({
    editors: [{ client: editor.client, clientId: 'one' }],
    chat: async () => chat.dependencies,
  });
  const model = app.editors[0];
  try {
    await model.openCheckout(checkout.root);
    await model.open(target);
    model.edit(target, 'dirty');
    await app.chat!.start();
    await app.chat!.connect();
    await app.chat!.select(chat.target);
    const first = app.prepareQuit();
    assert.equal(app.prepareQuit(), first);
    await tick();
    const prompt = model.getSnapshot().closePrompt!;
    assert(prompt);
    app.chat!.setDraft('during prompt');
    model.answerClose(prompt.id, 'cancel');
    assert.equal(await first, false);
    model.edit(target, 'still live');
    const second = app.prepareQuit();
    await tick();
    model.answerClose(model.getSnapshot().closePrompt!.id, 'discard');
    assert.equal(await second, true);
    assert.equal(app.getSnapshot().phase, 'prepared');
    const raw = chat.storage.value,
      count = chat.calls.length;
    app.chat!.setDraft('blocked');
    await app.chat!.send();
    await app.chat!.create('blocked');
    await app.chat!.connect();
    assert.equal(chat.storage.value, raw);
    assert.equal(chat.calls.length, count);
    assert.throws(() => model.edit(target, 'blocked'), { code: 'Unavailable' });
    await assert.rejects(model.open(target), { code: 'Unavailable' });
    assert.throws(() => model.createLookup(), { code: 'Unavailable' });
    assert.equal(app.closeChat(), false);
    await assert.rejects(app.openChat(), { code: 'Unavailable' });
    assert.equal(model.buffer(target)?.text, 'original');
    assert.equal(app.canUnload(), true);
  } finally {
    await app.dispose();
    await editor.runtime.dispose();
  }
});

test('all models are fenced before the final synchronous storage write, including reentrant Quit/open', async () => {
  const editor = editorCapabilities(),
    chat = chatCapabilities();
  const app = await createMoonbaseApplication({
    editors: [
      { client: editor.client, clientId: 'one' },
      { client: editor.client, clientId: 'two' },
    ],
    chat: async () => chat.dependencies,
  });
  try {
    for (const model of app.editors) {
      await model.openCheckout(checkout.root);
      await model.open(target);
    }
    await app.chat!.start();
    await app.chat!.connect();
    await app.chat!.select(chat.target);
    app.chat!.setDraft('retained');
    let writes = 0,
      reentrant: Promise<boolean> | undefined,
      blockedOpen: Promise<unknown> | undefined;
    chat.storage.write = () => {
      if (++writes !== 2) return;
      for (const model of app.editors)
        assert.throws(() => model.edit(target, 'late'), { code: 'Unavailable' });
      app.chat!.setDraft('late');
      reentrant = app.prepareQuit();
      blockedOpen = assert.rejects(app.openChat(), { code: 'Unavailable' });
    };
    const quit = app.prepareQuit();
    assert.equal(await quit, true);
    assert.equal(reentrant, quit);
    await blockedOpen;
    assert.equal(app.chat!.getSnapshot().draft, 'retained');
    assert(app.editors.every((model) => model.buffer(target)?.text === 'original'));
  } finally {
    await app.dispose();
    await editor.runtime.dispose();
  }
});

test('final preservation failure restores admissions without reversing completed editor discard', async () => {
  const editor = editorCapabilities(),
    chat = chatCapabilities();
  const app = await createMoonbaseApplication({
    editors: [{ client: editor.client, clientId: 'one' }],
    chat: async () => chat.dependencies,
  });
  const model = app.editors[0];
  try {
    await model.openCheckout(checkout.root);
    await model.open(target);
    model.edit(target, 'discarded');
    let writes = 0;
    chat.storage.write = () => {
      if (++writes === 2) throw Error('private-storage-diagnostic');
    };
    const quit = app.prepareQuit();
    await tick();
    model.answerClose(model.getSnapshot().closePrompt!.id, 'discard');
    assert.equal(await quit, false);
    assert.equal(app.getSnapshot().phase, 'live');
    assert.equal(model.buffer(target)?.text, 'original');
    model.edit(target, 'new edit');
    assert.equal(model.buffer(target)?.text, 'new edit');
  } finally {
    await app.dispose();
    await editor.runtime.dispose();
  }
});

for (const fail of [false, true])
  test(`removed chat cleanup stays owned and namespace blocked (failure ${fail})`, async () => {
    const editor = editorCapabilities(),
      chat = chatCapabilities(),
      held = Promise.withResolvers<void>();
    const app = await createMoonbaseApplication({
      editors: [{ client: editor.client, clientId: 'one' }],
      chat: async () => chat.dependencies,
    });
    await app.chat!.start();
    await app.chat!.connect();
    await app.chat!.select(chat.target);
    chat.controls.release = () => held.promise;
    const old = app.chat!;
    assert.equal(app.closeChat(), true);
    assert.equal(app.chat, null);
    await assert.rejects(app.openChat(), { code: 'Unavailable' });
    await app.editors[0].openCheckout(checkout.root);
    await tick();
    assert.deepEqual(app.getSnapshot().cleanup.pending, ['chat']);
    const writes = chat.storage.writes;
    chat.controls.receiveChat(chat.snapshot);
    old.setDraft('late');
    assert.equal(chat.storage.writes, writes);
    if (fail)
      held.reject(new ApplicationError({ code: 'Persistence', message: 'Cleanup failed safely' }));
    else held.resolve();
    await cleanupSettled(app);
    await Promise.resolve();
    if (fail) {
      assert.equal(app.getSnapshot().chat.state, 'cleanup-blocked');
      assert(
        app
          .getSnapshot()
          .cleanup.errors.some((message) => message.includes('Cleanup failed safely')),
      );
      await assert.rejects(app.openChat(), { code: 'Unavailable' });
      assert.equal(await app.prepareQuit(), true);
      const disposal = app.dispose();
      assert.equal(app.dispose(), disposal);
      await assert.rejects(disposal, { code: 'Persistence' });
      assert.equal(app.getSnapshot().phase, 'failed');
    } else {
      assert(app.chat === null);
      assert(await app.openChat());
      await app.dispose();
    }
    await editor.runtime.dispose();
  });

test('duplicate panel open shares acquisition; Quit waits and fences the acquired model', async () => {
  const chat = chatCapabilities(),
    held = Promise.withResolvers<typeof chat.dependencies | null>();
  let opens = 0;
  const app = await createMoonbaseApplication({
    chat: async () => {
      if (++opens === 1) return chat.dependencies;
      return held.promise;
    },
  });
  assert(app.closeChat());
  await cleanupSettled(app);
  const opening = app.openChat();
  assert.equal(app.openChat(), opening);
  const quit = app.prepareQuit();
  await assert.rejects(app.openChat(), { code: 'Unavailable' });
  held.resolve(chat.dependencies);
  assert(await opening);
  assert.equal(await quit, true);
  assert.equal(opens, 2);
  const writes = chat.storage.writes;
  app.chat!.setDraft('blocked');
  assert.equal(chat.storage.writes, writes);
  await app.dispose();
});

test('document loss cancels a pending prompt without awaiting quit and drains late panel acquisition', async () => {
  const editor = editorCapabilities();
  const app = await createMoonbaseApplication({
    editors: [{ client: editor.client, clientId: 'one' }],
  });
  const model = app.editors[0];
  await model.openCheckout(checkout.root);
  await model.open(target);
  model.edit(target, 'saved evidence');
  await model.flush();
  const quit = app.prepareQuit();
  await tick();
  assert(model.getSnapshot().closePrompt);
  const disposal = app.dispose();
  assert.equal(app.dispose(), disposal);
  await disposal;
  assert.equal(await quit, false);
  assert.equal(model.getSnapshot().disposed, true);
  await editor.runtime.dispose();
  const chat = chatCapabilities(),
    held = Promise.withResolvers<typeof chat.dependencies | null>();
  let opens = 0;
  const other = await createMoonbaseApplication({
    chat: async () => (++opens === 1 ? chat.dependencies : held.promise),
  });
  other.closeChat();
  await cleanupSettled(other);
  const opening = other.openChat();
  const closing = other.dispose();
  held.resolve(chat.dependencies);
  assert.equal(await opening, null);
  await closing;
  assert.equal(other.chat, null);
  assert.equal(other.getSnapshot().phase, 'disposed');
  assert.deepEqual(chat.calls, []);
});

test('retained workflow handles cannot admit queries or mutations after quit consent', async () => {
  const editor = editorCapabilities();
  const app = await createMoonbaseApplication({
    editors: [{ client: editor.client, clientId: 'one' }],
  });
  try {
    const model = app.editors[0];
    await model.openCheckout(checkout.root);
    await model.open(target);
    const lookup = model.createLookup(),
      mutation = model.createMutation({ checkout, kind: 'copy', paths: ['a.ts'] });
    assert.equal(await app.prepareQuit(), true);
    const snapshot = lookup.getSnapshot();
    lookup.query('b', [checkout]);
    lookup.message('late');
    assert.equal(
      await lookup.open(async () => {
        throw Error('must not open');
      }),
      false,
    );
    assert.equal(lookup.getSnapshot(), snapshot);
    assert.equal(await mutation.apply('c.ts', '', true), false);
    assert.equal(editor.memory.stats.mutations, 0);
    await lookup.dispose();
    await mutation.dispose();
  } finally {
    await app.dispose();
    await editor.runtime.dispose();
  }
});

test('required editor failure unwinds previously acquired models and redacts startup diagnostics', async () => {
  const editor = editorCapabilities();
  const broken: EditorClient = {
    ...editor.client,
    command: async () => {
      throw Error('private-backend-path');
    },
  };
  await assert.rejects(
    createMoonbaseApplication({
      editors: [
        { client: editor.client, clientId: 'one' },
        { client: broken, clientId: 'two' },
      ],
    }),
    (error) => ApplicationError.is(error) && !error.message.includes('private-backend-path'),
  );
  assert.equal(editor.memory.stats.active, 0);
  await editor.runtime.dispose();
});

test('required startup failure joins real held cleanup and retains both safe failures', async () => {
  const editor = editorCapabilities(),
    held = Promise.withResolvers<void>(),
    releasing = Promise.withResolvers<void>();
  const state = emptyRecovery('one');
  state.checkouts = [checkout];
  state.openCheckoutIds = [checkout.checkoutId];
  state.selectedCheckoutId = checkout.checkoutId;
  await editor.client.command('persistRecovery', {
    clientId: 'one',
    requestId: 'seed',
    expectedRevision: 0,
    state,
  });
  let releases = 0,
    settled = false;
  const client: EditorClient = {
    ...editor.client,
    watch: () => async () => {
      releases++;
      releasing.resolve();
      await held.promise;
    },
  };
  const broken: EditorClient = {
    ...client,
    command: async () => {
      throw new ApplicationError({ code: 'Unavailable', message: 'Required editor failed safely' });
    },
  };
  const startup = createMoonbaseApplication({
    editors: [
      { client, clientId: 'one' },
      { client: broken, clientId: 'two' },
    ],
  });
  void startup.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await releasing.promise;
  assert.equal(settled, false);
  assert.equal(releases, 1);
  held.reject(new ApplicationError({ code: 'Persistence', message: 'Held cleanup failed safely' }));
  await assert.rejects(
    startup,
    (error) =>
      ApplicationError.is(error) &&
      error.message.includes('Required editor failed safely') &&
      error.message.includes('Held cleanup failed safely'),
  );
  await editor.runtime.dispose();
});

test('prepared controllers block all IO and state admissions while teardown setters stay safe', async () => {
  const editor = editorCapabilities(),
    chat = chatCapabilities();
  let commands = 0;
  const client: EditorClient = {
    ...editor.client,
    command: (...args) => {
      commands++;
      return editor.client.command(...args);
    },
  };
  const app = await createMoonbaseApplication({
    editors: [{ client, clientId: 'one' }],
    chat: async () => chat.dependencies,
  });
  try {
    const model = app.editors[0];
    await model.openCheckout(checkout.root);
    await model.open(target);
    await app.chat!.start();
    await app.chat!.connect();
    await app.chat!.select(chat.target);
    assert.equal(await app.prepareQuit(), true);
    const count = commands,
      snapshot = model.getSnapshot(),
      calls = chat.calls.length,
      raw = chat.storage.value;
    const admissions = [
      () => model.load(),
      () => model.openCheckout(checkout.root),
      () => model.selectCheckout(checkout),
      () => model.resolveRecoveryPublication(),
      () => model.flush(),
      () => model.edit(target, 'late'),
      () => model.keepOpen(target),
      () => model.open(target),
      () => model.save(target),
      () => model.reload(target),
      () => model.reorder(checkout, target.path, 0),
      () => model.navigate(checkout, 1),
      () => model.close([target]),
      () => model.closeCheckout(checkout),
      () => model.prepareQuit(),
      () => model.reopen(checkout),
      () => model.tree(checkout, { focus: 'late' }),
      () => model.list(checkout),
      () => model.reveal(target),
      () => model.lookup(checkout, 'late'),
      () => model.refresh(checkout),
      () => model.createLookup(),
      () => model.createMutation({ checkout, kind: 'copy', paths: ['a.ts'] }),
      () => model.inspect(checkout, ['a.ts']),
      () =>
        model.mutate({
          checkout,
          kind: 'copy',
          sources: [],
          replacements: [],
          destination: 'late',
        }),
      () => model.resolveOperation('late'),
      () => model.reconcileRecovery(),
    ];
    for (const admit of admissions)
      await assert.rejects(Promise.resolve().then(admit), { code: 'Unavailable' });
    model.cancelConflict(target);
    model.position(target, 'file', { line: 1, column: 1, top: 0, left: 0 });
    model.answerClose('late', 'discard');
    model.resizeSidebar(300);
    const current = app.chat!;
    await current.start();
    await current.connect();
    await current.disconnect();
    await current.refresh();
    await current.moreChats();
    await current.firstChats();
    current.setDraft('late');
    await current.select(chat.target);
    await current.closeView();
    await current.older();
    await current.create('late');
    await current.send();
    await current.stop();
    await current.retry('late');
    await current.query('late');
    assert.equal(commands, count);
    assert.equal(model.getSnapshot(), snapshot);
    assert.equal(chat.calls.length, calls);
    assert.equal(chat.storage.value, raw);
  } finally {
    await app.dispose();
    await editor.runtime.dispose();
  }
});

test('reentrant panel close and lifecycle subscribers join the already-published ownership outcome', async () => {
  const chat = chatCapabilities();
  const app = await createMoonbaseApplication({ chat: async () => chat.dependencies });
  let close: boolean | undefined, disposal: Promise<void> | undefined;
  app.chat!.subscribe(() => {
    close = app.closeChat();
  });
  assert.equal(app.closeChat(), true);
  assert.equal(close, false);
  app.subscribe(() => {
    if (app.getSnapshot().phase === 'disposing') disposal = app.dispose();
  });
  const result = app.dispose();
  assert.equal(disposal, result);
  await result;
});

test('a reentrant head removing a newly acquired panel cannot receive its disposed controller', async () => {
  const chat = chatCapabilities();
  const app = await createMoonbaseApplication({ chat: async () => chat.dependencies });
  app.closeChat();
  await cleanupSettled(app);
  const off = app.subscribe(() => {
    if (app.getSnapshot().chat.state === 'ready') app.closeChat();
  });
  assert.equal(await app.openChat(), null);
  assert.equal(app.chat, null);
  off();
  await app.dispose();
});

test('the synchronous unload preservation check fences reentrant edits and restores live admission', async () => {
  const editor = editorCapabilities(),
    chat = chatCapabilities();
  const app = await createMoonbaseApplication({
    editors: [{ client: editor.client, clientId: 'one' }],
    chat: async () => chat.dependencies,
  });
  try {
    const model = app.editors[0];
    await model.openCheckout(checkout.root);
    await model.open(target);
    await model.flush();
    await app.chat!.start();
    await app.chat!.connect();
    await app.chat!.select(chat.target);
    app.chat!.setDraft('retained');
    let opening: Promise<unknown> | undefined, quit: Promise<boolean> | undefined;
    chat.storage.write = () => {
      assert.throws(() => model.edit(target, 'during unload'), { code: 'Unavailable' });
      app.chat!.setDraft('during unload');
      assert.equal(app.closeChat(), false);
      opening = assert.rejects(app.openChat(), { code: 'Unavailable' });
      quit = app.prepareQuit();
    };
    assert.equal(app.canUnload(), true);
    await opening;
    assert.equal(await quit, false);
    assert.equal(app.chat!.getSnapshot().draft, 'retained');
    chat.storage.write = () => {};
    model.edit(target, 'live again');
    app.chat!.setDraft('live again');
    assert.equal(model.buffer(target)?.text, 'live again');
    assert.equal(app.chat!.getSnapshot().draft, 'live again');
  } finally {
    await app.dispose();
    await editor.runtime.dispose();
  }
});

for (const choice of ['discard', 'cancel'] as const)
  test(`an editor that completed Quit stays fenced while another prompt waits (${choice})`, async () => {
    const editor = editorCapabilities();
    const app = await createMoonbaseApplication({
      editors: [
        { client: editor.client, clientId: 'one' },
        { client: editor.client, clientId: 'two' },
      ],
    });
    try {
      const [first, second] = app.editors;
      for (const model of app.editors) {
        await model.openCheckout(checkout.root);
        await model.open(target);
        model.edit(target, 'initial dirty');
      }
      const firstPrompt = closePrompt(first),
        quit = app.prepareQuit();
      first.answerClose((await firstPrompt).id, 'discard');
      const prompt = await closePrompt(second);
      let blocked = false;
      try {
        first.edit(target, 'late first draft');
      } catch (error) {
        assert(ApplicationError.is(error));
        assert.equal(error.code, 'Unavailable');
        blocked = true;
      }
      second.answerClose(prompt.id, choice);
      const consent = await quit;
      assert.equal(blocked, true);
      assert.equal(consent, choice === 'discard');
      assert.equal(first.buffer(target)?.text, 'original');
      if (consent) {
        assert(app.editors.every((model) => model.getSnapshot().recoveryReady));
        await app.dispose();
        assert.deepEqual(
          (await editor.client.command('loadRecovery', { clientId: 'one' })).state.drafts,
          [],
        );
      } else {
        assert.equal(app.getSnapshot().phase, 'live');
        first.edit(target, 'accepted after veto');
        await first.flush();
        assert.equal(
          (await editor.client.command('loadRecovery', { clientId: 'one' })).state.drafts[0].text,
          'accepted after veto',
        );
      }
    } finally {
      await app.dispose();
      await editor.runtime.dispose();
    }
  });

test('a synchronous edit during the final editor notification vetoes stale Quit consent', async () => {
  const editor = editorCapabilities();
  const app = await createMoonbaseApplication({
    editors: [{ client: editor.client, clientId: 'one' }],
  });
  const model = app.editors[0];
  let off = () => {};
  try {
    await model.openCheckout(checkout.root);
    await model.open(target);
    model.edit(target, 'initial dirty');
    let preserving = false,
      edited = false;
    off = model.subscribe(() => {
      if (model.getSnapshot().preserving) preserving = true;
      else if (preserving && !edited) {
        edited = true;
        model.edit(target, 'accepted in final notification');
      }
    });
    const prompt = closePrompt(model),
      quit = app.prepareQuit();
    model.answerClose((await prompt).id, 'discard');
    assert.equal(await quit, false);
    assert.equal(edited, true);
    assert.equal(app.getSnapshot().phase, 'live');
    assert.equal(model.buffer(target)?.text, 'accepted in final notification');
    off();
    await model.flush();
    assert.equal(
      (await editor.client.command('loadRecovery', { clientId: 'one' })).state.drafts[0].text,
      'accepted in final notification',
    );
  } finally {
    off();
    await app.dispose();
    await editor.runtime.dispose();
  }
});

for (const fail of [false, true])
  test(`closing chat fences storage reentrancy and restores admissions on veto (failure ${fail})`, async () => {
    const chat = chatCapabilities();
    const app = await createMoonbaseApplication({ chat: async () => chat.dependencies });
    try {
      const controller = app.chat!;
      await controller.start();
      await controller.connect();
      await controller.select(chat.target);
      controller.setDraft('before close');
      let reentered = false,
        reentrantDraft: string | undefined;
      chat.storage.write = () => {
        if (!reentered) {
          reentered = true;
          controller.setDraft('during preservation');
          reentrantDraft = controller.getSnapshot().draft;
        }
        if (fail) throw Error('Controlled storage failure');
      };
      assert.equal(app.closeChat(), !fail);
      assert.equal(reentered, true);
      assert.equal(reentrantDraft, 'before close');
      assert.equal(controller.getSnapshot().draft, 'before close');
      assert.equal(JSON.parse(chat.storage.value!).drafts[0].text, 'before close');
      if (fail) {
        assert.equal(app.chat, controller);
        assert(controller.getSnapshot().storageError);
        chat.storage.write = () => {};
        controller.setDraft('accepted after veto');
        assert.equal(controller.getSnapshot().draft, 'accepted after veto');
      } else {
        assert.equal(app.chat, null);
        assert.equal(controller.getSnapshot().storageError, null);
      }
    } finally {
      await app.dispose();
    }
  });

test('the first Quit preservation fences storage reentrancy then accepts drafts during editor prompts', async () => {
  const editor = editorCapabilities(),
    chat = chatCapabilities();
  const app = await createMoonbaseApplication({
    editors: [{ client: editor.client, clientId: 'one' }],
    chat: async () => chat.dependencies,
  });
  try {
    const model = app.editors[0],
      controller = app.chat!;
    await model.openCheckout(checkout.root);
    await model.open(target);
    model.edit(target, 'dirty editor');
    await controller.start();
    await controller.connect();
    await controller.select(chat.target);
    controller.setDraft('before Quit');
    let reentrantDraft: string | undefined;
    chat.storage.write = () => {
      if (reentrantDraft !== undefined) return;
      reentrantDraft = 'checking';
      controller.setDraft('during preservation');
      reentrantDraft = controller.getSnapshot().draft;
    };
    const prompt = closePrompt(model),
      quit = app.prepareQuit();
    const current = await prompt;
    assert.equal(reentrantDraft, 'before Quit');
    controller.setDraft('accepted during prompt');
    assert.equal(controller.getSnapshot().draft, 'accepted during prompt');
    model.answerClose(current.id, 'discard');
    assert.equal(await quit, true);
    assert.equal(JSON.parse(chat.storage.value!).drafts[0].text, 'accepted during prompt');
  } finally {
    await app.dispose();
    await editor.runtime.dispose();
  }
});

test('Quit confirms clean view metadata captured by the final Discard notification', async () => {
  const editor = editorCapabilities();
  const app = await createMoonbaseApplication({
    editors: [{ client: editor.client, clientId: 'one' }],
  });
  const model = app.editors[0];
  let off = () => {};
  try {
    await model.openCheckout(checkout.root);
    await model.open(target);
    model.edit(target, 'discard me');
    let preserving = false,
      positioned = false;
    off = model.subscribe(() => {
      if (model.getSnapshot().preserving) preserving = true;
      else if (preserving && !positioned) {
        positioned = true;
        model.position(target, 'file', { line: 1, column: 7, top: 20, left: 0 });
      }
    });
    const prompt = closePrompt(model),
      quit = app.prepareQuit();
    model.answerClose((await prompt).id, 'discard');
    assert.equal(await quit, true);
    assert.equal(positioned, true);
    assert.equal(model.buffer(target)?.text, 'original');
    assert.equal(model.getSnapshot().recoveryReady, true);
    await app.dispose();
    const saved = await editor.client.command('loadRecovery', { clientId: 'one' });
    assert.deepEqual(saved.state.drafts, []);
    assert.deepEqual(saved.state.views[checkout.checkoutId].positions[target.path].file, {
      line: 1,
      column: 7,
      top: 20,
      left: 0,
    });
  } finally {
    off();
    await app.dispose();
    await editor.runtime.dispose();
  }
});

test('uncertain final Quit metadata keeps its original publication and vetoes until explicit resolution', async () => {
  const editor = editorCapabilities();
  let positioned = false,
    loseMetadata = true;
  const publications: CommandInput<'persistRecovery'>[] = [];
  const client: EditorClient = {
    ...editor.client,
    command: async (operation, input, options) => {
      if (positioned && operation === 'persistRecovery') {
        publications.push(structuredClone(input as CommandInput<'persistRecovery'>));
        if (loseMetadata)
          throw new ApplicationError({
            code: 'Uncertain',
            message: 'Controlled metadata response loss',
          });
      }
      if (positioned && loseMetadata && operation === 'getRecoveryPublication')
        return null as never;
      return editor.client.command(operation, input, options);
    },
  };
  const app = await createMoonbaseApplication({ editors: [{ client, clientId: 'one' }] });
  const model = app.editors[0];
  let off = () => {};
  try {
    await model.openCheckout(checkout.root);
    await model.open(target);
    model.edit(target, 'discard me');
    let preserving = false;
    off = model.subscribe(() => {
      if (model.getSnapshot().preserving) preserving = true;
      else if (preserving && !positioned) {
        positioned = true;
        model.position(target, 'file', { line: 1, column: 7, top: 20, left: 0 });
      }
    });
    const prompt = closePrompt(model),
      quit = app.prepareQuit();
    model.answerClose((await prompt).id, 'discard');
    assert.equal(await quit, false);
    assert.equal(app.getSnapshot().phase, 'live');
    assert.equal(model.buffer(target)?.text, 'original');
    assert.equal(publications.length, 1);
    const original = publications[0];
    assert.equal(model.getSnapshot().publication?.requestId, original.requestId);
    assert.equal(await app.prepareQuit(), false);
    assert.equal(publications.length, 1);
    assert.equal(model.getSnapshot().publication?.requestId, original.requestId);
    loseMetadata = false;
    assert.equal(await model.resolveRecoveryPublication(), true);
    assert.deepEqual(publications, [original, original]);
    assert.equal(model.getSnapshot().recoveryReady, true);
    const saved = await editor.client.command('loadRecovery', { clientId: 'one' });
    assert.deepEqual(saved.state.drafts, []);
    assert.deepEqual(saved.state.views[checkout.checkoutId].positions[target.path].file, {
      line: 1,
      column: 7,
      top: 20,
      left: 0,
    });
  } finally {
    off();
    await app.dispose();
    await editor.runtime.dispose();
  }
});

test('named local/remote targets preserve separate drafts and wait for controller cleanup without Stop or replay', async () => {
  const local = chatCapabilities(),
    remote = chatCapabilities();
  const localDependencies = {
    ...local.dependencies,
    mode: 'local' as const,
    connection: undefined,
  };
  const remoteDependencies = remote.dependencies;
  const localChat = localDependencies.chat;
  localDependencies.chat = {
    ...localChat,
    command: async (op, input, options) =>
      op === 'getChatHost'
        ? ({ ...localDependencies.context, mode: 'local' } as never)
        : localChat.command(op, input, options),
  };
  const application = await createMoonbaseApplication({
    chatTargets: [
      { id: 'local', label: 'Local', acquire: async () => localDependencies },
      { id: 'remote', label: 'Remote', acquire: async () => remoteDependencies },
    ],
  });
  try {
    await application.chat!.start();
    assert.equal(application.chat!.getSnapshot().mode, 'local');
    await application.chat!.create('Local', {
      cwd: '/local',
      model: { provider: 'fake', modelId: 'first' },
    });
    application.chat!.setDraft('local draft');
    const held = Promise.withResolvers<void>();
    local.controls.release = () => held.promise;
    const switching = application.selectChatTarget('remote');
    assert.equal(application.canUnload(), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(application.chat, null);
    held.resolve();
    await switching;
    await application.chat!.start();
    await application.chat!.connect();
    await application.chat!.create('Remote');
    application.chat!.setDraft('remote draft');
    await application.selectChatTarget('local');
    assert.equal(application.chat!.getSnapshot().draft, 'local draft');
    assert.equal(JSON.parse(remote.storage.value!).drafts[0].text, 'remote draft');
    assert.equal(local.calls.filter((call) => call === 'createChat').length, 1);
    assert(
      ![...local.calls, ...remote.calls].some((call) => ['sendChat', 'stopChat'].includes(call)),
    );
  } finally {
    await application.dispose();
  }
});

test('final Quit confirmation runs with admissions fenced and Keep running restores them', async () => {
  const chat = chatCapabilities();
  let confirms = 0;
  const application = await createMoonbaseApplication({
    chat: async () => chat.dependencies,
    confirmQuit: async () => {
      confirms++;
      await application.chat!.create('Fenced');
      assert(!chat.calls.includes('createChat'));
      return confirms > 1;
    },
  });
  try {
    await application.chat!.start();
    await application.chat!.connect();
    assert.equal(await application.prepareQuit(), false);
    assert.equal(application.getSnapshot().phase, 'live');
    assert.equal(await application.prepareQuit(), true);
    assert.equal(confirms, 2);
  } finally {
    await application.dispose();
  }
});
