import { Context, Exit, Layer, Scope, type ManagedRuntime } from 'effect';
import {
  RemoteChatLive,
  RemoteLocalHostLive,
  RemoteProviderSetupLive,
} from '@moonbase/daemon-protocol/remote';
import {
  ChatService,
  ConnectionService,
  LocalHostService,
  ProviderSetupService,
} from '@moonbase/contracts/services';
import { ApplicationError } from '@moonbase/contracts/errors';
import { readProviderSignInUrl } from '@moonbase/contracts/providers-schema';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import {
  createLocalDaemon,
  LocalDaemonConnectionLive,
  readDaemonSession,
  type LocalDaemonOptions,
} from '../main/local-daemon.ts';

/**
 * Local chat as a client of the local daemon: finds or starts it, then binds chat, folder and
 * provider clients to it over loopback in a scope of the privileged root. Releasing the scope
 * releases only these clients and their watches; the daemon and its runs keep going.
 */
export async function acquireDaemonChat(
  runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>,
  options: LocalDaemonOptions & {
    /** Opens a provider's sign-in page in the user's browser. */
    openUrl(url: string): Promise<void>;
  },
) {
  const daemon = createLocalDaemon(options);
  await daemon.ensure();
  const session = await readDaemonSession(options.directory);
  const scope = Scope.forkUnsafe(runtime.scope, 'sequential');
  try {
    const services = await runApplicationEffect(
      runtime,
      Layer.buildWithScope(
        Layer.mergeAll(
          RemoteChatLive,
          RemoteLocalHostLive,
          RemoteProviderSetupLive({
            host: session.host,
            // The daemon checked the link and the client did again; main opens only such a link.
            openUrl: async (url) => {
              if (readProviderSignInUrl(url) !== url)
                throw new ApplicationError({
                  code: 'Unavailable',
                  message: 'The provider sign-in link is invalid.',
                });
              await options.openUrl(url);
            },
            // The daemon runs on this Mac, so a provider's loopback sign-in callback reaches it.
            sameMachine: true,
          }),
        ).pipe(Layer.provideMerge(LocalDaemonConnectionLive(daemon))),
        scope,
      ),
    );
    const connection = Context.get(services, ConnectionService);
    // Connect now, so a daemon that can't be reached shows at startup.
    await runApplicationEffect(runtime, connection.endpoint({ host: session.host }));
    return {
      session,
      chat: Context.get(services, ChatService),
      providers: Context.get(services, ProviderSetupService),
      folders: Context.get(services, LocalHostService),
    };
  } catch (error) {
    await runApplicationEffect(runtime, Scope.close(scope, Exit.void));
    throw error;
  }
}
export type DaemonChat = Awaited<ReturnType<typeof acquireDaemonChat>>;
