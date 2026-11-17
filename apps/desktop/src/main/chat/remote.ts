import { Context, Layer, Scope, type ManagedRuntime } from 'effect';
import { SshLive } from '@moonbase/ssh';
import { checkHostHealth } from '@moonbase/daemon-protocol/health';
import {
  ChatService,
  ConnectionService,
  LocalHostService,
  ProviderSetupService,
} from '@moonbase/contracts/services';
import type { ApplicationError } from '@moonbase/contracts/errors';
import { DaemonServicesLive } from '../daemon/daemon-services.ts';
import { bindChatClient, bindConnectionClient } from '@moonbase/application/chat/clients';
import { runApplicationEffect } from '@moonbase/application/chat/promises';
import type { ChatConfiguration } from './config.ts';
import type { RemoteChat } from './chat-backends.ts';

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
      DaemonServicesLive({
        host: configuration.context.host,
        connection: SshLive(configuration.ssh, { verify: checkHostHealth }),
        openUrl,
        // The browser is on this Mac, not the host, so ChatGPT's callback can't reach the host:
        // the user pastes the final redirect URL.
        sameMachine: false,
        workspace: false,
      }),
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
