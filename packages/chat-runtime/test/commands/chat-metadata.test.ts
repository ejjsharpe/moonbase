import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ManagedRuntime } from 'effect';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { ChatTarget } from '@moonbase/contracts/chat';
import { LocalPiControl } from '../../src/index.ts';
import { fixture, session, until, runChat, type ChatRuntime } from '../runtime-fixture.ts';

const listed = async (runtime: ChatRuntime, target: ChatTarget) =>
  (await runChat(runtime, (chat) => chat.listChats({ session }))).conversations.find(
    (chat) => chat.target.conversationId === target.conversationId,
  );

test('a chat settles and unsettles on its host, across a restart', async (t) => {
  const f = await fixture(t);
  const target = await f.create();
  assert.equal((await listed(f.runtime, target))?.settledAt, undefined);

  const settled = await runChat(f.runtime, (chat) => chat.settleChat({ target, settled: true }));
  assert.deepEqual(settled.target, target);
  assert(settled.settledAt && Number.isFinite(Date.parse(settled.settledAt)));
  // Settling a settled chat again keeps its original time.
  assert.deepEqual(
    await runChat(f.runtime, (chat) => chat.settleChat({ target, settled: true })),
    settled,
  );
  assert.equal((await listed(f.runtime, target))?.settledAt, settled.settledAt);

  await f.restart();
  assert.equal((await listed(f.runtime, target))?.settledAt, settled.settledAt);
  assert.equal(
    (await runChat(f.runtime, (chat) => chat.getChat({ target }))).conversation.settledAt,
    settled.settledAt,
  );

  const unsettled = await runChat(f.runtime, (chat) => chat.settleChat({ target, settled: false }));
  assert.equal(unsettled.settledAt, undefined);
  assert.equal('settledAt' in unsettled, false);
  assert.deepEqual(
    await runChat(f.runtime, (chat) => chat.settleChat({ target, settled: false })),
    unsettled,
  );
  await f.restart();
  assert.equal((await listed(f.runtime, target))?.settledAt, undefined);
  assert.equal(
    (await runChat(f.runtime, (chat) => chat.getChat({ target }))).conversation.settledAt,
    undefined,
  );
});

test('sending to a settled chat unsettles it', async (t) => {
  const f = await fixture(t);
  const target = await f.create();
  await runChat(f.runtime, (chat) => chat.settleChat({ target, settled: true }));
  f.faux.setResponses([fauxAssistantMessage('Back on it')]);
  await runChat(f.runtime, (chat) =>
    chat.sendChat({ target, requestId: 'send', text: 'One more thing' }),
  );
  const snapshot = await until(
    () => runChat(f.runtime, (chat) => chat.getChat({ target })),
    (value) => !value.run && value.entries.some((entry) => entry.text === 'Back on it'),
  );
  assert.equal(snapshot.conversation.settledAt, undefined);
  assert.equal((await listed(f.runtime, target))?.settledAt, undefined);
  // Looking up that Send again does not unsettle the chat a second time.
  await runChat(f.runtime, (chat) => chat.settleChat({ target, settled: true }));
  await runChat(f.runtime, (chat) => chat.getChatSend({ target, requestId: 'send' }));
  assert((await listed(f.runtime, target))?.settledAt);
});

test('settling refuses foreign targets and waits for open admissions', async (t) => {
  const f = await fixture(t);
  const target = await f.create();
  await assert.rejects(
    runChat(f.runtime, (chat) =>
      chat.settleChat({
        target: { ...target, host: { ...target.host, storeId: 'another-store' } },
        settled: true,
      }),
    ),
    { _tag: 'ChatStoreMismatchError', mismatch: 'other-host' },
  );
  await assert.rejects(
    runChat(f.runtime, (chat) =>
      chat.settleChat({ target: { ...target, actorId: 'stranger' }, settled: true }),
    ),
    { _tag: 'ChatAccessError' },
  );
  await assert.rejects(
    runChat(f.runtime, (chat) =>
      chat.settleChat({ target: { ...target, conversationId: '999' }, settled: true }),
    ),
    { _tag: 'ChatAccessError' },
  );
  // The fixture's local runtime provides the control beside the chat service.
  const local = f.runtime as unknown as ManagedRuntime.ManagedRuntime<LocalPiControl, never>;
  const control = await local.runPromise(LocalPiControl);
  await local.runPromise(control.setAdmissionsOpen(false));
  await assert.rejects(
    runChat(f.runtime, (chat) => chat.settleChat({ target, settled: true })),
    { _tag: 'ChatUnavailableError', reason: 'quitting' },
  );
  await local.runPromise(control.setAdmissionsOpen(true));
  assert.equal((await listed(f.runtime, target))?.settledAt, undefined);
});
