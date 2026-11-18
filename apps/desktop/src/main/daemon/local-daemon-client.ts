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

/** Whether the daemon's clients are bound, and to which backend, or released for good. */
type ClientState =
  | { _tag: 'Unbound' }
  | { _tag: 'Bound'; backend: DaemonChat }
  | { _tag: 'Released' };
const released = () =>
  new ApplicationError({ code: 'Unavailable', message: 'Moonbase is quitting.' });

/**
 * Local chat's and the editor's files' one way to the local daemon, while the scope is open. `get`
 * finds or starts it and binds its clients once (`acquire`), sharing an attempt under way; a
 * failed attempt is every caller's answer for `daemonRetryAfterMs` rather than started again by
 * each. `peek` never starts one. `connect` also makes sure the daemon in use answers, starting it
 * again if it exited.
 *
 * The clients live in a scope taken when this is built, however late they are first acquired, so
 * what is built after it in the same scope (the recovery store, the documents and the imports
 * they hold) is released while the clients still answer. Once the scope closes, nothing reaches
 * the clients again.
 */
export const makeLocalDaemonClient = (
  acquire: Effect.Effect<DaemonChat, ApplicationError, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const clients = yield* Scope.fork(yield* Effect.scope, 'sequential');
    const state = yield* Ref.make<ClientState>({ _tag: 'Unbound' });
    /** One attempt, whose clients live in a scope of their own, closed if it fails. */
    const attempt = Effect.gen(function* () {
      const own = yield* Scope.fork(clients, 'sequential');
      const backend = yield* acquire.pipe(
        Scope.provide(own),
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(own, exit))),
      );
      const bound = yield* Ref.modify(state, (current): readonly [boolean, ClientState] =>
        current._tag === 'Released' ? [false, current] : [true, { _tag: 'Bound', backend }],
      );
      if (!bound)
        return yield* Effect.andThen(Scope.close(own, Exit.void), Effect.fail(released()));
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
    const [shared, forget] = yield* Effect.cachedInvalidateWithTTL(attempt, (exit) =>
      Exit.isSuccess(exit) ? Duration.infinity : Duration.millis(daemonRetryAfterMs),
    );
    // Added after the clients' scope, so it runs first as the scope closes: from then on no
    // caller reaches the clients being released.
    yield* Effect.addFinalizer(() => Effect.andThen(Ref.set(state, { _tag: 'Released' }), forget));
    const get = Effect.flatMap(Ref.get(state), (current) => {
      if (current._tag === 'Bound') return Effect.succeed(current.backend);
      return current._tag === 'Released' ? Effect.fail(released()) : shared;
    });
    return {
      get,
      peek: Effect.map(Ref.get(state), (current) =>
        current._tag === 'Bound' ? current.backend : undefined,
      ),
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
