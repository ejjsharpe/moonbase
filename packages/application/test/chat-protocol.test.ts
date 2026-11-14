import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type DraftStorage } from '@moonbase/application/chat';
import { modelRoot } from './chat-model-fixture.ts';
import { fixture, until } from '../../../test/chat/tool-fixture.ts';
class Storage implements DraftStorage {
  value: string | null = null;
  read() {
    return this.value;
  }
  write(v: string) {
    this.value = v;
  }
}
async function setup(t: { after: (f: () => Promise<void>) => void }, hold = false) {
  const f = await fixture(hold);
  const models = modelRoot();
  t.after(async () => {
    try {
      await models.close();
    } finally {
      await f.close();
    }
  });
  const root = f.root(),
    storage = new Storage(),
    controller = await models.make({
      chat: root.chat,
      connection: root.connection,
      context: f.session,
      storage,
    });
  await controller.start();
  await controller.connect();
  await until(
    async () => controller.getSnapshot(),
    (s) => !!s.host,
  );
  // The host is the daemon in host mode: the chat chooses its folder and model.
  await controller.create('Production protocol chat', f.settings);
  return { ...f, clientRoot: root, controller, storage, models };
}
test('public chat controller creates, lists, opens, streams real tool output and captures exact Stop through SSH/HTTP/Pi', async (t) => {
  const f = await setup(t, true);
  const target = f.controller.getSnapshot().selected!;
  const host = f.controller.getSnapshot().host!;
  assert('mode' in host && host.mode === 'local');
  assert.equal((await f.clientRoot.chat.command('getChat', { target })).conversation.cwd, f.cwd);
  f.controller.setDraft('Inspect controlled context');
  await f.controller.send();
  const active = await until(
    async () => f.controller.getSnapshot(),
    (s) =>
      !!s.snapshot?.run?.transcript?.parts.some(
        (part) => part.kind === 'result' && part.text.length > 0,
      ),
  );
  assert(active.snapshot!.run!.transcript!.parts.find((part) => part.kind === 'result')!.truncated);
  assert.equal((await f.stats()).tools, 1);
  const stop = structuredClone(active.snapshot!.run!.stop);
  await f.controller.stop();
  assert(
    f.controller.getSnapshot().notice.includes('Stop') ||
      f.controller.getSnapshot().pending.some((p) => p.operation === 'stopChat'),
  );
  await until(
    () => f.clientRoot.chat.command('getChat', { target }),
    (s) => !s.run,
  );
  assert.equal((await f.stats()).tools, 1);
  await f.controller.closeView();
  assert.equal(f.controller.getSnapshot().selected, null);
  await f.controller.select(target);
  assert.deepEqual(f.controller.getSnapshot().selected, target);
  assert.equal((await f.stats()).commands.filter((op) => op === 'sendChat').length, 1);
  assert(stop.taskId);
});
test('lost actual HTTP Send response + newer draft + controller reload/client closure/reconnect/store reopen never resends', async (t) => {
  const f = await setup(t, true),
    target = f.controller.getSnapshot().selected!;
  await f.loseNextSend();
  f.controller.setDraft('Original lost-response text');
  await f.controller.send();
  const pending = f.controller.getSnapshot().pending[0];
  assert.equal(pending.operation, 'sendChat');
  assert(pending.message.startsWith('Uncertain'));
  f.controller.setDraft('Newer unsent edit');
  await f.controller.dispose();
  await f.clientRoot.runtime.dispose();
  await until(f.stats, (s) => s.tools === 1);
  const second = f.root(),
    next = await f.models.make({
      chat: second.chat,
      connection: second.connection,
      context: f.session,
      storage: f.storage,
    });
  await next.start();
  assert.equal(next.getSnapshot().pending[0].input.requestId, pending.input.requestId);
  await next.connect();
  await until(
    async () => next.getSnapshot(),
    (s) => s.pending.length === 0,
  );
  assert.equal(next.getSnapshot().draft, 'Newer unsent edit');
  assert.equal((await f.stats()).commands.filter((op) => op === 'sendChat').length, 1);
  f.release();
  await until(
    () => second.chat.command('getChat', { target }),
    (s) => !s.run && s.entries.some((e) => e.text.includes('Remote response finished')),
  );
  await next.dispose();
  await second.runtime.dispose();
  await f.stopHost();
  await f.startHost();
  const third = f.root(),
    last = await f.models.make({
      chat: third.chat,
      connection: third.connection,
      context: f.session,
      storage: f.storage,
    });
  await last.start();
  await last.connect();
  await until(
    async () => last.getSnapshot(),
    (s) => !!s.snapshot,
  );
  assert.equal(last.getSnapshot().draft, 'Newer unsent edit');
  const receipt = await third.chat.command('getChatSend', {
    target,
    requestId: pending.input.requestId,
  });
  assert.equal(receipt?.admission, 'admitted');
  assert.equal((await f.stats()).calls, 0);
  assert.equal((await f.stats()).tools, 0);
  assert.equal(
    last
      .getSnapshot()
      .snapshot!.entries.filter(
        (e) => e.role === 'user' && e.text === 'Original lost-response text',
      ).length,
    1,
  );
});
test('view detach and Disconnect leave remote tool running; reopen queries same chat without Send', async (t) => {
  const f = await setup(t, true);
  const target = f.controller.getSnapshot().selected!;
  f.controller.setDraft('Keep remote work');
  await f.controller.send();
  await until(f.stats, (s) => s.tools === 1);
  await f.controller.closeView();
  await f.controller.disconnect();
  assert.equal(f.controller.getSnapshot().connection!.state, 'disconnected');
  assert.equal((await f.stats()).commands.filter((s) => s === 'stopChat').length, 0);
  await f.controller.connect();
  await until(
    async () => f.controller.getSnapshot(),
    (s) => !!s.host,
  );
  await f.controller.select(target);
  await until(
    async () => f.controller.getSnapshot(),
    (s) => !!s.snapshot?.run?.transcript?.parts.some((part) => part.role === 'tool'),
  );
  assert.equal((await f.stats()).tools, 1);
  assert.equal((await f.stats()).commands.filter((s) => s === 'sendChat').length, 1);
  f.release();
  await until(
    () => f.clientRoot.chat.command('getChat', { target }),
    (s) => !s.run,
  );
});
