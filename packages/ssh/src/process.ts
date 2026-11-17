import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Ref,
  Schedule,
  Semaphore,
  Stream,
  type Scope,
} from 'effect';
import { ConnectionError, type ConnectionErrorReason } from '@moonbase/contracts/connection-errors';

const failure = (reason: ConnectionErrorReason) => new ConnectionError({ reason });
/**
 * How long stopping a process group may take in all (`deadlineMs`), and how long its processes
 * have after SIGTERM before SIGKILL (`termGraceMs`).
 */
export type SshStopTiming = { deadlineMs: number; termGraceMs: number };
export const defaultSshStopTiming: SshStopTiming = { deadlineMs: 2500, termGraceMs: 500 };
/** How the group leader ended: its exit code or signal, or that it never started. */
export type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnFailed: boolean;
};
/** How much stdout a captured run keeps, and how much of stderr's tail is kept to classify it. */
const outputLimit = 64 * 1024;
const stderrLimit = 8192;
/** How long output written before the leader exited has to arrive while another process holds a pipe. */
const outputDrainMs = 100;

/** One OpenSSH process group, owned by the Scope it was started in. */
export type SshProcess = {
  /** The leader's exit. A helper in its group may still hold its pipes after it. */
  readonly exit: Effect.Effect<ProcessExit>;
  readonly isRunning: Effect.Effect<boolean>;
  /** Captured stdout, and whether it passed its bound (which stops the process). */
  readonly output: Effect.Effect<{ text: string; overflow: boolean }>;
  /** Clears the captured output and stderr once they have been checked. */
  readonly forget: Effect.Effect<void>;
  /** What the process's end means, from its exit and stderr; never quotes either. */
  readonly failure: Effect.Effect<ConnectionError>;
  /**
   * Stops the group (SIGTERM, then SIGKILL after `termGraceMs`) and waits until no member is
   * left and its pipes are closed, all within `deadlineMs`. Only ESRCH confirms the group is gone.
   * A stop that failed (`teardown`) is tried again by the next call; one that succeeded is final,
   * so a reused group ID is never signalled.
   */
  readonly stop: Effect.Effect<void, ConnectionError>;
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
    catch: () => failure('teardown'),
  });

/**
 * Runs `effect` on the system clock: its waits are on real processes, so they keep real time even
 * when the caller's clock is a TestClock.
 */
const onSystemClock = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.updateContext(effect, (context: Context.Context<never>) =>
    Context.omit(Clock.Clock)(context),
  );

/** A pipe's chunks until it ends or closes. */
const readPipe = (pipe: Readable) =>
  Stream.callback<Buffer>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const data = (chunk: Buffer) => Queue.offerUnsafe(queue, chunk);
        const end = () => Queue.endUnsafe(queue);
        pipe.on('data', data).once('end', end).once('close', end);
        return { data, end };
      }),
      ({ data, end }) =>
        Effect.sync(() => {
          pipe.off('data', data).off('end', end).off('close', end);
        }),
    ),
  );

const environment = (token: string) =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !entry[1].includes(token),
    ),
  );

/**
 * Starts `executable` in its own process group, inheriting no variable that contains `token`.
 * Node's `child_process` is wrapped here, once, rather than run through `effect/process`: the
 * group stop needs what its spawner doesn't do (keep signalling through EPERM until the deadline,
 * fail when the group's absence stays unconfirmed, end held pipes) and its own release would
 * signal the group ID again after it was confirmed gone. The process lives in the current Scope,
 * whose close stops it.
 */
