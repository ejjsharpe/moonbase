import { normalizeApplicationError } from '@moonbase/effect';
import { Context, Effect, Exit, Layer, Scope, type ManagedRuntime } from 'effect';
import {
  RemoteChatLive,
  RemoteLocalHostLive,
  RemoteProviderSetupLive,
  RemoteWorkspaceHostLive,
} from '@moonbase/daemon-protocol/remote';
import {
  ChatService,
  ConnectionService,
  LocalHostService,
  ProviderSetupService,
  WorkspaceHostService,
} from '@moonbase/contracts/services';
import { ApplicationError } from '@moonbase/contracts/errors';
import { toConnectionApplicationError } from '@moonbase/contracts/connection-errors';
import { readProviderSignInUrl } from '@moonbase/contracts/providers-schema';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import {
  daemonRetryAfterMs,
  LocalDaemonConnectionLive,
  olderDaemonMessage,
  type LocalDaemon,
  readDaemonSession,
} from './local-daemon.ts';

/**
 * Local chat and files as a client of the local daemon: finds or starts it, then binds chat, folder,
 * provider and file host clients to it over loopback in a scope of the privileged root. Releasing the scope
 * releases only these clients and their watches; the daemon and its runs keep going.
 */
export async function acquireDaemonChat(
  runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>,
  options: {
    daemon: LocalDaemon;
    /** Opens a provider's sign-in page in the user's browser. */
    openUrl(url: string): Promise<void>;
  },
) {
  const { daemon } = options;
  await daemon.ensure();
  const session = await readDaemonSession(daemon.directory);
  const scope = Scope.forkUnsafe(runtime.scope, 'sequential');
  try {
    const services = await runApplicationEffect(
      runtime,
      Layer.buildWithScope(
        Layer.mergeAll(
          RemoteChatLive,
          RemoteLocalHostLive,
          // The daemon's file host, on the same socket as chat.
          RemoteWorkspaceHostLive({ host: session.host }),
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
    await runApplicationEffect(
      runtime,
      connection
        .endpoint({ host: session.host })
        .pipe(Effect.mapError(toConnectionApplicationError)),
    );
    return {
      session,
      connection,
      chat: Context.get(services, ChatService),
      providers: Context.get(services, ProviderSetupService),
      folders: Context.get(services, LocalHostService),
      workspace: Context.get(services, WorkspaceHostService),
    };
  } catch (error) {
    await runApplicationEffect(runtime, Scope.close(scope, Exit.void));
    throw error;
  }
}
export type DaemonChat = Awaited<ReturnType<typeof acquireDaemonChat>>;

export type LocalDaemonClient = ReturnType<typeof createLocalDaemonClient>;
/**
 * Local chat's and the editor's files' one way to the local daemon. `get` finds or starts it and
 * binds its clients once (`acquire`), sharing an attempt under way; a failed attempt is every
 * caller's answer for `daemonRetryAfterMs` rather than started again by each. `peek` never starts
 * one. `connect` also makes sure the daemon in use answers, starting it again if it exited.
 */
export function createLocalDaemonClient(
  acquire: () => Promise<DaemonChat>,
  now: () => number = Date.now,
) {
  let backend: DaemonChat | undefined,
    attempt: Promise<DaemonChat> | undefined,
    failed: { error: ApplicationError; at: number } | undefined;
  const get = (): Promise<DaemonChat> => {
    if (backend) return Promise.resolve(backend);
    const since = failed && now() - failed.at;
    if (failed && since !== undefined && since >= 0 && since < daemonRetryAfterMs)
      return Promise.reject(failed.error);
    return (attempt ??= acquire()
      .then(
        (acquired) => {
          failed = undefined;
          return (backend = acquired);
        },
        (error: unknown) => {
          const { code, message } = normalizeApplicationError(error);
          console.error('The local daemon is unavailable:', message);
          failed = {
            error: new ApplicationError({
              code: 'Unavailable',
              // The daemon's own reason when it is still busy; otherwise the generic one.
              message:
                code === 'Unavailable' && message === olderDaemonMessage
                  ? message
                  : 'Moonbase could not start or reach its local daemon. Retry; drafts are kept.',
            }),
            at: now(),
          };
          throw failed.error;
        },
      )
      .finally(() => {
        attempt = undefined;
      }));
  };
  return {
    get,
    peek: () => backend ?? null,
    connect: () =>
      Effect.flatMap(
        Effect.tryPromise({ try: get, catch: (error) => error as ApplicationError }),
        (acquired) =>
          Effect.map(
            acquired.connection
              .endpoint({ host: acquired.session.host })
              .pipe(Effect.mapError(toConnectionApplicationError)),
            (endpoint) => ({ ...acquired, endpoint }),
          ),
      ),
  };
}
