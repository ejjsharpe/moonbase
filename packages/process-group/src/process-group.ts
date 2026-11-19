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
 * SIGTERM before SIGKILL (`termGrace`).
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

export type ProcessGroupOptions = {
  readonly stdio: StdioOptions;
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
  /** Sends `signal` to the group, unless a stop already confirmed it gone. */
  readonly signal: (signal: NodeJS.Signals) => Effect.Effect<void>;
  /**
   * Stops the group (SIGTERM, then SIGKILL after `termGrace`) and waits until no member is left
   * and its pipes are closed, all within `deadline`. Only ESRCH confirms the group is gone: EPERM,
   * which Darwin can report for an exiting group, is signalled again until the deadline. A stop
   * that failed (`teardown`) is tried again by the next call; one that succeeded is final, so a
   * reused group ID is never signalled. Closing the Scope stops the group too.
   */
  readonly stop: Effect.Effect<void, ProcessGroupError>;
};

type Probe = 'sent' | 'gone' | 'denied';
/** Signals the whole group. Any failure but ESRCH or EPERM is a `teardown`, never inspected further. */
const signalGroup = (pid: number | undefined, signal: NodeJS.Signals | 0) =>
  Effect.try({
    try: (): Probe => {
      if (!pid) return 'gone';
      try {
        process.kill(-pid, signal);
        return 'sent';
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return 'gone';
        // Darwin can report EPERM for an exiting group; only ESRCH confirms absence.
        if (code === 'EPERM') return 'denied';
        throw error;
      }
    },
    catch: () => new ProcessGroupError({ reason: 'teardown' }),
  });

/**
 * Runs `effect` on the system clock: its waits are on real processes, so they keep real time even
 * when the caller's clock is a TestClock.
 */
export const onSystemClock = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.updateContext(effect, (context: Context.Context<never>) =>
    Context.omit(Clock.Clock)(context),
  );

/**
 * Starts `executable` in its own process group, so stopping it reaches every process it started in
 * the group. Node's `child_process` is wrapped here, once, rather than run through
 * `effect/process`: the group stop needs what its spawner doesn't do (signal the whole group, keep
 * signalling through EPERM until the deadline, fail when the group's absence stays unconfirmed, end
 * held pipes) and its own release would signal the group ID again after it was confirmed gone.
 */
export const spawnProcessGroup = (
  executable: string,
  args: readonly string[],
  { stdio, env, cwd, stopTiming }: ProcessGroupOptions,
): Effect.Effect<ProcessGroup, ProcessGroupError, Scope.Scope> =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ProcessGroupExit>();
    const closed = yield* Deferred.make<void>();
    const stopping = yield* Semaphore.make(1);
    const stopped = yield* Deferred.make<void>();
    const child = yield* Effect.acquireRelease(
      Effect.try({
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
      }),
      () => Effect.ignore(stop),
    );
    const pid = child.pid;
    const teardown = () => Effect.fail(new ProcessGroupError({ reason: 'teardown' }));

    const stopGroup = Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(stopTiming.deadline);
      const termGrace = Duration.toMillis(stopTiming.termGrace);
      const remaining = Effect.map(Clock.currentTimeMillis, (now) => Math.max(0, deadline - now));
      const send = (signal: NodeJS.Signals) =>
        Effect.flatMap(remaining, (left) =>
          signalGroup(pid, signal).pipe(
            Effect.repeat({ schedule: Schedule.spaced('10 millis'), while: (r) => r === 'denied' }),
            Effect.timeoutOrElse({ duration: left, orElse: teardown }),
          ),
        );
      const gone = (limit: number) =>
        signalGroup(pid, 0).pipe(
          Effect.repeat({ schedule: Schedule.spaced('10 millis'), while: (r) => r !== 'gone' }),
          Effect.timeoutOption(limit),
          Effect.map(Option.isSome),
        );
      const pipesClosed = (limit: number) =>
        Deferred.await(closed).pipe(Effect.timeoutOption(limit), Effect.map(Option.isSome));
      // An exited leader does not release the rest of its group, even one with closed pipes.
      if ((yield* signalGroup(pid, 0)) !== 'gone') {
        yield* send('SIGTERM');
        if (!(yield* gone(Math.min(termGrace, yield* remaining)))) {
          yield* send('SIGKILL');
          if (!(yield* gone(yield* remaining))) return yield* teardown();
        }
      }
      // A process outside the group can hold a pipe open; once the group is gone, it is ended here.
      if (!(yield* pipesClosed(Math.min(Duration.toMillis(outputDrain), yield* remaining)))) {
        for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.destroy();
        if (!(yield* pipesClosed(yield* remaining))) return yield* teardown();
      }
    }).pipe(onSystemClock);
    const stop: Effect.Effect<void, ProcessGroupError> = stopping.withPermits(1)(
      Effect.flatMap(Deferred.isDone(stopped), (done) =>
        done ? Effect.void : Effect.andThen(stopGroup, Deferred.succeed(stopped, undefined)),
      ),
    );

    return {
      process: child,
      exit: Deferred.await(exited),
      hasExited: Deferred.isDone(exited),
      closed: Deferred.await(closed),
      signal: (signal) =>
        Effect.flatMap(Deferred.isDone(stopped), (done) =>
          done ? Effect.void : Effect.ignore(signalGroup(pid, signal)),
        ),
      stop,
    };
  });
