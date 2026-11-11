import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatSnapshot, ChatTarget } from '@moonbase/contracts/chat';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { ChatService, type ChatServiceShape } from '@moonbase/contracts/services';
import { releaseResource } from '@moonbase/effect';

const session = { host: { hostId: 'remote', storeId: 'store' }, actorId: 'personal' };
const target: ChatTarget = { ...session, conversationId: '42' };
const conversation = {
  target,
  title: 'Saved chat',
  createdAt: '2026-11-01T00:00:00.000Z',
  cwd: '/remote/project',
  model: 'configured/model',
};
const snapshot: ChatSnapshot = {
  conversation,
  state: 'idle',
  run: null,
  entries: [],
  olderCursor: null,
  transcriptBoundary: null,
};
function event<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(options: { slowSend?: boolean; cleanupFailure?: boolean } = {}) {
  const counts = {
    acquire: 0,
    release: 0,
    send: 0,
    query: 0,
    stop: 0,
    watch: 0,
    unwatch: 0,
    interrupted: 0,
  };
  const entered = event<void>(),
    watched = event<void>(),
    unwatched = event<void>();
  const service: ChatServiceShape = {
    getChatHost: (input) =>
      Effect.sync(() => {
        assert.deepEqual(input.host, session.host);
        return { ...session, cwd: conversation.cwd, model: conversation.model };
      }),
    listChats: (input) =>
      Effect.sync(() => {
        assert.deepEqual(input.session, session);
        return { conversations: [conversation], nextCursor: null };
      }),
    createChat: (input) =>
      Effect.sync(() => {
        assert.equal(input.title, 'Saved chat');
        return { requestId: input.requestId, conversation };
      }),
    getChat: (input) =>
      Effect.sync(() => {
        assert.deepEqual(input.target, target);
        return snapshot;
      }),
    getChatHistory: (input) =>
      Effect.sync(() => {
        assert.equal(input.cursor, 'older');
        return { entries: [], olderCursor: null };
      }),
    getChatTranscriptContent: () =>
      Effect.fail(
        new ApplicationError({ code: 'Incompatible', message: 'Not served by this fixture.' }),
      ),
    findChatTranscript: () =>
      Effect.fail(
        new ApplicationError({ code: 'Incompatible', message: 'Not served by this fixture.' }),
      ),
    getChatHistoryAround: () =>
      Effect.fail(
        new ApplicationError({ code: 'Incompatible', message: 'Not served by this fixture.' }),
      ),
    findChatFiles: () =>
      Effect.fail(
        new ApplicationError({ code: 'Incompatible', message: 'Not served by this fixture.' }),
      ),
    sendChat: (input) =>
      Effect.gen(function* () {
        assert.deepEqual(input.target, target);
        assert.equal(input.text, 'one input');
        counts.send++;
        entered.resolve();
        if (options.slowSend)
          yield* Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                counts.interrupted++;
              }),
            ),
          );
        return {
          target: input.target,
          requestId: input.requestId,
          admission: 'admitted' as const,
          submissionId: '100',
        };
      }),
    getChatSend: (input) =>
      Effect.sync(() => {
        counts.query++;
        return {
          target: input.target,
          requestId: input.requestId,
          admission: 'admitted' as const,
          submissionId: '100',
        };
      }),
    stopChat: (input) =>
      Effect.sync(() => {
        counts.stop++;
        assert.equal(input.stop.submissionId, '100');
        assert.equal(input.stop.taskId, '101');
        return { ...input, outcome: 'stopped' as const };
      }),
    settleChat: () =>
      Effect.fail(
        new ApplicationError({ code: 'Incompatible', message: 'Not served by this fixture.' }),
      ),
    watchChatList: () => Stream.never,
    watch: (input) =>
      Stream.unwrap(
        Effect.as(
          Effect.acquireRelease(
            Effect.sync(() => {
              assert.deepEqual(input.target, target);
              counts.watch++;
              watched.resolve();
            }),
            () =>
              releaseResource(() => {
                counts.unwatch++;
                unwatched.resolve();
                if (options.cleanupFailure) throw Error('Chat observer cleanup failed');
              }),
          ),
          Stream.concat(Stream.succeed(snapshot), Stream.never),
        ),
      ),
  };
  const runtime = ManagedRuntime.make(
    Layer.effect(
      ChatService,
      Effect.acquireRelease(
        Effect.sync(() => {
          counts.acquire++;
          return service;
        }),
        () =>
          releaseResource(() => {
            counts.release++;
          }),
      ),
    ),
  );
  return { counts, runtime, client: makeChatClient(runtime), entered, watched, unwatched };
}

