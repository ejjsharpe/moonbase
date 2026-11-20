import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Stream } from 'effect';
import { ChatService } from '@moonbase/contracts/services';
import { makeChatHandlers } from '../src/server/rpc-handlers.ts';

const host = { hostId: 'handlers-host', storeId: 'handlers-store' };

test('a watch for another host fails with the error its union declares, not as the host’s own failure', async () => {
  const handlers = await Effect.runPromise(
    makeChatHandlers({ host }).pipe(
      // A watch the host serves, which ends at once, so only its refusal of the host can fail it.
      Effect.provideService(ChatService, {
        watch: () => Stream.empty,
        watchChatList: () => Stream.empty,
      } as never),
    ),
  );
  const other = { ...host, hostId: 'other-host' };
  const watches: [string, Stream.Stream<unknown, { _tag: string }>][] = [
    ['watchChat', handlers.watchChat({ host: other, target: {} } as never)],
    ['watchChatList', handlers.watchChatList({ host: other, session: {} } as never)],
  ];
  for (const [watch, stream] of watches)
    assert.equal(
      (await Effect.runPromise(Effect.flip(Stream.runDrain(stream))))._tag,
      'UnauthorizedError',
      watch,
    );
});
