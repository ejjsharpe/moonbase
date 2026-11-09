import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import {
  ApplicationError,
  emptyRecovery,
  type EditorClient,
  type ObservationClose,
} from '@moonbase/contracts/workspace';
import type { ChatClient } from '@moonbase/contracts/chat';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import { EditorSession } from '../src/session.ts';
import { ChatIpcSession } from '../src/chat/session.ts';

const checkout = {
  hostId: 'local',
  checkoutId: 'checkout',
  projectId: 'project',
  root: '/approved',
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'actor' };

async function createSession(
  kind: 'editor' | 'chat',
  acquire: (receive: () => void) => ObservationClose,
  emit: () => void,
  commandGate?: Promise<void>,
) {
  const runtime = ManagedRuntime.make(Layer.empty);
  const recovery = {
    revision: 0,
    state: { ...emptyRecovery('desktop-primary'), checkouts: [checkout] },
    operations: [],
    errors: [],
  };
  const client: EditorClient = {
    command: async () => {
      await commandGate;
      return recovery as never;
    },
    watch: (_input, receive) => acquire(() => receive({ checkout, paths: [] })),
  };
  const chat: ChatClient = {
    command: async () => null as never,
    watch: (_input, receive) => acquire(() => receive({} as never)),
  };
  const owner =
    kind === 'editor'
      ? new EditorSession(
          runtime,
          client,
          {
            copyText: async () => {},
            reveal: async () => {},
            chooseCheckout: async () => null,
            imports: async () => [],
            release: async () => {},
          },
          emit,
        )
      : new ChatIpcSession(
          runtime,
          chat,
          {
            command: async () => {
              await commandGate;
              return null as never;
            },
            watch: () => async () => {},
          },
          context,
          emit,
        );
  // Restore authority before optionally holding later commands.
  if (owner instanceof EditorSession) {
    const original = client.command;
    client.command = async () => recovery as never;
    assert(
      (
        await owner.call(
          'command',
          {
            operation: 'loadRecovery',
            input: { clientId: owner.clientId },
          },
          'load',
        )
      ).ok,
    );
    client.command = original;
  }
  return {
    owner,
    runtime,
    capacity: kind === 'editor' ? 128 : 64,
    watch: (id: string) =>
      owner instanceof EditorSession
        ? owner.call('watch', { checkout, paths: [] }, id)
        : owner.call('watch-chat', '', { target: { ...context, conversationId: 'chat' } }, id),
    command: (id: string) =>
      owner instanceof EditorSession
        ? owner.call(
            'command',
            { operation: 'loadRecovery', input: { clientId: owner.clientId } },
            id,
          )
        : owner.call('connection', 'getConnection', {}, id),
    async dispose() {
      await owner.dispose().catch(() => {});
      await runApplicationEffect(runtime, runtime.disposeEffect);
    },
  };
}