test('public chat entry points share one scope and preserve exact targets/request identities', async () => {
  const { counts, runtime, client, watched, unwatched } = fixture();
  const second = makeChatClient(runtime);
  let unsubscribe = async () => {};
  try {
    const host = await client.command('getChatHost', { host: session.host });
    assert('cwd' in host);
    assert.equal(host.cwd, conversation.cwd);
    assert.deepEqual((await second.command('listChats', { session })).conversations, [
      conversation,
    ]);
    assert.equal(
      (
        await client.command('createChat', {
          session,
          requestId: 'create-one',
          title: 'Saved chat',
        })
      ).requestId,
      'create-one',
    );
    const receipt = await second.command('sendChat', {
      target,
      requestId: 'send-one',
      text: 'one input',
    });
    assert.equal(receipt.requestId, 'send-one');
    assert.equal(receipt.admission, 'admitted');
    assert.deepEqual(
      await client.command('getChatSend', { target, requestId: 'send-one' }),
      receipt,
    );
    assert.deepEqual(await client.command('getChatHistory', { target, cursor: 'older' }), {
      entries: [],
      olderCursor: null,
    });
    const received = event<ChatSnapshot>();
    unsubscribe = second.watch(
      { target },
      (value) => received.resolve(value),
      (error) => {
        throw error;
      },
    );
    await watched.promise;
    assert.deepEqual(await received.promise, snapshot);
    await unsubscribe();
    await unwatched.promise;
    assert.equal((await client.command('getChat', { target })).state, 'idle');
    assert.equal(counts.send, 1);
    assert.equal(counts.stop, 0);
    assert.equal(counts.release, 0);
    const stop = { target, submissionId: '100', taskId: '101' };
    assert.deepEqual(await second.command('stopChat', { stop, requestId: 'stop-one' }), {
      stop,
      requestId: 'stop-one',
      outcome: 'stopped',
    });
    assert.equal(counts.acquire, 1);
  } finally {
    await unsubscribe();
    await runtime.dispose();
  }
  assert.equal(counts.release, 1);
  assert.equal(counts.unwatch, 1);
});

test('in-flight chat dispatch permits status and explicit Stop; cancellation invents no Stop', async () => {
  const { counts, runtime, client, entered } = fixture({ slowSend: true });
  const abort = new AbortController();
  const pending = client.command(
    'sendChat',
    { target, requestId: 'send-one', text: 'one input' },
    { signal: abort.signal },
  );
  const rejected = assert.rejects(
    pending,
    (error) => ApplicationError.is(error) && error.code === 'Cancelled',
  );
  try {
    await entered.promise;
    assert.equal((await client.command('getChat', { target })).state, 'idle');
    await client.command('stopChat', {
      stop: { target, submissionId: '100', taskId: '101' },
      requestId: 'stop-one',
    });
    abort.abort();
    await rejected;
    assert.equal(counts.interrupted, 1);
    assert.equal(counts.stop, 1);
    assert.equal(counts.release, 0);
  } finally {
    abort.abort();
    await runtime.dispose();
  }
});

test('pre-aborted chat commands acquire nothing', async () => {
  const { counts, runtime, client } = fixture();
  const abort = new AbortController();
  abort.abort();
  try {
    await assert.rejects(
      client.command(
        'sendChat',
        { target, requestId: 'send-one', text: 'one input' },
        { signal: abort.signal },
      ),
      (error) => ApplicationError.is(error) && error.code === 'Cancelled',
    );
  } finally {
    await runtime.dispose();
  }
  assert.equal(counts.acquire, 0);
  assert.equal(counts.send, 0);
});

test('chat observer failures stay observable without closing the process service', async () => {
  const { counts, runtime, client, watched } = fixture({ cleanupFailure: true });
  const failure = event<ApplicationError>();
  let unsubscribe = async () => {};
  try {
    unsubscribe = client.watch(
      { target },
      () => {},
      (error) => failure.resolve(error),
    );
    await watched.promise;
    let error!: ApplicationError;
    await assert.rejects(unsubscribe(), (value) => {
      assert(ApplicationError.is(value));
      error = value;
      return true;
    });
    assert.equal(error.code, 'Unavailable');
    assert.match(error.message, /Application resource cleanup failed/);
    assert.equal(counts.unwatch, 1);
    assert.equal(counts.release, 0);
    assert.equal(counts.stop, 0);
    await client.command('getChat', { target });
  } finally {
    await unsubscribe().catch(() => {});
    await runtime.dispose();
  }
});
