import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry, defineDocFamily } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { readFile } from 'node:fs/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { ChatStoreError } from '@moonbase/contracts/chat-errors';
import { session, until, fixture, runChat } from '../runtime-fixture.ts';

test('duplicate/lost Send, read-only lookup, restart and cross-operation reuse never resend', async (t) => {
  const f = await fixture(t),
    target = await f.create();
  f.faux.setResponses([fauxAssistantMessage('Hello')]);
  const input = { target, requestId: 'send', text: 'Question' };
  const receipts = await Promise.all([
    runChat(f.runtime, (chat) => chat.sendChat(input)),
    runChat(f.runtime, (chat) => chat.sendChat(input)),
  ]);
  assert.deepEqual(receipts[0], receipts[1]);
  await until(
    () => runChat(f.runtime, (chat) => chat.getChat({ target })),
    (s) => s.run === null && s.entries.some((e) => e.text === 'Hello'),
  );
  assert.equal(f.faux.state.callCount, 1);
  await assert.rejects(
    runChat(f.runtime, (chat) => chat.sendChat({ ...input, text: 'changed' })),
    { _tag: 'RequestReusedError' },
  );
  await assert.rejects(
    runChat(f.runtime, (chat) => chat.sendChat({ ...input, requestId: 'create' })),
    { _tag: 'RequestReusedError' },
  );
  assert.equal(
    await runChat(f.runtime, (chat) => chat.getChatSend({ target, requestId: 'unknown' })),
    null,
  );
  await f.restart();
  assert.deepEqual(
    await runChat(f.runtime, (chat) => chat.getChatSend({ target, requestId: 'send' })),
    receipts[0],
  );
  assert.deepEqual(await runChat(f.runtime, (chat) => chat.sendChat(input)), receipts[0]);
  assert.equal(f.faux.state.callCount, 1);
});
for (const admitted of [false, true])
  test(`interrupted ${admitted ? 'admitted binding' : 'reservation'} recovers without implicit resubmission`, async (t) => {
    const original = Harness.open;
    let fail = true;
    mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
      const harness = await original(...args),
        get = harness.conversation.bind(harness);
      harness.conversation = async (...values: Parameters<typeof get>) => {
        const conversation = await get(...values);
        if (conversation) {
          const submit = conversation.submit.bind(conversation);
          conversation.submit = async (...input: Parameters<typeof submit>) => {
            if (fail) {
              fail = false;
              if (admitted) await submit(...input);
              // A typed failure is no proof either: only Pi's busy refusal is.
              throw new ChatStoreError({ problem: 'failed' });
            }
            return submit(...input);
          };
        }
        return conversation;
      };
      return harness;
    });
    t.after(async () => mock.restoreAll());
    const f = await fixture(t),
      target = await f.create();
    f.faux.setResponses([fauxAssistantMessage('Once')]);
    const input = { target, requestId: 'lost', text: 'Retained' };
    await assert.rejects(
      runChat(f.runtime, (chat) => chat.sendChat(input)),
      { _tag: 'UncertainError' },
    );
    await f.restart();
    const receipt = await runChat(f.runtime, (chat) =>
      chat.getChatSend({ target, requestId: 'lost' }),
    );
    assert.equal(receipt?.admission, admitted ? 'admitted' : 'reserved');
    // An admitted run resumes on reopen by itself; reads add no model call to it.
    if (admitted)
      await until(
        () => runChat(f.runtime, (chat) => chat.getChat({ target })),
        (s) => s.run === null && s.entries.some((e) => e.text === 'Once'),
      );
    const before = f.faux.state.callCount;
    await runChat(f.runtime, (chat) => chat.getChat({ target }));
    await runChat(f.runtime, (chat) => chat.listChats({ session }));
    assert.equal(f.faux.state.callCount, before);
    if (!admitted) {
      assert.equal(before, 0);
      assert.equal(
        (await runChat(f.runtime, (chat) => chat.getChat({ target }))).state,
        'uncertain',
      );
    }
    assert.equal((await runChat(f.runtime, (chat) => chat.sendChat(input))).admission, 'admitted');
    await until(
      () => runChat(f.runtime, (chat) => chat.getChat({ target })),
      (s) => s.run === null && s.entries.some((e) => e.text === 'Once'),
    );
    assert.equal(f.faux.state.callCount, 1);
  });
