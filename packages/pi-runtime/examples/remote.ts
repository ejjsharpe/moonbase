import { ManagedRuntime, Layer } from 'effect';
import type { ConnectionService } from '@moonbase/application/services';
import type { ApplicationError } from '@moonbase/application/client';
import type { ChatSession } from '@moonbase/application/chat-client';
import { makeChatClient } from '@moonbase/application/runtime-client';
import { RemoteChatLive } from '@moonbase/pi-runtime/remote';

/** Consumer process composition root; supply the application's existing connection capability. */
export async function readSavedChats(
  connections: Layer.Layer<ConnectionService, ApplicationError>,
  session: ChatSession,
) {
  const runtime = ManagedRuntime.make(RemoteChatLive.pipe(Layer.provide(connections)));
  try {
    const client = makeChatClient(runtime);
    const host = await client.command('getChatHost', { host: session.host });
    const saved = await client.command('listChats', { session });
    return { host, saved };
  } finally {
    await runtime.dispose();
  }
}
