import { Deferred, Effect, SubscriptionRef } from 'effect';
import { HostUnavailableError } from '@moonbase/contracts/host-errors';

/** Why a daemon stopped: told to (a signal, or its owner), or a local daemon left unused. */
export type DaemonExit = 'stopped' | 'idle';

/** Who is using the daemon now, and whether it has begun stopping. */
export type DaemonUse = { users: number; stopping?: DaemonExit };

/**
 * A daemon's uses and its stop. A use (a client's request, watch or workspace connection) is held
 * in a scope; once stopping, no new use is admitted. Only the first stop request takes effect;
 * its caller then completes `stopped`, which the daemon waits on. Each check and the change it
 * makes are one atomic step of `use`, so no use is admitted after the daemon chose to stop.
 */
export const makeDaemonStop = Effect.gen(function* () {
  const use = yield* SubscriptionRef.make<DaemonUse>({ users: 0 });
  const stopped = yield* Deferred.make<DaemonExit>();
  return {
    use,
    stopped,
    /** Holds one use until the scope closes, or refuses it once the daemon is stopping. */
    admit: Effect.acquireRelease(
      SubscriptionRef.modify(use, (state): [boolean, DaemonUse] =>
        state.stopping ? [false, state] : [true, { ...state, users: state.users + 1 }],
      ).pipe(
        Effect.flatMap((admitted) =>
          admitted ? Effect.void : Effect.fail(new HostUnavailableError({ reason: 'stopping' })),
        ),
      ),
      () => SubscriptionRef.update(use, (state) => ({ ...state, users: state.users - 1 })),
    ),
    /** Holds one use until the scope closes, admitted even while stopping. */
    hold: Effect.acquireRelease(
      SubscriptionRef.update(use, (state) => ({ ...state, users: state.users + 1 })),
      () => SubscriptionRef.update(use, (state) => ({ ...state, users: state.users - 1 })),
    ),
    /**
     * Stops the daemon for `reason` unless it is already stopping; with `unused`, only while
     * nothing uses it. Returns whether this request stopped it.
     */
    request: (reason: DaemonExit, { unused = false }: { unused?: boolean } = {}) =>
      SubscriptionRef.modify(use, (state): [boolean, DaemonUse] =>
        state.stopping || (unused && state.users > 0)
          ? [false, state]
          : [true, { ...state, stopping: reason }],
      ),
  };
});
export type DaemonStop = Effect.Success<typeof makeDaemonStop>;
