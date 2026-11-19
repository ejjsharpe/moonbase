import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer } from 'effect';
import { RpcClientDefect, RpcClientError } from 'effect/rpc/RpcClientError';
import { IpcClosedError } from '@moonbase/contracts/ipc-errors';
import { DesktopRpcs } from '../src/ipc/desktop-rpcs.ts';
import { DesktopIpc } from '../src/renderer/ipc/desktop-ipc.ts';
import { callEffect, type Tag } from '../src/renderer/ipc/ipc-failures.ts';

test('a closed connection says a procedure may have run exactly when it is a mutation', async () => {
  // A connection that closes under every request.
  const closed = new Proxy(
    {},
    {
      get: () => () =>
        Effect.fail(
          new RpcClientError({
            reason: new RpcClientDefect({ message: 'closed', cause: undefined }),
          }),
        ),
    },
  ) as DesktopIpc['Service'];
  const sent = await Effect.runPromise(
    Effect.forEach([...DesktopRpcs.requests.keys()] as Tag[], (tag) =>
      callEffect(tag, undefined as never, 'desktop-request').pipe(
        Effect.flip,
        Effect.map((error) => {
          assert(error instanceof IpcClosedError, tag);
          return [tag, error.sent] as const;
        }),
      ),
    ).pipe(Effect.provide(Layer.succeed(DesktopIpc, closed))),
  );
  assert.deepEqual(
    sent
      .filter(([, mutation]) => mutation)
      .map(([tag]) => tag)
      .sort(),
    [
      'acknowledgeOperation',
      'answerProviderPrompt',
      'cancelProviderLogin',
      'connect',
      'createChat',
      'createChatWorktree',
      'createWorktree',
      'disconnect',
      'initializeRepository',
      'logoutProvider',
      'mutate',
      'saveFile',
      'sendChat',
      'settleChat',
      'startProviderLogin',
      'stopChat',
      'turnChatIntoProject',
    ],
  );
});
