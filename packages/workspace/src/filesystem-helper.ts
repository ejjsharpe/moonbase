import { type Cause, Duration, Effect, Exit, Option, Queue, Stream } from 'effect';
import {
  outputDrain,
  type ProcessGroupExit,
  type ProcessGroupsShape,
} from '@moonbase/process-group';
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
 * hooks, filters) as Ctrl-C would and Git can remove what it half-created. Closing the scope of a
 * run that has not settled stops its group, so the descriptors the helper holds and the checkout
 * (its lease and journal) stay owned until then; one whose group can't be confirmed gone stays
 * owned until the helper itself has exited.
 */
const startHelper = (
  groups: ProcessGroupsShape,
  helper: string,
  args: string[],
  options: HelperOptions,
) =>
  Effect.gen(function* () {
    // Shut down after the group's release, which stops the helper before its pipes are let go.
    const output = yield* Effect.acquireRelease(
      Queue.unbounded<Buffer, HelperFailure | Cause.Done>(),
      Queue.shutdown,
    );
    const group = yield* groups
      .spawn(helper, args, {
        stdio: ['pipe', 'pipe', 'pipe', options.fd, ...(options.extra ?? [])],
        env: helperEnvironment(options.env),
        stopTiming,
        // This run's release, below, stops the group while the run is unsettled.
        stopOnClose: 'never',
      })
      .pipe(
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
    // Settled once the helper's exit and its last output are known.
    let settled = false;
    // Runs before the group's own release, which ends the pipes.
    yield* Effect.addFinalizer(() =>
      settled
        ? Effect.void
        : Effect.flatMap(Effect.exit(group.stop), (stopped) =>
            Exit.isSuccess(stopped) ? Effect.void : Effect.asVoid(group.exit),
          ),
    );
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
     * never deliver in full; the run has settled once it is known.
     */
    const awaitExit = Effect.tap(group.exit, () =>
      Effect.raceFirst(group.closed, Effect.sleep(outputDrain)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            settled = true;
          }),
        ),
      ),
    );
    /** The run's outcome once the helper exited: its output, or what went wrong. */
    const outcome = (output: Buffer) =>
      Effect.flatMap(awaitExit, (status) =>
        status.code === 0 && !status.spawnFailed
          ? Effect.succeed(output)
          : Effect.fail(failure(status, output, false)),
      );
    /**
     * Stops a run at its output or time limit; it fails as uncertain. A group that can't be
     * confirmed gone still keeps the run until the helper has exited.
     */
    const stopCapped = (output: Buffer) =>
      Effect.flatMap(Effect.andThen(Effect.exit(group.stop), awaitExit), (status) =>
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
export const makeFilesystemHelper = (
  helper: string,
  groups: ProcessGroupsShape,
): FilesystemHelper => ({
  run: (args, options) =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* startHelper(groups, helper, args, options);
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
      Effect.tap(startHelper(groups, helper, args, options), (started) =>
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
