import type { Readable } from 'node:stream';
import { Effect, Fiber, Queue, Ref, Stream, type Scope } from 'effect';
import { ConnectionError, type ConnectionErrorReason } from '@moonbase/contracts/connection-errors';
import {
  onSystemClock,
  outputDrain,
  ProcessGroups,
  type ProcessGroupExit,
} from '@moonbase/process-group';

const failure = (reason: ConnectionErrorReason) => new ConnectionError({ reason });
/**
 * How long stopping a process group may take in all (`deadlineMs`), and how long its processes
 * have after SIGTERM before SIGKILL (`termGraceMs`).
 */
export type SshStopTiming = { deadlineMs: number; termGraceMs: number };
export const defaultSshStopTiming: SshStopTiming = { deadlineMs: 2500, termGraceMs: 500 };
/** How the group leader ended: its exit code or signal, or that it never started. */
export type ProcessExit = ProcessGroupExit;
/** How much stdout a captured run keeps, and how much of stderr's tail is kept to classify it. */
const outputLimit = 64 * 1024;
const stderrLimit = 8192;

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
   * A stop that failed (`teardown`) is tried again by the next call; once ESRCH is seen, the group
   * ID is never signalled again.
   */
  readonly stop: Effect.Effect<void, ConnectionError>;
};

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
 * Starts `executable` in its own process group (`@moonbase/process-group`), inheriting no variable
 * that contains `token`. The process lives in the current Scope, whose close stops it.
 */
export const startSshProcess = (
  executable: string,
  args: string[],
  {
    token,
    captureOutput,
    stopTiming,
  }: { token: string; captureOutput: boolean; stopTiming: SshStopTiming },
): Effect.Effect<SshProcess, ConnectionError, Scope.Scope | ProcessGroups> =>
  Effect.gen(function* () {
    const groups = yield* ProcessGroups;
    const group = yield* groups
      .spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: environment(token),
        stopTiming: { deadline: stopTiming.deadlineMs, termGrace: stopTiming.termGraceMs },
      })
      .pipe(Effect.mapError(() => failure('process-start')));
    const child = group.process;
    const stdout = yield* Ref.make({ chunks: [] as Buffer[], bytes: 0, overflow: false });
    const stderr = yield* Ref.make('');
    const stop = Effect.mapError(group.stop, () => failure('teardown'));

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
              (overflowed) => (overflowed ? group.signal('SIGTERM') : Effect.void),
            )
          : Effect.void,
      ),
      Effect.forkScoped,
    );

    const failed = Effect.gen(function* () {
      const exit = yield* group.exit;
      if (exit.spawnFailed) return failure('spawn-failed');
      // Stderr written before the exit may still be arriving, unless a helper holds the pipe.
      yield* onSystemClock(Effect.timeoutOption(Fiber.await(stderrRead), outputDrain));
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
      exit: group.exit,
      isRunning: Effect.map(group.hasExited, (exited) => !exited),
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
