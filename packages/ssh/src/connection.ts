import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Option,
  Ref,
  Schedule,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { randomUUID } from 'node:crypto';
import { CancelledError } from '@moonbase/contracts/errors';
import {
  ConnectionError,
  type ConnectionErrorReason,
  type HostVerificationError,
  type HostVerificationReason,
} from '@moonbase/contracts/connection-errors';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import type { ChatHostHealth } from '@moonbase/contracts/host';
import {
  ConnectionService,
  type ChatHostEndpoint,
  type ConnectionServiceShape,
} from '@moonbase/contracts/services';
import {
  defaultSshStopTiming,
  startSshProcess,
  type SshProcess,
  type SshStopTiming,
} from './process.ts';
import { refusedPolicy, sshOptions } from './ssh-policy.ts';
import { reserveLoopbackPort } from './loopback-port.ts';
import { defaultSshExecutable, type SshConfiguration } from './configuration.ts';

/** What an SSH connection fails with. */
type SshFailure = ConnectionError | HostVerificationError | CancelledError;
const error = (reason: ConnectionErrorReason) => new ConnectionError({ reason });
// While the forward comes up, its health route may not answer or may drop its reply.
const retriedVerification = new Set<HostVerificationReason>(['unreachable', 'read-failed']);
const verificationPause = '50 millis';
const maximumObservers = 64;
const cancelled = () => new CancelledError({ operation: 'SSH connection' });

/** One connection attempt and what it started. A connect after it ended starts the next. */
type Generation = {
  readonly id: string;
  /** Owns the generation's processes; closed once they are stopped. */
  readonly scope: Scope.Closeable;
  /** Settles every Connect that waits on this generation. */
  readonly ready: Deferred.Deferred<ConnectionSnapshot, SshFailure>;
  /** What the generation started, stopped again by a release after one that failed. */
  readonly processes: SshProcess[];
};
/** A verified forward: the only source of the privileged endpoint. */
type Verified = {
  readonly origin: string;
  readonly health: ChatHostHealth;
  readonly forward: SshProcess;
};
/** What a Connect found: a generation to wait on, or why it may not start one. */
type Admission =
  | { readonly generation: Generation; readonly verified?: Verified }
  | { readonly refused: 'releasing' };
type ConnectionState = {
  readonly snapshot: ConnectionSnapshot;
  /** The generation being started, connected, or released; at most one at a time. */
  readonly generation?: Generation;
  readonly verified?: Verified;
};

export type SshOptions = {
  /**
   * Checks the chat host's signed health on the forwarded port. The consumer supplies the
   * protocol's check (`checkHostHealth` from `@moonbase/daemon-protocol/health`); SSH only
   * forwards the port. A health route that can't be reached (`unreachable`) or read
   * (`read-failed`) is retried until the startup deadline; any other failure ends the attempt.
   */
  verify: (endpoint: ChatHostEndpoint) => Effect.Effect<ChatHostHealth, HostVerificationError>;
  /** How long a connection may take to verify its host; 20 seconds unless a test shortens it. */
  startupMs?: number;
  /** How long stopping an owned process group may take; tests shorten it. */
  stopTiming?: Partial<SshStopTiming>;
};

/**
 * Root-scoped capability only. The consumer composes the process runtime and shared handlers, and
 * decodes the configuration where it reads it (`decodeSshConfiguration`). The connection's state
 * is a `SubscriptionRef` (`watch` is its changes), each attempt a fiber in a `FiberMap` keyed by
 * its generation, and each generation a child Scope of the layer's.
 */
