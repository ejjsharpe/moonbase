import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { Harness } from '@earendil-works/pi-durable';
import type { ManagedRuntime } from 'effect';
import type { ChatTarget } from '@moonbase/contracts/chat';
import { ChatStoreError } from '@moonbase/contracts/chat-errors';
import { LocalPiControl } from '../../src/index.ts';
import { Metadata, Request, cid } from '../../src/documents.ts';
import { fixture, runChat, session, until } from '../runtime-fixture.ts';

/**
 * A lost commit acknowledgement, rejected with `rejection` or a store failure, or a failed read of
 * one stored record after `skip` matches.
 */
type Fault =
  | { lost: 'ack'; rejection?: unknown }
  | { lost: 'read'; record: typeof Metadata | typeof Request; skip: number };
type Scene = {
  f: Awaited<ReturnType<typeof fixture>>;
  target: ChatTarget;
  harness: () => Harness;
  /** Arms `fault`, runs `call` and requires it uncertain, with the fault spent. */
  lose: (fault: Fault, call: () => Promise<unknown>) => Promise<void>;
};

const send = (target: ChatTarget) => ({ target, requestId: 'lost', text: 'Retained' });
const created = { session, requestId: 'lost-create', title: 'Committed' };
const listed = async (scene: Scene) =>
  (await runChat(scene.f.runtime, (chat) => chat.listChats({ session }))).conversations;
const finishSend = async ({ f, target }: Scene) => {
  f.faux.setResponses([fauxAssistantMessage('Once')]);
  const receipt = await runChat(f.runtime, (chat) => chat.sendChat(send(target)));
  await until(
    () => runChat(f.runtime, (chat) => chat.getChat({ target })),
    (value) => !value.run && value.entries.some((entry) => entry.text === 'Once'),
  );
  return receipt;
};
const control = async ({ f }: Scene) => {
  const local = f.runtime as unknown as ManagedRuntime.ManagedRuntime<LocalPiControl, never>;
  return { local, control: await local.runPromise(LocalPiControl) };
};

