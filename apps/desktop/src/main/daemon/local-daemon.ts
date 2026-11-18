import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Ref,
  Scope,
  Semaphore,
  SynchronizedRef,
} from 'effect';
import type { ChatSession } from '@moonbase/contracts/chat';
import type { ApplicationError } from '@moonbase/contracts/errors';
import { toConnectionApplicationError } from '@moonbase/contracts/connection-errors';
import {
  ChatService,
  ConnectionService,
  LocalHostService,
  ProviderSetupService,
  WorkspaceHostService,
  type ConnectionServiceShape,
  type VerifiedChatEndpoint,
} from '@moonbase/contracts/services';
import { LoopbackConnectionLive, loopbackProfileId } from '@moonbase/daemon-protocol/loopback';
import { DaemonServicesLive } from './daemon-services.ts';
import { readDaemonSession } from './daemon-files.ts';
import { makeDaemonProcess, type DaemonProcessOptions } from './daemon-process.ts';
import { LocalDaemonError, toDaemonApplicationError } from './local-daemon-errors.ts';

/**
 * How long a failed attempt to find, start or reach the local daemon is answered again, to every
 * caller, without trying anew; a crash-looping or hung daemon is then started at most this often.
 */
export const daemonRetryAfterMs = 2000;

/** The local daemon's clients: chat, folders, provider setup and its file host, over loopback. */
export type DaemonClients = {
  session: ChatSession;
  connection: ConnectionServiceShape;
  chat: ChatService['Service'];
  providers: ProviderSetupService['Service'];
  folders: LocalHostService['Service'];
  workspace: WorkspaceHostService['Service'];
};
/** The clients and the loopback connection under them, which only the daemon connects. */
type Bound = DaemonClients & { loopback: ConnectionServiceShape };
/**
 * Whether the daemon's clients are bound, and to which daemon process they last connected, or
 * released for good.
 */
type ClientState =
  | { _tag: 'Unbound' }
  | { _tag: 'Bound'; clients: Bound; connectedTo: number | undefined }
  | { _tag: 'Released' };

/** Why an attempt failed: the daemon's own reason, or the loopback connection's legacy error. */
type AttemptError = LocalDaemonError | ApplicationError;
/** The one attempt under way, or the failure the last one ended with, kept for a moment. */
type Attempt =
  | { _tag: 'Idle' }
  | { _tag: 'Running'; fiber: Fiber.Fiber<Bound, AttemptError> }
  | { _tag: 'Failed'; error: AttemptError; at: number };

const quitting = () => new LocalDaemonError({ reason: 'quitting' });
const unreachable = () => new LocalDaemonError({ reason: 'unreachable' });
/** What `get` and `connect` fail with: an older daemon's or Quit's reason, else the generic one. */
const toCallerError = (error: AttemptError) =>
  error._tag === 'LocalDaemonError' &&
  (error.reason === 'older-daemon' || error.reason === 'quitting')
    ? error
    : unreachable();
/**
 * Runs `effect` on the system clock: it waits on real processes, so it keeps real time even when
 * the caller's clock is a TestClock.
 */
const onSystemClock = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.updateContext(effect, (context: Context.Context<never>) =>
    Context.omit(Clock.Clock)(context),
  );

/**
 * Local chat's and the editor's files' one way to the profile's daemon. The daemon outlives the
 * app; main finds or starts it on demand and binds its clients once. Closing the scope releases
 * only those clients and their watches, and a daemon start still under way; the daemon and its
 * runs keep going.
 */
