import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Effect, Fiber, FiberSet, Layer, Ref, Semaphore, Stream, SubscriptionRef } from 'effect';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import type { ChatHostHealth } from '@moonbase/contracts/host';
import { ConnectionService, type ConnectionServiceShape } from '@moonbase/contracts/services';
import { ConnectionError, type ConnectionFailure } from '@moonbase/contracts/connection-errors';
import { isSameChatHost } from '@moonbase/contracts/chat-validation';
import { checkHostHealth } from '../health.ts';
import { readDaemonFiles, readDaemonIdentity } from './loopback-files.ts';

export type LoopbackConnectionConfiguration = {
  /** The absolute data directory of a daemon on this machine. */
  directory: string;
  /** The connection's label; "This Mac" by default. */
  label?: string;
};

/** The connection's only profile. */
export const loopbackProfileId = 'loopback';
const maximumObservers = 64;

const failure = (reason: ConnectionError['reason']) => new ConnectionError({ reason });

/** A verified connection to one daemon process, which its endpoint's `pid` names. */
type Generation = {
  id: string;
  origin: string;
  pid: number;
  token: string;
  health: ChatHostHealth;
};

/**
 * A privileged `ConnectionService` for a daemon on this machine. It is built from the daemon's
 * `identity.json` alone and starts disconnected, so it builds while the daemon is stopped; each
 * connect reads `identity.json`, `endpoint.json` and `token` from its data directory, then verifies signed
 * health for that exact host and store. A connect that finds the same daemon process (port and
 * `pid` in `endpoint.json`) keeps the current generation; one that finds it restarted or replaced,
 * even on the same port, starts a new generation. The token never
 * leaves this service's endpoint lookup, so keep it out of renderers.
 */
export function LoopbackConnectionLive(
  config: LoopbackConnectionConfiguration,
): Layer.Layer<ConnectionService, ConnectionError> {
  return Layer.effect(
    ConnectionService,
    Effect.gen(function* () {
      if (typeof config.directory !== 'string' || !isAbsolute(config.directory))
        return yield* Effect.fail(failure('data-directory'));
      const label = config.label ?? 'This Mac';
      // oxlint-disable-next-line no-control-regex -- Labels reject control characters.
      if (typeof label !== 'string' || !/^[^\x00-\x1f\x7f]{1,128}$/.test(label))
        return yield* Effect.fail(failure('label'));
      // The expected identity is the directory's at startup; a different one later is refused.
      const expected = yield* readDaemonIdentity(config.directory);
      const state = yield* SubscriptionRef.make<ConnectionSnapshot>({
        profile: { id: loopbackProfileId, label, destination: '127.0.0.1', expected },
        state: 'disconnected',
        connectionId: null,
      });
      /** The verified generation; set only together with a `connected` state, under `lock`. */
      const current = yield* Ref.make<Generation | undefined>(undefined);
      const lock = yield* Semaphore.make(1);
      const observers = yield* Ref.make(0);
      // Closing the connection forgets the verified endpoint, so its token is never handed out.
      yield* Effect.addFinalizer(() => lock.withPermits(1)(Ref.set(current, undefined)));
      // Connects run in the layer's scope: closing it interrupts them before the endpoint is
      // forgotten, and one started after it is refused, so the token is never handed out again.
      const connects = yield* FiberSet.make<ConnectionSnapshot, ConnectionFailure>();
      const verify = (origin: string, token: string) =>
        checkHostHealth({ origin, token, expected });
      const connect = Effect.gen(function* () {
        const { profile } = yield* SubscriptionRef.get(state);
        const files = yield* readDaemonFiles(config.directory).pipe(
          Effect.filterOrFail(
            (files) => isSameChatHost(files.expected, expected),
            () => failure('daemon-identity'),
          ),
          Effect.tapError((error) =>
            Effect.andThen(
              Ref.set(current, undefined),
              SubscriptionRef.set(state, {
                profile,
                state: 'failed',
                connectionId: null,
                message: error.message,
              }),
            ),
          ),
        );
        const reuse = yield* Ref.get(current);
        // The token outlives a restart and the port can repeat, so the process tells daemons apart.
        if (
          reuse &&
          reuse.origin === files.origin &&
          reuse.pid === files.pid &&
          reuse.token === files.token
        ) {
          const healthy = yield* Effect.result(verify(reuse.origin, reuse.token));
          const snapshot = yield* SubscriptionRef.get(state);
          if (
            healthy._tag === 'Success' &&
            (yield* Ref.get(current)) === reuse &&
            snapshot.state === 'connected'
          )
            return structuredClone(snapshot);
        }
        const id = randomUUID(),
          next = { ...profile, remotePort: files.port };
        yield* Ref.set(current, undefined);
        yield* SubscriptionRef.set(state, { profile: next, state: 'connecting', connectionId: id });
        const health = yield* verify(files.origin, files.token).pipe(
          Effect.tapError((error) =>
            SubscriptionRef.set(state, {
              profile: next,
              state: 'failed',
              connectionId: id,
              message: error.message,
            }),
          ),
        );
        yield* Ref.set(current, {
          id,
          origin: files.origin,
          pid: files.pid,
          token: files.token,
          health,
        });
        const connected: ConnectionSnapshot = {
          profile: next,
          state: 'connected',
          connectionId: id,
          health,
        };
        yield* SubscriptionRef.set(state, connected);
        return structuredClone(connected);
      });
      const service: ConnectionServiceShape = {
        getConnection: () =>
          Effect.map(SubscriptionRef.get(state), (snapshot) => structuredClone(snapshot)),
        connect: ({ profileId }) =>
          profileId === loopbackProfileId
            ? Effect.flatMap(FiberSet.run(connects, lock.withPermits(1)(connect)), (fiber) =>
                Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber))),
              )
            : Effect.fail(failure('loopback-profile')),
        disconnect: ({ connectionId }) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const snapshot = yield* SubscriptionRef.get(state);
              if (snapshot.connectionId === null) return;
              if (snapshot.connectionId !== connectionId)
                return yield* Effect.fail(failure('stale-generation'));
              yield* Ref.set(current, undefined);
              yield* SubscriptionRef.set(state, {
                profile: snapshot.profile,
                state: 'disconnected',
                connectionId: null,
              });
            }),
          ),
        endpoint: ({ host }) =>
          Effect.gen(function* () {
            if (!isSameChatHost(host, expected))
              return yield* Effect.fail(failure('daemon-mismatch'));
            const generation = yield* Ref.get(current),
              snapshot = yield* SubscriptionRef.get(state);
            if (
              !generation ||
              snapshot.state !== 'connected' ||
              snapshot.connectionId !== generation.id
            )
              return yield* Effect.fail(failure('not-verified'));
            return structuredClone({
              origin: generation.origin,
              token: generation.token,
              expected,
              connectionId: generation.id,
              health: generation.health,
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
                  (admitted) => (admitted ? Effect.void : Effect.fail(failure('observer-limit'))),
                ),
                () => Ref.update(observers, (count) => count - 1),
              ),
              SubscriptionRef.changes(state).pipe(
                Stream.map((snapshot) => structuredClone(snapshot)),
              ),
            ),
          ),
      };
      return service;
    }),
  );
}
