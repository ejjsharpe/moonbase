import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Stream } from 'effect';
import { chatProtocolVersion } from '@moonbase/contracts/host';
import { makeChatHandlers } from '../src/server/rpc-handlers.ts';

const host = { hostId: 'handlers-host', storeId: 'handlers-store' };

test('a watch for another host fails with the error its union declares, not as the host’s own failure', async () => {
  const handlers = makeChatHandlers({
    host,
    health: { ...host, protocol: chatProtocolVersion, version: '0.1.0', capabilities: [] },
    // A watch the host serves, so only its refusal of the host can fail it.
    chat: { watch: () => Stream.never, watchChatList: () => Stream.never } as never,
  }) as Record<string, (payload: unknown) => Stream.Stream<unknown, { _tag: string }>>;
  const other = { ...host, hostId: 'other-host' };
  for (const [watch, payload] of [
    ['watchChat', { host: other, target: {} }],
    ['watchChatList', { host: other, session: {} }],
  ] as const)
    assert.equal(
      (await Effect.runPromise(Effect.flip(Stream.runDrain(handlers[watch]!(payload)))))._tag,
      'UnauthorizedError',
      watch,
    );
});