for (const kind of ['editor', 'chat'] as const) {
  test(`${kind} failed watch acquisition fences queued callbacks immediately`, async () => {
    let delivered = 0;
    const f = await createSession(
      kind,
      (receive) => {
        queueMicrotask(receive);
        throw new ApplicationError({ code: 'Persistence', message: 'Acquisition failed' });
      },
      () => {
        delivered++;
      },
    );
    try {
      await assert.rejects(f.watch('failed'), { code: 'Persistence' });
      assert.equal(delivered, 0);
    } finally {
      await f.dispose();
    }
  });

  test(`${kind} keeps command/watch capacity separate`, async () => {
    const gate = Promise.withResolvers<void>();
    const f = await createSession(
      kind,
      () => async () => {},
      () => {},
      gate.promise,
    );
    try {
      const commands = Array.from({ length: f.capacity }, (_, index) =>
        f.command(`command-${index}`),
      );
      for (let index = 0; index < f.capacity; index++) assert((await f.watch(`watch-${index}`)).ok);
      const overflow = async (call: Promise<{ ok: boolean }>) => {
        if (kind === 'editor') assert.equal((await call).ok, false);
        else await assert.rejects(call, { code: 'InvalidInput' });
      };
      await overflow(f.command('extra-command'));
      await overflow(f.watch('extra-watch'));
      gate.resolve();
      assert((await Promise.all(commands)).every((reply) => reply.ok));
      assert((await f.command('available')).ok);
    } finally {
      gate.resolve();
      await f.dispose();
    }
  });

  test(`${kind} retains 128 cancellation failures with its own wire policy`, async () => {
    const expected = new ApplicationError({
      code: 'Persistence',
      message: 'release failed '.repeat(64),
      target: { checkout, path: 'a.ts' },
    });
    const f = await createSession(
      kind,
      () => async () => {
        throw expected;
      },
      () => {},
    );
    try {
      for (let index = 0; index < 128; index++) {
        const id = `failed-${index}`;
        assert((await f.watch(id)).ok);
        const cancellation = f.owner.cancel(id);
        assert.equal(f.owner.cancel(id), cancellation);
        const reply = await cancellation;
        assert(!reply.ok);
        assert.equal(reply.error.code, 'Persistence');
        assert.equal(
          reply.error.message,
          kind === 'editor' ? expected.message : expected.message.slice(0, 512),
        );
        assert.deepEqual(reply.error.target, kind === 'editor' ? expected.target : undefined);
        assert.equal(await f.owner.cancel(id), reply);
      }
      if (kind === 'editor') {
        const reply = await f.command('blocked');
        assert(!reply.ok);
        assert.equal(reply.error.code, 'Unavailable');
      } else await assert.rejects(f.command('blocked'), { code: 'InvalidInput' });
      const disposal = f.owner.dispose();
      assert.equal(f.owner.dispose(), disposal);
      await assert.rejects(disposal, { code: 'Persistence' });
    } finally {
      await f.dispose();
    }
  });
}

// Only the editor replaces its document in place; chat-backends.test.ts covers chat document replacement.
for (const failure of [false, true]) {
  test(`editor reentrant document replacement isolates a reused ID and joins ${failure ? 'failing' : 'held'} release`, async () => {
    const releasing = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();
    const receives: (() => void)[] = [],
      releases = [0, 0];
    let replacement: Promise<void> | undefined,
      newWatch: ReturnType<EditorSession['call']> | undefined,
      delivered = 0;
    const f = await createSession(
      'editor',
      (receive) => {
        const index = receives.length;
        receives.push(receive);
        receive();
        if (index === 0) receive();
        return async () => {
          releases[index]++;
          if (index === 0) {
            releasing.resolve();
            await gate.promise;
          }
        };
      },
      () => {
        delivered++;
        if (delivered === 1) {
          assert(f.owner instanceof EditorSession);
          replacement = f.owner.releaseDocument();
          newWatch = f.watch('reused');
        }
      },
    );
    try {
      const oldWatch = f.watch('reused');
      assert(replacement);
      const outcome = replacement.then(
        () => undefined,
        (error: unknown) => error,
      );
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      await releasing.promise;
      assert.equal(settled, false);
      assert((await newWatch)?.ok);
      receives[0]();
      receives[1]();
      assert.equal(delivered, 3);
      assert((await f.command('unrelated')).ok);
      assert.equal(await runApplicationEffect(f.runtime, Effect.succeed('usable')), 'usable');
      assert((await f.owner.cancel('reused')).ok);
      assert.deepEqual(releases, [1, 1]);
      receives[1]();
      assert.equal(delivered, 3);
      if (failure)
        gate.reject(new ApplicationError({ code: 'Persistence', message: 'Old release failed' }));
      else gate.resolve();
      assert((await oldWatch).ok);
      const error = await outcome;
      const disposal = f.owner.dispose();
      assert.equal(f.owner.dispose(), disposal);
      if (failure) {
        assert(ApplicationError.is(error));
        assert.equal(error.code, 'Persistence');
        await assert.rejects(disposal, { code: 'Persistence' });
      } else {
        assert.equal(error, undefined);
        await disposal;
      }
      assert.deepEqual(releases, [1, 1]);
    } finally {
      gate.resolve();
      await f.dispose();
    }
  });
}
