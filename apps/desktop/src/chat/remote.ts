import { Context, Layer, Scope, type ManagedRuntime } from 'effect';
import {
  RemoteChatLive,
  RemoteLocalHostLive,
  RemoteProviderSetupLive,
} from '@moonbase/daemon-protocol/remote';
import { SshLive } from '@moonbase/ssh';
import {
  ChatService,
  ConnectionService,
  LocalHostService,
  ProviderSetupService,
} from '@moonbase/contracts/services';
import { ApplicationError } from '@moonbase/contracts/errors';
import { readProviderSignInUrl } from '@moonbase/contracts/providers-schema';
import { bindChatClient, bindConnectionClient } from '@moonbase/application/runtime/clients';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import type { ChatConfiguration } from './config.ts';
import type { RemoteChat } from '../main/chat-backends.ts';

/**
 * A remote host's daemon in host mode, over the configured SSH forward: the same chat, folder and
 * provider clients as local chat, each refused unless the host's signed health advertises its
 * capability. The connection starts disconnected; the user connects explicitly.
 */
export async function acquireRemoteChat(
  runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>,
  configuration: ChatConfiguration,
  /** Opens a provider's sign-in page in the user's browser. */
  openUrl: (url: string) => Promise<void>,
): Promise<RemoteChat> {
  const services = await runApplicationEffect(
    runtime,
    Layer.buildWithScope(
      Layer.mergeAll(
        RemoteChatLive,
        RemoteLocalHostLive,
        RemoteProviderSetupLive({
          host: configuration.context.host,
          // The host checked the link and the client did again; main opens only such a link.
          openUrl: async (url) => {
            if (readProviderSignInUrl(url) !== url)
              throw new ApplicationError({
                code: 'Unavailable',
                message: 'The provider sign-in link is invalid.',
              });
            await openUrl(url);
          },
          // The browser is on this Mac, not the host, so ChatGPT's callback can't reach the host:
          // the user pastes the final redirect URL.
          sameMachine: false,
        }),
      ).pipe(Layer.provideMerge(SshLive(configuration.ssh))),
      Scope.forkUnsafe(runtime.scope, 'parallel'),
    ),
  );
  const connection = bindConnectionClient(runtime, Context.get(services, ConnectionService));
  await connection.command('getConnection', {});
  return {
    configuration,
    chat: bindChatClient(runtime, Context.get(services, ChatService)),
    connection,
    providers: Context.get(services, ProviderSetupService),
    folders: Context.get(services, LocalHostService),
  };
}