export class LocalDaemon extends Context.Service<
  LocalDaemon,
  {
    /** The clients, finding or starting the daemon and binding them the first time. */
    readonly get: Effect.Effect<DaemonClients, LocalDaemonError>;
    /** The clients if they are bound; never starts a daemon. */
    readonly peek: Effect.Effect<DaemonClients | undefined>;
    /** The clients and the running daemon's endpoint, finding or starting it again if it exited. */
    readonly connect: Effect.Effect<
      DaemonClients & { endpoint: VerifiedChatEndpoint },
      LocalDaemonError
    >;
    /** Whether the daemon in use still runs. */
    readonly isRunning: Effect.Effect<boolean>;
    /** The daemon's session, from its directory. */
    readonly session: Effect.Effect<ChatSession, LocalDaemonError>;
    /**
     * Restart Daemon: stops the daemon of this profile (`SIGTERM`), one of an older protocol
     * included, then starts this app's and connects to it; its runs resume there.
     */
    readonly restart: Effect.Effect<void, LocalDaemonError>;
  }
>()('moonbase/desktop/LocalDaemon') {}

export type LocalDaemonOptions = DaemonProcessOptions & {
  /** Opens a provider's sign-in page in the user's browser. */
  openUrl(url: string): Promise<void>;
  /** How often an outdated daemon is asked whether it still has work; 30 seconds. */
  replaceMs?: number;
};

/**
 * The local daemon. Everything that reaches it shares one acquisition: when its clients aren't
 * bound yet, or the daemon in use exited (crashed, or stopped once idle) or its connection
 * dropped, the next request finds or starts a daemon, binds the clients if they aren't, and
 * connects them in a new generation; chat watches of the old one fail as `Unavailable` and their
 * clients reconnect them. There is one attempt at a time: requests waiting meanwhile, and those
 * arriving later, join it, and it runs to the end even when they all stop waiting. Its failure is
 * kept when it ends, and is every request's answer for `daemonRetryAfterMs` after that. Attempts,
 * replacing and stopping take one lock.
 *
 * While the daemon in use is of another build, it is asked every `replaceMs` whether it has
 * active work (which keeps it from idling out); once it has none, it is replaced by this app's
 * daemon and reconnected the same way.
 *
 * The clients live in a scope taken when this is built, however late they are bound, so what is
 * built after it in the same scope is released while the clients still answer. Once the scope
 * starts closing, nothing reaches them again, and an attempt under way is interrupted: a daemon it
 * started that doesn't listen yet is stopped with its process group.
 */
