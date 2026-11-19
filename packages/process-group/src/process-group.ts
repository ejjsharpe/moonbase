import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Schedule,
  Semaphore,
  type Scope,
} from 'effect';
import { ProcessGroupError } from './process-group-error.ts';

/** How long output written before the leader exited has to arrive while another process holds a pipe. */
export const outputDrain = Duration.millis(100);

/**
 * How long stopping a group may take in all (`deadline`), and how long its processes have after
 * SIGTERM before SIGKILL (`termGrace`). `termGrace` is shorter than `deadline`: what is left is
 * SIGKILL's, and the wait for the group and its pipes.
 */
export type ProcessGroupStopTiming = {
  readonly deadline: Duration.Input;
  readonly termGrace: Duration.Input;
};

/** How the group leader ended: its exit code or signal, or that it never started. */
export type ProcessGroupExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnFailed: boolean;
  /** The errno code (such as `ENOENT`) of a spawn that failed. */
  readonly spawnErrorCode?: string;
};

/**
 * When closing the group's Scope stops it. `always`: unless the group was already seen gone.
 * `while-open`: while a pipe is open or the leader is unreaped, so a member still holding the
 * group's output is stopped after the leader exits. `never`: the owner stops it in a finalizer of
 * its own, added after the group, when it knows the group still needs stopping.
 */
export type ProcessGroupCloseStop = 'always' | 'while-open' | 'never';

export type ProcessGroupOptions = {
  readonly stdio: StdioOptions;
  readonly stopOnClose: ProcessGroupCloseStop;
  /** The leader's whole environment; the current process's when omitted. */
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stopTiming: ProcessGroupStopTiming;
};

/** A process started in its own group, owned by the Scope it was started in. */
export type ProcessGroup = {
  /** The leader, for its pipes. Its events and its group's signals belong to this module. */
  readonly process: ChildProcess;
  /** The leader's exit. A member of its group may still hold its pipes after it. */
  readonly exit: Effect.Effect<ProcessGroupExit>;
  readonly hasExited: Effect.Effect<boolean>;
  /** Every pipe closed after the leader exited: what it wrote has all arrived. */
  readonly closed: Effect.Effect<void>;
  /** Sends `signal` to the group, unless it was already seen gone. */
  readonly signal: (signal: NodeJS.Signals) => Effect.Effect<void>;
  /**
   * Stops the group (SIGTERM, then SIGKILL after `termGrace`) and waits until no member is left
   * and its pipes are closed, all within `deadline`. Only ESRCH confirms the group is gone: EPERM,
   * which Darwin can report for an exiting group, is signalled again until SIGKILL's turn, then
   * until the deadline. A stop that failed (`teardown`) is tried again by the next call. Once
   * ESRCH is seen, nothing signals the group ID again, since it may have been reused.
   */
  readonly stop: Effect.Effect<void, ProcessGroupError>;
};

/** Sends `signal` (0 only checks) to the group `groupId`, throwing `process.kill`'s errno errors. */
export type SignalGroup = (groupId: number, signal: NodeJS.Signals | 0) => void;

/** The system's group signal: `kill(-groupId, signal)`. */
export const signalSystemGroup: SignalGroup = (groupId, signal) => {
  process.kill(-groupId, signal);
};

type Delivery = 'sent' | 'gone' | 'denied';
const teardown = () => new ProcessGroupError({ reason: 'teardown' });
const poll = Schedule.spaced('10 millis');

/**
 * Runs `effect` on the system clock: its waits are on real processes, so they keep real time even
 * when the caller's clock is a TestClock.
 */
export const onSystemClock = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.updateContext(effect, (context: Context.Context<never>) =>
    Context.omit(Clock.Clock)(context),
  );

/** The group and what closing its Scope does. */
type OwnedGroup = { readonly group: ProcessGroup; readonly release: Effect.Effect<void> };

