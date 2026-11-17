import { Context, Duration, Effect, Exit, Layer, Ref, Scope } from 'effect';
import {
  ChatService,
  ConnectionService,
  LocalHostService,
  ProviderSetupService,
  WorkspaceHostService,
} from '@moonbase/contracts/services';
import { ApplicationError } from '@moonbase/contracts/errors';
import { toConnectionApplicationError } from '@moonbase/contracts/connection-errors';
import { DaemonServicesLive } from './daemon-services.ts';
import {
  daemonRetryAfterMs,
  LocalDaemonConnectionLive,
  olderDaemonMessage,
  type LocalDaemon,
  readDaemonSession,
} from './local-daemon.ts';

const unreachable = (error: unknown) =>
  ApplicationError.is(error)
    ? error
    : new ApplicationError({
        code: 'Unavailable',
        message: 'Moonbase could not start its local chat daemon.',
      });

/**
 * Local chat and files as a client of the local daemon, in the scope: finds or starts it, then
 * binds chat, folder, provider and file host clients to it over loopback. Closing the scope
 * releases only these clients and their watches; the daemon and its runs keep going.
 */
export const acquireDaemonChat = (options: {
  daemon: LocalDaemon;
  /** Opens a provider's sign-in page in the user's browser. */
  openUrl(url: string): Promise<void>;
}) =>
  Effect.gen(function* () {
    const { daemon } = options;
    yield* Effect.tryPromise({ try: () => daemon.ensure(), catch: unreachable });
    const session = yield* Effect.tryPromise({
      try: () => readDaemonSession(daemon.directory),
      catch: unreachable,
    });
    const services = yield* Layer.build(
      DaemonServicesLive({
        host: session.host,
        connection: LocalDaemonConnectionLive(daemon),
        openUrl: options.openUrl,
        sameMachine: true,
        workspace: true,
      }),
    );
    const connection = Context.get(services, ConnectionService);
    // Connect now, so a daemon that can't be reached shows at startup.
    yield* connection
      .endpoint({ host: session.host })
      .pipe(Effect.mapError(toConnectionApplicationError));
    return {
      session,
      connection,
      chat: Context.get(services, ChatService),
      providers: Context.get(services, ProviderSetupService),
      folders: Context.get(services, LocalHostService),
      workspace: Context.get(services, WorkspaceHostService),
    };
  });
export type DaemonChat = Effect.Success<ReturnType<typeof acquireDaemonChat>>;

/**
 * Local chat's and the editor's files' one way to the local daemon, while the scope is open. `get`
 * finds or starts it and binds its clients once (`acquire`), sharing an attempt under way; a
 * failed attempt is every caller's answer for `daemonRetryAfterMs` rather than started again by
 * each. `peek` never starts one. `connect` also makes sure the daemon in use answers, starting it
 * again if it exited.
 */
export const makeLocalDaemonClient = (
  acquire: Effect.Effect<DaemonChat, ApplicationError, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const acquired = yield* Ref.make<DaemonChat | undefined>(undefined);
    /** One attempt, whose clients live in a scope of their own, closed if it fails. */
    const attempt = Effect.gen(function* () {
      const clients = yield* Scope.fork(scope, 'sequential');
      const backend = yield* acquire.pipe(
        Scope.provide(clients),
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(clients, exit))),
      );
      yield* Ref.set(acquired, backend);
      return backend;
    }).pipe(
      Effect.tapError(({ message }) =>
        Effect.logError('The local daemon is unavailable:', message),
      ),
      Effect.mapError(
        ({ code, message }) =>
          new ApplicationError({
            code: 'Unavailable',
            // The daemon's own reason when it is still busy; otherwise the generic one.
            message:
              code === 'Unavailable' && message === olderDaemonMessage
                ? message
                : 'Moonbase could not start or reach its local daemon. Retry; drafts are kept.',
          }),
      ),
    );
    const shared = yield* Effect.cachedWithTTL(attempt, (exit) =>
      Exit.isSuccess(exit) ? Duration.infinity : Duration.millis(daemonRetryAfterMs),
    );
    const get = Effect.flatMap(Ref.get(acquired), (backend) =>
      backend ? Effect.succeed(backend) : shared,
    );
    return {
      get,
      peek: Ref.get(acquired),
      connect: Effect.flatMap(get, (backend) =>
        Effect.map(
          backend.connection
            .endpoint({ host: backend.session.host })
            .pipe(Effect.mapError(toConnectionApplicationError)),
          (endpoint) => ({ ...backend, endpoint }),
        ),
      ),
    };
  });
export type LocalDaemonClient = Effect.Success<ReturnType<typeof makeLocalDaemonClient>>;
