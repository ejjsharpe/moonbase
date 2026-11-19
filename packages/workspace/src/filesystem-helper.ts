import { type Cause, Duration, Effect, Option, Queue, Stream } from 'effect';
import { outputDrain, spawnProcessGroup, type ProcessGroupExit } from '@moonbase/process-group';
import { HelperFailure } from './system-failures.ts';

/** How much stdout a run buffers, or one streamed line holds, before the run is stopped. */
const outputLimit = 16 * 1024 * 1024;
/** How long a run may take before it is stopped. */
const runLimit = Duration.seconds(30);
/** A stopped helper's group has 2 s after SIGTERM before SIGKILL, and 4 s in all to be gone. */
const stopTiming = { termGrace: Duration.seconds(2), deadline: Duration.seconds(4) };
const stderrLimit = 4096;

/** What a helper run is given: the checkout root as fd 3, then `extra` descriptors. */
export type HelperOptions = {
  readonly fd: number;
  readonly input?: string;
  readonly extra?: readonly number[];
  /** Overrides for the helper's environment; `undefined` removes a variable. */
  readonly env?: Record<string, string | undefined>;
};

/** The filesystem helper. Interrupting a run stops its process group and waits for it to exit. */
export type FilesystemHelper = {
  /** Runs the helper to its end and returns its stdout. */
  run(args: string[], options: HelperOptions): Effect.Effect<Buffer, HelperFailure>;
  /**
   * Runs the helper and streams the lines of its stdout as they arrive. A consumer that stops
   * early (as with `Stream.takeWhile`) stops the helper, and the run then ends cleanly.
   */
  lines(args: string[], options: HelperOptions): Stream.Stream<string, HelperFailure>;
};

const helperEnvironment = (overrides: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    ...overrides,
  };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  return env;
};
/**
 * Starts the helper in its own process group, so stopping it reaches Git's children (checkout,
 * hooks, filters) as Ctrl-C would and Git can remove what it half-created. Closing the run's scope
 * stops the group and waits for it to exit, so the descriptors it holds and the checkout stay
 * owned until then.
 */
const startHelper = (helper: string, args: string[], options: HelperOptions) =>
  Effect.gen(function* () {
    const output = yield* Queue.unbounded<Buffer, HelperFailure | Cause.Done>();
    const group = yield* spawnProcessGroup(helper, args, {
      stdio: ['pipe', 'pipe', 'pipe', options.fd, ...(options.extra ?? [])],
      env: helperEnvironment(options.env),
      stopTiming,
    }).pipe(
      Effect.mapError(
        () =>
          new HelperFailure({
            message: 'Filesystem helper unavailable.',
            status: null,
            stderr: '',
            uncertain: false,
            output: Buffer.alloc(0),
          }),
      ),
    );
    const child = group.process;
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(0, stderrLimit);
    });
    child.stdin!.end(options.input);
    // Read from the start: output is never left for a reader that arrives late.
    const end = () => Queue.endUnsafe(output);
    child.stdout!.on('data', (chunk: Buffer) => Queue.offerUnsafe(output, chunk));
    child.stdout!.once('end', end).once('error', end);
    const stdout = Stream.fromQueue(output);
    /** SIGTERM to the group, SIGKILL after its grace, then waits for the helper's exit. */
    const stop = Effect.ignore(group.stop);
    // The group is stopped before its pipes are let go, so a running helper is never cut off by
    // a closed pipe.
    yield* Effect.addFinalizer(() =>
      Effect.andThen(
        stop,
        Effect.sync(() => {
          child.stdout!.destroy();
          child.stderr!.destroy();
          Queue.shutdownUnsafe(output);
        }),
      ),
    );
    const failure = (
      { code, signal, spawnFailed }: ProcessGroupExit,
      output: Buffer,
      capped: boolean,
    ) =>
      new HelperFailure({
        message:
          stderr ||
          (capped
            ? 'Filesystem output/time limit reached; refine request.'
            : 'Filesystem helper unavailable.'),
        status: spawnFailed ? null : code,
        stderr,
        uncertain: !spawnFailed && (!!signal || capped),
        output,
      });
    /**
     * Waits for the helper's exit and its last output, which pipes another process holds may
     * never deliver in full.
     */
    const awaitExit = Effect.tap(group.exit, () =>
      Effect.raceFirst(group.closed, Effect.sleep(outputDrain)),
    );
    /** The run's outcome once the helper exited: its output, or what went wrong. */
    const outcome = (output: Buffer) =>
      Effect.flatMap(awaitExit, (status) =>
        status.code === 0 && !status.spawnFailed
          ? Effect.succeed(output)
          : Effect.fail(failure(status, output, false)),
      );
    /** Stops a run at its output or time limit; it fails as uncertain. */
    const stopCapped = (output: Buffer) =>
      Effect.flatMap(Effect.andThen(stop, awaitExit), (status) =>
        Effect.fail(failure(status, output, true)),
      );
    // A process the helper started outside its group (a hook's daemon, say) can hold stdout
    // open long after the helper exits, so its output ends once the helper has exited and its
    // last output has had a moment to arrive, not when every holder of the pipe lets go.
    yield* Effect.forkScoped(
      Effect.delay(group.exit, outputDrain).pipe(Effect.andThen(Queue.end(output))),
    );
    /** Stops a streamed run at its time limit; its output then fails. */
    const limitOutput = Effect.sleep(runLimit).pipe(
      Effect.andThen(Effect.flip(stopCapped(Buffer.alloc(0)))),
      Effect.flatMap((failure) => Queue.fail(output, failure)),
    );
    return { stdout, exited: group.exit, outcome, stopCapped, limitOutput };
  });

/** Runs the filesystem helper at `helper`. */
export const makeFilesystemHelper = (helper: string): FilesystemHelper => ({
  run: (args, options) =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* startHelper(helper, args, options);
        const chunks: Buffer[] = [];
        let length = 0,
          capped = false;
        const read = Stream.runForEachWhile(started.stdout, (chunk) =>
          Effect.sync(() => {
            if (length + chunk.length > outputLimit) return !(capped = true);
            chunks.push(chunk);
            length += chunk.length;
            return true;
          }),
        );
        const finished = yield* Effect.timeoutOption(
          Effect.andThen(read, started.exited),
          runLimit,
        );
        const output = Buffer.concat(chunks, length);
        if (capped || Option.isNone(finished)) return yield* started.stopCapped(output);
        return yield* started.outcome(output);
      }),
    ),
  lines: (args, options) =>
    Stream.unwrap(
      Effect.tap(startHelper(helper, args, options), (started) =>
        Effect.forkScoped(started.limitOutput),
      ).pipe(
        Effect.map((started) => {
          const empty = Buffer.alloc(0);
          // Bytes since the last newline: a line past the limit stops the run.
          let pending = 0;
          return started.stdout.pipe(
            Stream.mapEffect((chunk) => {
              const end = chunk.lastIndexOf(10);
              pending = end < 0 ? pending + chunk.length : chunk.length - end - 1;
              return pending > outputLimit ? started.stopCapped(empty) : Effect.succeed(chunk);
            }),
            Stream.decodeText(),
            Stream.splitLines,
            Stream.concat(Stream.fromEffectDrain(started.outcome(empty))),
          );
        }),
      ),
    ),
});