export const LocalDaemonLive = ({ openUrl, replaceMs = 30_000, ...options }: LocalDaemonOptions) =>
  Layer.effect(
    LocalDaemon,
    Effect.gen(function* () {
      const { directory } = options;
      const daemon = yield* makeDaemonProcess(options);
      const lock = yield* Semaphore.make(1);
      const scope = yield* Effect.scope;
      // Closed last: the clients outlive the attempts, and what is built after this layer.
      const clients = yield* Scope.fork(scope, 'sequential');
      // Closed before the clients: an attempt under way is interrupted and waited for.
      const attempts = yield* FiberSet.make<Bound, AttemptError>();
      const state = yield* Ref.make<ClientState>({ _tag: 'Unbound' });

      /**
       * Whether the bound clients are connected to the daemon in use, which still runs: not while
       * an attempt or a replacement has a new daemon but hasn't connected to it yet.
       */
      const isReady = (current: Extract<ClientState, { _tag: 'Bound' }>) =>
        Effect.gen(function* () {
          if (current.connectedTo === undefined || current.connectedTo !== (yield* daemon.pid))
            return false;
          const connection = yield* Effect.orElseSucceed(
            current.clients.loopback.getConnection({}),
            () => ({ state: 'failed' }),
          );
          return connection.state === 'connected' && (yield* daemon.isRunning);
        });
      /**
       * Connects the loopback connection, starting a new daemon if the one in use runs but doesn't
       * answer, and notes which daemon process the clients now reach.
       */
      const connectLoopback = (bound: Bound) => {
        const connect = bound.loopback.connect({ profileId: loopbackProfileId }).pipe(
          Effect.mapError(toConnectionApplicationError),
          Effect.tapError(({ message }) =>
            Effect.logError('The local daemon is unreachable:', message),
          ),
        );
        return Effect.catch(connect, (error): Effect.Effect<unknown, AttemptError> =>
          error.code === 'Unavailable' ? Effect.andThen(daemon.start, connect) : Effect.fail(error),
        ).pipe(Effect.andThen(daemon.pid));
      };
      /** The daemon's clients over loopback, in the scope `own`. */
      const bind = (own: Scope.Closeable) =>
        Effect.gen(function* () {
          const session = yield* readDaemonSession(directory);
          const loopback = Context.get(
            yield* Layer.buildWithScope(LoopbackConnectionLive({ directory }), own).pipe(
              Effect.tapError(({ message }) =>
                Effect.logError('The local daemon connection is unavailable:', message),
              ),
              Effect.mapError(unreachable),
            ),
            ConnectionService,
          );
          const services = yield* Layer.buildWithScope(
            DaemonServicesLive({
              host: session.host,
              connection: Layer.succeed(ConnectionService, reaching(loopback)),
              openUrl,
              sameMachine: true,
              workspace: true,
            }),
            own,
          );
          return {
            session,
            loopback,
            connection: Context.get(services, ConnectionService),
            chat: Context.get(services, ChatService),
            providers: Context.get(services, ProviderSetupService),
            folders: Context.get(services, LocalHostService),
            workspace: Context.get(services, WorkspaceHostService),
          } satisfies Bound;
        });
      /** One attempt: the daemon found or started, the clients bound, and connected. */
      const attempt = lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current._tag === 'Released') return yield* Effect.fail(quitting());
          // A replacement may have reconnected while this one waited.
          if (current._tag === 'Bound' && (yield* isReady(current))) return current.clients;
          yield* daemon.find;
          if (current._tag === 'Bound') {
            const connectedTo = yield* connectLoopback(current.clients);
            yield* Ref.update(state, (now) =>
              now._tag === 'Bound' ? { ...now, connectedTo } : now,
            );
            return current.clients;
          }
          // The first time, the clients are kept only once they connect; a failure closes them.
          const own = yield* Scope.fork(clients, 'sequential');
          return yield* Effect.gen(function* () {
            const bound = yield* bind(own);
            const connectedTo = yield* connectLoopback(bound);
            const kept = yield* Ref.modify(state, (now): readonly [boolean, ClientState] =>
              now._tag === 'Released'
                ? [false, now]
                : [true, { _tag: 'Bound', clients: bound, connectedTo }],
            );
            return kept ? bound : yield* Effect.fail(quitting());
          }).pipe(Effect.onError((cause) => Scope.close(own, Exit.failCause(cause))));
        }).pipe(
          Effect.tapError(({ message }) =>
            Effect.logError('The local daemon is unavailable:', message),
          ),
        ),
      );
      const current = yield* SynchronizedRef.make<Attempt>({ _tag: 'Idle' });
      /**
       * Ends the attempt running on this fiber: its failure is kept, at the time on the clock of the
       * caller that started it. One interrupted (by Quit) keeps nothing.
       */
      const settle = (exit: Exit.Exit<Bound, AttemptError>) =>
        Effect.withFiber((fiber) =>
          Effect.flatMap(Clock.currentTimeMillis, (at) =>
            SynchronizedRef.update(current, (now): Attempt => {
              if (now._tag !== 'Running' || now.fiber !== fiber) return now;
              const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
              return error?._tag === 'Some'
                ? { _tag: 'Failed', error: error.value, at }
                : { _tag: 'Idle' };
            }),
          ),
        );
      /** Waits for an attempt; one the layer's close interrupted, or never started, is Quit's. */
      const join = (fiber: Fiber.Fiber<Bound, AttemptError>) =>
        Effect.flatMap(Fiber.await(fiber), (exit) =>
          Exit.hasInterrupts(exit) ? Effect.fail(quitting()) : exit,
        );
      /**
       * The attempt under way, joined, or else the failure kept from the last one, or else a new
       * attempt, decided in one step. It runs in the layer's attempts, so callers that stop waiting
       * leave it running, and the layer's close interrupts it.
       */
      const shared = Effect.flatten(
        SynchronizedRef.modifyEffect(current, (now) =>
          Effect.gen(function* () {
            if (now._tag === 'Running') return [join(now.fiber), now] as const;
            if (now._tag === 'Failed') {
              const since = (yield* Clock.currentTimeMillis) - now.at;
              if (since >= 0 && since < daemonRetryAfterMs)
                return [Effect.fail(now.error), now] as const;
            }
            const fiber = yield* FiberSet.run(
              attempts,
              Effect.onExit(onSystemClock(attempt), settle),
            );
            return [join(fiber), { _tag: 'Running', fiber } satisfies Attempt] as const;
          }),
        ),
      );
      /** Drops a failure kept from the last attempt; one under way is still joined. */
      const forget = SynchronizedRef.update(current, (now): Attempt =>
        now._tag === 'Failed' ? { _tag: 'Idle' } : now,
      );
      // Added after the clients' scope and the attempts, so it runs first as the scope closes:
      // from then on no caller reaches the clients being released.
      yield* Effect.addFinalizer(() => Ref.set(state, { _tag: 'Released' }));

      /** The bound clients, connected to a running daemon: at once if they are, else by an attempt. */
      const ready = Effect.flatMap(Ref.get(state), (current) => {
        if (current._tag === 'Released') return Effect.fail(quitting());
        if (current._tag === 'Unbound') return shared;
        return Effect.flatMap(isReady(current), (ready) =>
          ready ? Effect.succeed(current.clients) : shared,
        );
      });
      /** The loopback connection whose endpoint lookups, before each request, reach the daemon. */
      function reaching(loopback: ConnectionServiceShape): ConnectionServiceShape {
        return {
          ...loopback,
          // The attempt's own failure, as the old connection gave it: the daemon's reason, or the
          // loopback connection's error with its code.
          endpoint: (input) =>
            Effect.andThen(
              Effect.mapError(ready, (error) =>
                error._tag === 'LocalDaemonError' ? toDaemonApplicationError(error) : error,
              ),
              loopback.endpoint(input),
            ),
        };
      }
      const connect = Effect.flatMap(
        Effect.mapError(ready, toCallerError),
        ({ loopback, ...bound }) =>
          loopback.endpoint({ host: bound.session.host }).pipe(
            Effect.map((endpoint) => ({ ...bound, endpoint })),
            Effect.mapError(unreachable),
          ),
      );

      // Asking keeps the outdated daemon from idling out, so it is replaced rather than left.
      const replaceOnceIdle = Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current._tag !== 'Bound' || !(yield* daemon.isOutdated) || !(yield* daemon.isRunning))
          return;
        const { clients: bound } = current;
        const { active } = yield* bound.folders.getActiveWork({ host: bound.session.host });
        if (active)
          return yield* Effect.logDebug('The outdated local daemon has work; it is kept.');
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (!(yield* daemon.isOutdated)) return;
            yield* daemon.replace;
            const connectedTo = yield* connectLoopback(bound);
            yield* Ref.update(state, (now) =>
              now._tag === 'Bound' ? { ...now, connectedTo } : now,
            );
          }),
        );
      });
      yield* Effect.sleep(replaceMs).pipe(
        Effect.andThen(Effect.ignore(replaceOnceIdle)),
        Effect.forever,
        Effect.forkScoped,
      );

      return {
        get: Effect.flatMap(Ref.get(state), (current) => {
          if (current._tag === 'Bound') return Effect.succeed(current.clients);
          return current._tag === 'Released'
            ? Effect.fail(quitting())
            : Effect.mapError(shared, toCallerError);
        }),
        peek: Effect.map(Ref.get(state), (current) =>
          current._tag === 'Bound' ? current.clients : undefined,
        ),
        connect,
        isRunning: daemon.isRunning,
        session: readDaemonSession(directory),
        // The user asked for a daemon now, so a failure kept from before the stop isn't the answer.
        restart: lock
          .withPermits(1)(daemon.stop)
          .pipe(Effect.andThen(forget), Effect.andThen(connect)),
      };
    }),
  );