test('selected Pi coding-tool runtime executes in the fixed cwd once and retained Send does not rerun native work after reopen', async (t) => {
  const registry = createRegistry();
  registry.install(CodingTools);
  const f = await fixture(t, registry, { tokenSize: { min: 65536, max: 65536 } }),
    target = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('bash', { command: 'printf x >> counted.txt; printf "%s" "$$" > native.pid' }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Native complete'),
  ]);
  const input = { target, requestId: 'native', text: 'One controlled native effect' };
  const receipt = await runChat(f.runtime, (chat) => chat.sendChat(input));
  await until(
    () => runChat(f.runtime, (chat) => chat.getChat({ target })),
    (s) => !s.run && s.entries.some((e) => e.text === 'Native complete'),
  );
  assert.equal(await readFile(join(f.config.cwd, 'counted.txt'), 'utf8'), 'x');
  const pid = Number(await readFile(join(f.config.cwd, 'native.pid'), 'utf8'));
  assert.throws(
    () => process.kill(pid, 0),
    (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === 'ESRCH',
  );
  await f.restart();
  assert.deepEqual(await runChat(f.runtime, (chat) => chat.sendChat(input)), receipt);
  assert.equal(await readFile(join(f.config.cwd, 'counted.txt'), 'utf8'), 'x');
  assert.equal(f.faux.state.callCount, 2);
});
test('maximum escaped Send text retains its original serialized binding across retry and restart', async (t) => {
  const f = await fixture(t),
    target = await f.create();
  f.faux.setResponses([fauxAssistantMessage('Escaped input completed')]);
  const input = { target, requestId: 'escaped-binding', text: '\u0001'.repeat(32768) };
  assert(Buffer.byteLength(JSON.stringify({ operation: 'sendChat', ...input })) > 64 * 1024);
  const receipt = await runChat(f.runtime, (chat) => chat.sendChat(input));
  await until(
    () => runChat(f.runtime, (chat) => chat.getChat({ target })),
    (value) =>
      !value.run && value.entries.some((entry) => entry.text === 'Escaped input completed'),
  );
  assert.deepEqual(await runChat(f.runtime, (chat) => chat.sendChat(input)), receipt);
  await f.restart();
  assert.deepEqual(
    await runChat(f.runtime, (chat) => chat.getChatSend({ target, requestId: input.requestId })),
    receipt,
  );
  assert.deepEqual(await runChat(f.runtime, (chat) => chat.sendChat(input)), receipt);
  assert.equal(f.faux.state.callCount, 1);
});
for (const state of ['admitted', 'pending', 'empty'] as const)
  test(`Send refuses to rewrite a saved ${state} request without its captured conversation`, async (t) => {
    const original = Harness.open;
    let harness!: Harness;
    mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
      harness = await original(...args);
      if (state === 'pending') {
        const get = harness.conversation.bind(harness);
        harness.conversation = async (...args: Parameters<typeof get>) => {
          const conversation = await get(...args);
          if (conversation)
            conversation.submit = async () => {
              throw Error('Controlled reserved intent');
            };
          return conversation;
        };
      }
      return harness;
    });
    t.after(() => mock.restoreAll());
    const f = await fixture(t),
      target = await f.create(),
      input = { target, requestId: 'captured', text: 'Original' };
    f.faux.setResponses([fauxAssistantMessage('Original completed')]);
    if (state === 'pending')
      await assert.rejects(
        runChat(f.runtime, (chat) => chat.sendChat(input)),
        { _tag: 'UncertainError' },
      );
    else {
      await runChat(f.runtime, (chat) => chat.sendChat(input));
      await until(
        () => runChat(f.runtime, (chat) => chat.getChat({ target })),
        (value) => !value.run,
      );
    }
    const request = defineDocFamily({
        kind: 'moonbase.chat.request',
        version: 1,
        scope: 'session',
        family: true,
        initial: (binding: string) => ({
          binding,
          conversationId: null as string | null,
          submissionId: null as string | null,
          pending: false,
        }),
        checkpointWhen: () => true,
      }),
      requestKey = JSON.stringify([session.actorId, input.requestId]);
    await harness.commit(async (tx) => {
      const value = await tx.doc(request, requestKey, '');
      value.conversationId = null;
      if (state === 'empty') {
        value.submissionId = null;
        value.pending = false;
      }
    }, BACKGROUND_CONTEXT);
    const before = JSON.stringify(await harness.snapshot(request, requestKey, BACKGROUND_CONTEXT)),
      calls = f.faux.state.callCount;
    let commits = 0;
    const off = harness.subscribeCommits(() => {
      commits++;
    });
    try {
      await assert.rejects(
        runChat(f.runtime, (chat) => chat.sendChat(input)),
        { _tag: 'ChatStoreError' },
      );
      await assert.rejects(
        runChat(f.runtime, (chat) => chat.getChatSend({ target, requestId: input.requestId })),
        { _tag: 'ChatStoreError' },
      );
      assert.equal(commits, 0);
      assert.equal(
        JSON.stringify(await harness.snapshot(request, requestKey, BACKGROUND_CONTEXT)),
        before,
      );
      assert.equal(f.faux.state.callCount, calls);
    } finally {
      off();
    }
  });