// Each mutation, failing after it may have committed: the failure is uncertain, never a definite
// store error, while the refusals proven to write nothing stay definite.
const mutations: Record<string, (scene: Scene) => Promise<void>> = {
  'Send after its reservation commits': async (scene) => {
    const { f, target } = scene;
    await runChat(f.runtime, (chat) => chat.settleChat({ target, settled: true }));
    f.faux.setResponses([fauxAssistantMessage('Once')]);
    await scene.lose({ lost: 'ack' }, async () => {
      // A request ID bound to another operation is refused inside the commit, before it writes.
      await assert.rejects(
        runChat(f.runtime, (chat) => chat.sendChat({ ...send(target), requestId: 'create' })),
        { _tag: 'RequestReusedError' },
      );
      return runChat(f.runtime, (chat) => chat.sendChat(send(target)));
    });
    // The reservation committed: it took the chat up again.
    assert.equal((await listed(scene))[0]?.settledAt, undefined);
    assert.equal(f.faux.state.callCount, 0);
    await finishSend(scene);
    assert.equal(f.faux.state.callCount, 1);
  },
  'Send replaying an admitted request': async (scene) => {
    const { f, target } = scene;
    const receipt = await finishSend(scene);
    await scene.lose({ lost: 'read', record: Request, skip: 0 }, () =>
      runChat(f.runtime, (chat) => chat.sendChat(send(target))),
    );
    assert.deepEqual(await runChat(f.runtime, (chat) => chat.sendChat(send(target))), receipt);
    assert.equal(f.faux.state.callCount, 1);
  },
  'Settle after it commits': async (scene) => {
    const { f, target } = scene;
    await scene.lose({ lost: 'ack' }, () =>
      runChat(f.runtime, (chat) => chat.settleChat({ target, settled: true })),
    );
    assert((await listed(scene))[0]?.settledAt);
  },
  'Settle reading its reply': async (scene) => {
    const { f, target } = scene;
    // The first metadata read checks the chat before anything commits; the second is the reply.
    await scene.lose({ lost: 'read', record: Metadata, skip: 1 }, () =>
      runChat(f.runtime, (chat) => chat.settleChat({ target, settled: true })),
    );
    assert((await listed(scene))[0]?.settledAt);
  },
  'Mark as Project after it commits': async (scene) => {
    const { f, target } = scene;
    await scene.harness().commit(async (tx) => {
      const meta = await tx.doc(Metadata, cid(target.conversationId), 'metadata', {
        identity: '',
        title: '',
        createdAt: '',
      });
      meta.settings!.ownFolder = true;
    }, BACKGROUND_CONTEXT);
    const { local, control: pi } = await control(scene);
    // Pi rejects with a value whose prototype can't be read, so even asking whether it is a
    // refusal throws.
    const unreadable = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('unreadable');
        },
      },
    );
    await scene.lose({ lost: 'ack', rejection: unreadable }, () =>
      local.runPromise(pi.markFolderAsProject(target)),
    );
    const chat = await runChat(f.runtime, (chat) => chat.getChat({ target }));
    assert.equal(chat.conversation.ownFolder, undefined);
  },
  'Create after it commits': async (scene) => {
    const { f } = scene;
    const input = { ...created, settings: f.settings };
    await scene.lose({ lost: 'ack' }, async () => {
      await assert.rejects(
        runChat(f.runtime, (chat) =>
          chat.createChat({ ...input, session: { ...session, actorId: 'other' } }),
        ),
        { _tag: 'ChatAccessError', refusal: 'other-actor' },
      );
      return runChat(f.runtime, (chat) => chat.createChat(input));
    });
    await f.restart();
    // The first attempt made the chat: it is listed before any retry, which returns that chat.
    const made = (await listed(scene)).filter((chat) => chat.title === input.title);
    assert.equal(made.length, 1);
    const recovered = await runChat(f.runtime, (chat) => chat.createChat(input));
    assert.deepEqual(recovered.conversation.target, made[0]!.target);
    assert.equal((await listed(scene)).length, 2);
    await assert.rejects(
      runChat(f.runtime, (chat) => chat.createChat({ ...input, title: 'Changed' })),
      { _tag: 'RequestReusedError' },
    );
    assert.deepEqual(await runChat(f.runtime, (chat) => chat.createChat(input)), recovered);
  },
  'Create recovering its committed chat': async (scene) => {
    const { f } = scene;
    const input = { ...created, settings: f.settings };
    const first = await runChat(f.runtime, (chat) => chat.createChat(input));
    await scene.lose({ lost: 'read', record: Metadata, skip: 0 }, () =>
      runChat(f.runtime, (chat) => chat.createChat(input)),
    );
    assert.deepEqual(await runChat(f.runtime, (chat) => chat.createChat(input)), first);
    assert.equal((await listed(scene)).length, 2);
  },
  'Stop after its request is bound': async (scene) => {
    const { f, target } = scene;
    const receipt = await finishSend(scene);
    const stop = { target, submissionId: receipt.submissionId!, taskId: null };
    await scene.lose({ lost: 'ack' }, () =>
      runChat(f.runtime, (chat) => chat.stopChat({ stop, requestId: 'stop' })),
    );
    // The request ID was bound: it is refused for another target, and answers for its own.
    await assert.rejects(
      runChat(f.runtime, (chat) =>
        chat.stopChat({ stop: { ...stop, taskId: '1' }, requestId: 'stop' }),
      ),
      { _tag: 'RequestReusedError' },
    );
    const stopped = await runChat(f.runtime, (chat) => chat.stopChat({ stop, requestId: 'stop' }));
    assert.equal(stopped.outcome, 'terminal');
  },
};

for (const [name, mutation] of Object.entries(mutations))
  test(`${name} and then failing is uncertain`, async (t) => {
    const original = Harness.open;
    let fault: Fault | undefined, harness: Harness | undefined;
    mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
      const opened = (harness = await original(...args)),
        commit = opened.commit.bind(opened),
        snapshot = opened.snapshot.bind(opened);
      opened.commit = (async (...values: Parameters<typeof commit>) => {
        const result = await commit(...values);
        if (fault?.lost === 'ack') {
          const { rejection = new ChatStoreError({ problem: 'failed' }) } = fault;
          fault = undefined;
          throw rejection;
        }
        return result;
      }) as typeof commit;
      opened.snapshot = (async (...values: Parameters<typeof snapshot>) => {
        if (
          fault?.lost === 'read' &&
          (values[0] as unknown) === fault.record &&
          fault.skip-- === 0
        ) {
          fault = undefined;
          throw new ChatStoreError({ problem: 'failed' });
        }
        return snapshot(...values);
      }) as typeof snapshot;
      return opened;
    });
    t.after(() => mock.restoreAll());
    const f = await fixture(t),
      target = await f.create();
    await mutation({
      f,
      target,
      harness: () => harness!,
      lose: async (armed, call) => {
        fault = { ...armed };
        await assert.rejects(call(), { _tag: 'UncertainError' });
        assert.equal(fault, undefined, 'the fault was never reached');
      },
    });
  });
