import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { ApplicationError } from '@moonbase/application/client';
import type { ChatClient } from '@moonbase/application/chat-client';
import { ConnectionService, releaseResource } from '@moonbase/application/services';
import { makeConnectionClient } from '@moonbase/application/runtime-client';
import { runApplicationEffect } from '@moonbase/application/effect-client';
import { cancellation } from '../src/wire.ts';
import { ChatIpcSession } from '../src/chat/session.ts';

for (const closing of ['cancel', 'document', 'dispose'] as const) {
  test(`${closing} acknowledgment joins actual runtime-client stream finalizers and retains safe failures`, async () => {
    const ready = Promise.withResolvers<void>(),
      releasing = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();
    let releases = 0;
    const runtime = ManagedRuntime.make(
      Layer.succeed(ConnectionService, {
        getConnection: () =>
          Effect.fail(
            new ApplicationError({ code: 'Unavailable', message: 'No connection required' }),
          ),
        connect: () =>
          Effect.fail(
            new ApplicationError({ code: 'Unavailable', message: 'No connection required' }),
          ),
        disconnect: () =>
          Effect.fail(
            new ApplicationError({ code: 'Unavailable', message: 'No connection required' }),
          ),
        endpoint: () =>
          Effect.fail(
            new ApplicationError({ code: 'Unauthorized', message: 'No endpoint required' }),
          ),
        watch: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => ready.resolve()),
                () =>
                  releaseResource(async () => {
                    releases++;
                    releasing.resolve();
                    await gate.promise;
                    throw new ApplicationError({
                      code: 'Persistence',
                      message: 'Owned stream release failed',
                    });
                  }),
              );
              return Stream.never;
            }),
          ),
      }),
    );
    const chat: ChatClient = { command: async () => null as never, watch: () => async () => {} };
    const owner = new ChatIpcSession(
      runtime,
      chat,
      makeConnectionClient(runtime),
      { host: { hostId: 'host', storeId: 'store' }, actorId: 'actor' },
      () => {},
    );
    try {
      await owner.call('watch-connection', '', {}, 'owned');
      await ready.promise;
      let settled = false;
      let completion: Promise<unknown>;
      if (closing === 'cancel') completion = owner.cancel('owned');
      else if (closing === 'document') completion = owner.releaseDocument();
      else completion = owner.dispose();
      const outcome = completion.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      void outcome.then(() => {
        settled = true;
      });
      await releasing.promise;
      assert.equal(settled, false);
      assert.equal(
        await runApplicationEffect(runtime, Effect.succeed('unrelated commands remain usable')),
        'unrelated commands remain usable',
      );
      gate.resolve();
      const result = await outcome;
      let error: unknown;
      if ('error' in result) error = result.error;
      else if (closing === 'cancel') {
        try {
          cancellation(result.value);
        } catch (failure) {
          error = failure;
        }
      }
      assert(ApplicationError.is(error));
      assert.equal(error.code, 'Persistence');
      assert.match(error.message, /Owned stream release failed/);
      assert.equal(releases, 1);
      await assert.rejects(owner.dispose(), { code: 'Persistence' });
    } finally {
      gate.resolve();
      await owner.dispose().catch(() => {});
      await runApplicationEffect(runtime, runtime.disposeEffect);
    }
  });
}
