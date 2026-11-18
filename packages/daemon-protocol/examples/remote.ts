import { Effect, Layer, ManagedRuntime } from 'effect';
import { ChatService, type ConnectionService } from '@moonbase/contracts/services';
import type { ConnectionError } from '@moonbase/contracts/connection-errors';
import type { ChatSession } from '@moonbase/contracts/chat';
import { DaemonRpcLinkLive, RemoteChatLive } from '@moonbase/daemon-protocol/remote';

/** Consumer process composition root; supply the application's existing connection capability. */
export async function readSavedChats(
  connections: Layer.Layer<ConnectionService, ConnectionError>,
  session: ChatSession,
) {
  const runtime = ManagedRuntime.make(
    RemoteChatLive.pipe(
      Layer.provide(DaemonRpcLinkLive({ host: session.host })),
      Layer.provide(connections),
    ),
  );
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const host = yield* chat.getChatHost({ host: session.host });
        const saved = yield* chat.listChats({ session });
        return { host, saved };
      }),
    );
  } finally {
    await runtime.dispose();
  }
}