export const startSshProcess = (
  executable: string,
  args: string[],
  {
    token,
    captureOutput,
    stopTiming,
  }: { token: string; captureOutput: boolean; stopTiming: SshStopTiming },
): Effect.Effect<SshProcess, ConnectionError, Scope.Scope> =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<ProcessExit>();
    // Every pipe closed after the leader exited: what it wrote has all arrived.
    const drained = yield* Deferred.make<void>();
    const stdout = yield* Ref.make({ chunks: [] as Buffer[], bytes: 0, overflow: false });
    const stderr = yield* Ref.make('');
    const stopping = yield* Semaphore.make(1);
    const stopped = yield* Deferred.make<void>();
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          // A new process group is still referenced and scoped; never unref'd or shared.
          const child = spawn(executable, args, {
            shell: false,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: environment(token),
          });
          let spawned = false;
          const end = (code: number | null, signal: NodeJS.Signals | null, spawnFailed = false) =>
            Deferred.doneUnsafe(exited, Exit.succeed({ code, signal, spawnFailed }));
          child.once('spawn', () => {
            spawned = true;
          });
          child.once('exit', (code, signal) => end(code, signal));
          child.on('error', () => {
            if (!spawned) end(null, null, true);
          });
          child.once('close', (code, signal) => {
            end(code, signal, !spawned);
            Deferred.doneUnsafe(drained, Exit.void);
          });
          // Raw pipe errors are private; the exit, the deadline and the stop stay observable.
          child.stdout!.on('error', () => {});
          child.stderr!.on('error', () => {});
          return child;
        },
        catch: () => failure('process-start'),
      }),
      () => Effect.ignore(stop),
    );
    const pid = child.pid;

    const stopGroup = Effect.gen(function* () {
      const { deadlineMs, termGraceMs } = stopTiming;
      const deadline = (yield* Clock.currentTimeMillis) + deadlineMs;
      const remaining = Effect.map(Clock.currentTimeMillis, (now) => Math.max(0, deadline - now));
      const send = (signal: NodeJS.Signals) =>
        Effect.flatMap(remaining, (left) =>
          signalGroup(pid, signal).pipe(
            Effect.repeat({ schedule: Schedule.spaced('10 millis'), while: (r) => r === 'denied' }),
            Effect.timeoutOrElse({
              duration: left,
              orElse: () => Effect.fail(failure('teardown')),
            }),
          ),
        );
      const gone = (limit: number) =>
        signalGroup(pid, 0).pipe(
          Effect.repeat({ schedule: Schedule.spaced('10 millis'), while: (r) => r !== 'gone' }),
          Effect.timeoutOption(limit),
          Effect.map(Option.isSome),
        );
      const closed = (limit: number) =>
        Deferred.await(drained).pipe(Effect.timeoutOption(limit), Effect.map(Option.isSome));
      // An exited leader does not release its proxy or helper group, even one with closed pipes.
      if ((yield* signalGroup(pid, 0)) !== 'gone') {
        yield* send('SIGTERM');
        if (!(yield* gone(Math.min(termGraceMs, yield* remaining)))) {
          yield* send('SIGKILL');
          if (!(yield* gone(yield* remaining))) return yield* Effect.fail(failure('teardown'));
        }
      }
      if (!(yield* closed(Math.min(outputDrainMs, yield* remaining)))) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (!(yield* closed(yield* remaining))) return yield* Effect.fail(failure('teardown'));
      }
    }).pipe(onSystemClock);
    const stop: Effect.Effect<void, ConnectionError> = stopping.withPermits(1)(
      Effect.flatMap(Deferred.isDone(stopped), (done) =>
        done ? Effect.void : Effect.andThen(stopGroup, Deferred.succeed(stopped, undefined)),
      ),
    );

    const stderrRead = yield* readPipe(child.stderr!).pipe(
      Stream.runForEach((chunk) =>
        Ref.update(stderr, (tail) => (tail + chunk.toString('utf8')).slice(-stderrLimit)),
      ),
      Effect.forkScoped,
    );
    yield* readPipe(child.stdout!).pipe(
      Stream.runForEach((chunk) =>
        captureOutput
          ? Effect.flatMap(
              Ref.modify(stdout, (captured) => {
                if (captured.overflow) return [false, captured];
                const bytes = captured.bytes + chunk.byteLength;
                if (bytes > outputLimit) return [true, { ...captured, bytes, overflow: true }];
                return [false, { chunks: [...captured.chunks, chunk], bytes, overflow: false }];
              }),
              // Past its bound the process is stopped; its owner reports the overflow.
              (overflowed) =>
                overflowed ? Effect.ignore(signalGroup(pid, 'SIGTERM')) : Effect.void,
            )
          : Effect.void,
      ),
      Effect.forkScoped,
    );

    const failed = Effect.gen(function* () {
      const exit = yield* Deferred.await(exited);
      if (exit.spawnFailed) return failure('spawn-failed');
      // Stderr written before the exit may still be arriving, unless a helper holds the pipe.
      yield* onSystemClock(Effect.timeoutOption(Fiber.await(stderrRead), outputDrainMs));
      const diagnostic = yield* Ref.get(stderr);
      if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key verification failed/i.test(diagnostic))
        return failure('host-key');
      if (
        /address already in use|cannot listen to port|could not request local forwarding/i.test(
          diagnostic,
        )
      )
        return failure('forward-bind');
      if (/permission denied|authentication failed/i.test(diagnostic))
        return failure('authentication');
      if ((yield* Ref.get(stdout)).overflow) return failure('output-overflow');
      return failure('exited');
    });

    return {
      exit: Deferred.await(exited),
      isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
      output: Effect.map(Ref.get(stdout), ({ chunks, overflow }) => ({
        text: Buffer.concat(chunks).toString('utf8'),
        overflow,
      })),
      forget: Effect.andThen(
        Ref.update(stdout, (captured) => ({ ...captured, chunks: [] })),
        Ref.set(stderr, ''),
      ),
      failure: failed,
      stop,
    };
  });