const acquireGroup = (
  signalGroup: SignalGroup,
  executable: string,
  args: readonly string[],
  { stdio, env, cwd, stopTiming, stopOnClose }: ProcessGroupOptions,
): Effect.Effect<OwnedGroup, ProcessGroupError> =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ProcessGroupExit>();
    const closed = yield* Deferred.make<void>();
    // ESRCH, once seen: the group is gone and its ID free for reuse, so it is never signalled again.
    const gone = yield* Deferred.make<void>();
    const stopping = yield* Semaphore.make(1);
    const child = yield* Effect.try({
      try: () => {
        // A new process group is still referenced and scoped; never unref'd or shared.
        const child = spawn(executable, [...args], {
          shell: false,
          detached: true,
          stdio,
          ...(env === undefined ? {} : { env }),
          ...(cwd === undefined ? {} : { cwd }),
        });
        let spawned = false;
        const end = (exit: ProcessGroupExit) => Deferred.doneUnsafe(exited, Exit.succeed(exit));
        child.once('spawn', () => {
          spawned = true;
        });
        child.once('exit', (code, signal) => end({ code, signal, spawnFailed: false }));
        // After the spawn, an error is a failed signal or pipe, which the stop reports itself.
        child.on('error', (error: NodeJS.ErrnoException) => {
          if (spawned) return;
          end({
            code: null,
            signal: null,
            spawnFailed: true,
            ...(error.code === undefined ? {} : { spawnErrorCode: error.code }),
          });
          Deferred.doneUnsafe(closed, Exit.void);
        });
        child.once('close', (code, signal) => {
          end({ code, signal, spawnFailed: !spawned });
          Deferred.doneUnsafe(closed, Exit.void);
        });
        // Raw pipe errors are private; the exit, the deadline and the stop stay observable.
        for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.on('error', () => {});
        return child;
      },
      catch: () => new ProcessGroupError({ reason: 'start' }),
    });
    const pid = child.pid;

    /** Signals the group unless it was seen gone, recording ESRCH in the same step that sees it. */
    const send = (signal: NodeJS.Signals | 0) =>
      Effect.try({
        try: (): Delivery => {
          if (pid === undefined || Deferred.isDoneUnsafe(gone)) return 'gone';
          try {
            signalGroup(pid, signal);
            return 'sent';
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ESRCH') {
              Deferred.doneUnsafe(gone, Exit.void);
              return 'gone';
            }
            // Darwin can report EPERM for an exiting group; only ESRCH confirms absence.
            if (code === 'EPERM') return 'denied';
            throw error;
          }
        },
        // Any failure but ESRCH or EPERM is a `teardown`, never inspected further.
        catch: teardown,
      });
    const endPipes = Effect.sync(() => {
      for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.destroy();
    });

    const stopGroup = Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const deadline = started + Duration.toMillis(stopTiming.deadline);
      // SIGTERM's turn ends here, however long EPERM lasts, so SIGKILL is always tried.
      const killAt = Math.min(started + Duration.toMillis(stopTiming.termGrace), deadline);
      const within = <A, E>(at: number, effect: Effect.Effect<A, E>) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.timeoutOption(effect, Math.max(0, at - now)),
        );
      /** Sends `signal` until it is delivered, at most until `at`; whether the group is gone. */
      const deliver = (signal: NodeJS.Signals, at: number) =>
        within(
          at,
          Effect.repeat(send(signal), { schedule: poll, while: (r) => r === 'denied' }),
        ).pipe(Effect.map((r) => Option.isSome(r) && r.value === 'gone'));
      /** Waits until the group is gone, at most until `at`; whether it is. */
      const confirmGone = (at: number) =>
        within(at, Effect.repeat(send(0), { schedule: poll, while: (r) => r !== 'gone' })).pipe(
          Effect.map(Option.isSome),
        );
      const pipesClosed = (at: number) =>
        Effect.map(within(at, Deferred.await(closed)), Option.isSome);
      // An exited leader does not release the rest of its group, even one with closed pipes.
      const stopped =
        (yield* send(0)) === 'gone' ||
        (yield* deliver('SIGTERM', killAt)) ||
        (yield* confirmGone(killAt)) ||
        (yield* deliver('SIGKILL', deadline)) ||
        (yield* confirmGone(deadline));
      if (!stopped) return yield* Effect.fail(teardown());
      // A process outside the group can hold a pipe open; once the group is gone, it is ended here.
      const drained = Math.min(
        (yield* Clock.currentTimeMillis) + Duration.toMillis(outputDrain),
        deadline,
      );
      if (!(yield* pipesClosed(drained))) {
        yield* endPipes;
        if (!(yield* pipesClosed(deadline))) return yield* Effect.fail(teardown());
      }
    }).pipe(onSystemClock);
    const stop = stopping.withPermits(1)(stopGroup);

    /**
     * Closing the Scope stops the group when `stopOnClose` asks for it, then ends the pipes. It
     * stays bounded by the stop's deadline: a stop that fails here is not retried or waited out,
     * so a caller's own failure (such as an explicit `stop`'s `teardown`) is what its Scope ends
     * with. An owner that must keep what the group holds until its leader exits waits for that
     * itself (`never`).
     */
    const stopsOnClose = Effect.map(Deferred.isDone(closed), (done) => {
      if (stopOnClose === 'while-open') return !done;
      return stopOnClose === 'always';
    });
    const release = Effect.andThen(
      Effect.flatMap(stopsOnClose, (stops) => (stops ? Effect.ignore(stop) : Effect.void)),
      endPipes,
    );

    const group: ProcessGroup = {
      process: child,
      exit: Deferred.await(exited),
      hasExited: Deferred.isDone(exited),
      closed: Deferred.await(closed),
      signal: (signal) => Effect.ignore(send(signal)),
      stop,
    };
    return { group, release };
  });

/**
 * Starts `executable` in its own process group, signalled through `signalGroup`, so stopping it
 * reaches every process it started in the group. The stop belongs to the acquired group, so a
 * Scope that is already closed stops it at once.
 */
export const startProcessGroup = (
  signalGroup: SignalGroup,
  executable: string,
  args: readonly string[],
  options: ProcessGroupOptions,
): Effect.Effect<ProcessGroup, ProcessGroupError, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(
      acquireGroup(signalGroup, executable, args, options),
      (owned) => owned.release,
    ),
    (owned) => owned.group,
  );
