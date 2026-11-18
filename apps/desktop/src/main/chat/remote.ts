import { Context, Effect, Layer } from 'effect';
import { SshLive } from '@moonbase/ssh';
import { checkHostHealth } from '@moonbase/daemon-protocol/health';
import {
  ChatService,
  ConnectionService,
  LocalHostService,
  ProviderSetupService,
} from '@moonbase/contracts/services';
import { toConnectionApplicationError } from '@moonbase/contracts/connection-errors';
import { DaemonServicesLive } from '../daemon/daemon-services.ts';
import type { ChatConfiguration } from './config.ts';
import type { RemoteChat } from './chat-backends.ts';

/**
 * A remote host's daemon in host mode, over the configured SSH forward, while the scope is open:
 * the same chat, folder and provider clients as local chat, each refused unless the host's signed
 * health advertises its capability. The connection starts disconnected; the user connects
 * explicitly.
 */
export const acquireRemoteChat = (
  configuration: ChatConfiguration,
  /** Opens a provider's sign-in page in the user's browser. */
  openUrl: (url: string) => Promise<void>,
) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      DaemonServicesLive({
        host: configuration.context.host,
        connection: SshLive(configuration.ssh, { verify: checkHostHealth }),
        openUrl,
        // The browser is on this Mac, not the host, so ChatGPT's callback can't reach the host:
        // the user pastes the final redirect URL.
        sameMachine: false,
        workspace: false,
      }),
    );
    const connection = Context.get(services, ConnectionService);
    yield* connection.getConnection({}).pipe(Effect.mapError(toConnectionApplicationError));
    return {
      configuration,
      chat: Context.get(services, ChatService),
      connection,
      providers: Context.get(services, ProviderSetupService),
      folders: Context.get(services, LocalHostService),
    } satisfies RemoteChat;
  });