export function SshLive(input: SshConfiguration, options: SshOptions) {
  return Layer.effect(
    ConnectionService,
    Effect.gen(function* () {
      // Process groups are POSIX; on any other platform this layer is a defect, not an outcome.
      if (process.platform === 'win32') return yield* Effect.die(error('platform'));
      const config = { ...input, sshExecutable: input.sshExecutable ?? defaultSshExecutable },
        { profile, token } = config,
        startupMs = options.startupMs ?? 20_000,
        stopTiming = { ...defaultSshStopTiming, ...options.stopTiming };
      const scope = yield* Effect.scope;
      const attempts = yield* FiberMap.make<string, void, SshFailure>();
      const state = yield* SubscriptionRef.make<ConnectionState>({
        snapshot: { profile, state: 'disconnected', connectionId: null },
      });
      const observers = yield* Ref.make(0);

      const connecting = (g: Generation): ConnectionSnapshot => ({
        profile,
        state: 'connecting',
        connectionId: g.id,
      });
      const disconnecting = (g: Generation): ConnectionSnapshot => ({
        profile,
        state: 'disconnecting',
        connectionId: g.id,
      });
      const failed = (g: Generation, failure: SshFailure): ConnectionSnapshot => ({
        profile,
        state: 'failed',
        connectionId: g.id,
        message: failure.message,
      });
      /** Replaces the state while `g` is the current generation; whether it was. */
      const updateFor = (g: Generation, next: Omit<ConnectionState, 'generation'>) =>
        SubscriptionRef.modifySome(state, (s) =>
          s.generation === g
            ? [true, Option.some({ ...next, generation: g })]
            : [false, Option.none()],
        );

      /** Starts a process in `g`, recorded there before anything can interrupt. */
      const start = (g: Generation, args: string[], captureOutput: boolean) =>
        Effect.uninterruptible(
          Effect.tap(
            startSshProcess(config.sshExecutable, args, { token, captureOutput, stopTiming }),
            (child) => Effect.sync(() => g.processes.push(child)),
          ),
        );

      /** Checks the effective policy, forwards a fresh port and verifies the host through it. */
      const establish = (g: Generation): Effect.Effect<Verified, SshFailure, Scope.Scope> =>
        Effect.gen(function* () {
          if ((yield* SubscriptionRef.get(state)).generation !== g) return yield* cancelled();
          const preflight = yield* start(g, [...sshOptions, '-G', '--', profile.destination], true);
          const configured = yield* preflight.exit;
          yield* Effect.mapError(preflight.stop, () => error('cleanup-failed'));
          const { text, overflow } = yield* preflight.output;
          if (configured.spawnFailed || configured.code !== 0 || overflow)
            return yield* Effect.flatMap(preflight.failure, Effect.fail);
          const refused = refusedPolicy(text);
          yield* preflight.forget;
          if (refused) return yield* error(refused);
          const port = yield* reserveLoopbackPort;
          const origin = `http://127.0.0.1:${port}`;
          const forward = yield* start(
            g,
            [
              ...sshOptions,
              '-L',
              `127.0.0.1:${port}:127.0.0.1:${profile.remotePort}`,
              '--',
              profile.destination,
            ],
            false,
          );
          const verified = options.verify({ origin, token, expected: profile.expected }).pipe(
            Effect.retry({
              schedule: Schedule.spaced(verificationPause),
              while: (failure) => retriedVerification.has(failure.reason),
            }),
          );
          const exited = Effect.andThen(forward.exit, Effect.flatMap(forward.failure, Effect.fail));
          const health = yield* Effect.raceFirst(verified, exited);
          return { origin, health: structuredClone(health), forward };
        }).pipe(
          Effect.timeoutOrElse({
            duration: startupMs,
            orElse: () => Effect.fail(error('startup-deadline')),
          }),
        );

      /**
       * Ends `g`: publishes that it is going, stops its processes and closes its Scope, then
       * settles its Connects. A stop that fails (`teardown`) keeps `g` current, so Connect is
       * refused (`releasing`) until a later release succeeds.
       */
      const end = (g: Generation, failure?: SshFailure) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const outcome = failure ?? cancelled();
            const current = yield* updateFor(g, {
              snapshot: failure ? failed(g, failure) : disconnecting(g),
            });
            if (current) {
              const stops = yield* Effect.forEach(g.processes, (child) => Effect.exit(child.stop), {
                concurrency: 'unbounded',
              });
              const stopFailure = stops.find(Exit.isFailure);
              if (stopFailure) {
                yield* Deferred.failCause(
                  g.ready,
                  Cause.combine(Cause.fail(outcome), stopFailure.cause),
                );
                return yield* stopFailure;
              }
              yield* Scope.close(g.scope, Exit.void);
              yield* SubscriptionRef.modifySome(state, (s) =>
                s.generation === g
                  ? [
                      undefined,
                      Option.some({
                        // A Disconnect that arrived while a failed attempt cleaned up wins.
                        snapshot:
                          failure && s.snapshot.state !== 'disconnecting'
                            ? failed(g, failure)
                            : { profile, state: 'disconnected', connectionId: null },
                      }),
                    ]
                  : [undefined, Option.none()],
              );
            }
            yield* Deferred.fail(g.ready, outcome);
          }),
        );
      /** Ends `g` on request: interrupts its attempt, then releases what it started. */
      const release = (g: Generation) =>
        Effect.uninterruptible(Effect.andThen(FiberMap.remove(attempts, g.id), end(g)));

      /** One generation's attempt, from preflight until its forward exits. */
      const attempt = (g: Generation) =>
        Effect.gen(function* () {
          const verified = yield* establish(g);
          const snapshot: ConnectionSnapshot = {
            profile,
            state: 'connected',
            connectionId: g.id,
            health: verified.health,
          };
          yield* updateFor(g, { snapshot, verified });
          yield* Deferred.succeed(g.ready, structuredClone(snapshot));
          yield* verified.forward.exit;
          return yield* Effect.flatMap(verified.forward.failure, Effect.fail);
        }).pipe(
          Scope.provide(g.scope),
          // An attempt that ends on its own releases itself; a release that interrupts it ends it.
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
            // A cleanup defect is reported beside the attempt's own end, not in place of it.
            const failure = exit.cause.reasons.some(Cause.isDieReason)
              ? error('cleanup-failed')
              : (exit.cause.reasons.find(Cause.isFailReason)?.error ?? error('ended'));
            return end(g, failure);
          }),
        );

      const connect = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const candidate: Generation = {
            id: randomUUID(),
            scope: yield* Scope.fork(scope),
            ready: yield* Deferred.make<ConnectionSnapshot, SshFailure>(),
            processes: [],
          };
          const admitted = yield* SubscriptionRef.modifySome(
            state,
            (s): readonly [Admission, Option.Option<ConnectionState>] => {
              const g = s.generation;
              if (!g)
                return [
                  { generation: candidate },
                  Option.some({ snapshot: connecting(candidate), generation: candidate }),
                ] as const;
              if (s.snapshot.state !== 'connecting' && s.snapshot.state !== 'connected')
                return [{ refused: 'releasing' as const }, Option.none()] as const;
              return [{ generation: g, verified: s.verified }, Option.none()] as const;
            },
          );
          if ('refused' in admitted) {
            yield* Scope.close(candidate.scope, Exit.void);
            return yield* error(admitted.refused);
          }
          const g = admitted.generation;
          if (g === candidate)
            yield* FiberMap.run(attempts, g.id, attempt(g)).pipe(Effect.onInterrupt(() => end(g)));
          else {
            yield* Scope.close(candidate.scope, Exit.void);
            if (admitted.verified && !(yield* admitted.verified.forward.isRunning))
              return yield* error('generation-exited');
          }
          return yield* restore(Deferred.await(g.ready)).pipe(
            Effect.map((snapshot) => structuredClone(snapshot)),
            Effect.onInterrupt(() =>
              // Cancelling a Connect cancels the attempt it started or joined, while it connects.
              Effect.flatMap(
                SubscriptionRef.modifySome(state, (s) =>
                  s.generation === g && s.snapshot.state === 'connecting'
                    ? [true, Option.some({ ...s, snapshot: disconnecting(g) })]
                    : [false, Option.none()],
                ),
                (connectingStill) => (connectingStill ? release(g) : Effect.void),
              ),
            ),
          );
        }),
      );

      // Closing the connection releases its generation before the attempts and their Scopes close.
      yield* Effect.addFinalizer(() =>
        Effect.flatMap(SubscriptionRef.get(state), ({ generation }) =>
          generation ? Effect.orDie(release(generation)) : Effect.void,
        ),
      );

      const service: ConnectionServiceShape = {
        getConnection: () =>
          Effect.map(SubscriptionRef.get(state), (s) => structuredClone(s.snapshot)),
        connect: ({ profileId }) =>
          profileId === profile.id ? connect : Effect.fail(error('wrong-profile')),
        disconnect: ({ connectionId }) =>
          Effect.flatten(
            SubscriptionRef.modifySome(
              state,
              (s): readonly [Effect.Effect<void, SshFailure>, Option.Option<ConnectionState>] => {
                const g = s.generation;
                if (!g) return [Effect.void, Option.none()];
                if (g.id !== connectionId)
                  return [Effect.fail(error('stale-generation')), Option.none()];
                return [release(g), Option.some({ snapshot: disconnecting(g), generation: g })];
              },
            ),
          ),
        endpoint: ({ host }) =>
          Effect.gen(function* () {
            if (
              host.hostId !== profile.expected.hostId ||
              host.storeId !== profile.expected.storeId
            )
              return yield* error('host-mismatch');
            const { snapshot, generation, verified } = yield* SubscriptionRef.get(state);
            if (
              !generation ||
              !verified ||
              snapshot.state !== 'connected' ||
              !(yield* verified.forward.isRunning)
            )
              return yield* error('not-verified');
            return structuredClone({
              origin: verified.origin,
              token,
              expected: profile.expected,
              connectionId: generation.id,
              health: verified.health,
            });
          }),
        watch: () =>
          Stream.unwrap(
            Effect.as(
              Effect.acquireRelease(
                Effect.flatMap(
                  Ref.modify(observers, (count) =>
                    count >= maximumObservers ? [false, count] : [true, count + 1],
                  ),
                  (admitted) => (admitted ? Effect.void : Effect.fail(error('observer-limit'))),
                ),
                () => Ref.update(observers, (count) => count - 1),
              ),
              SubscriptionRef.changes(state).pipe(Stream.map((s) => structuredClone(s.snapshot))),
            ),
          ),
      };
      return service;
    }),
  );
}
