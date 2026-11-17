import { spawn } from 'node:child_process';
import {
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Option,
  Schedule,
  type Duration,
} from 'effect';

/** How long a listing may run, and how long its stopped process group has after SIGTERM. */
export type ChatFileListingTiming = { budget: Duration.Input; stopGrace: Duration.Input };
export const defaultListingTiming: ChatFileListingTiming = {
  budget: '10 seconds',
  stopGrace: '2 seconds',
};
/** The most output one listing keeps; past it the listing is stopped and searched partially. */
const listingBytes = 32 * 1024 * 1024;

/** What a listing printed; `truncated` when its size or time budget stopped it partway. */
export type ListingOutput = { bytes: Buffer; truncated: boolean };
/**
 * A listing that did not finish: its command is missing, it exited with `status` (having printed
 * `output`), or it failed otherwise.
 */
export class ListingError extends Data.TaggedError('ListingError')<{
  reason: 'missing' | 'exited' | 'failed';
  status?: number;
  output: Buffer;
}> {
  override get message() {
    return this.reason === 'exited'
      ? `The file listing exited with ${this.status}`
      : `The file listing ${this.reason === 'missing' ? 'command is missing' : 'failed'}`;
  }
}
/** Runs one listing command in a folder; tests inject one. */
export type ChatFileListingRun = (
  executable: string,
  args: readonly string[],
  cwd: string,
) => Effect.Effect<ListingOutput, ListingError>;

type Ended = { code: number | null; error?: NodeJS.ErrnoException };

/** Whether any process of the group is left. EPERM is an exiting group: only ESRCH is gone. */
const isGroupAlive = (group: number) => {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const signalGroup = (group: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-group, signal);
  } catch {
    // The group already exited.
  }
};
/** Waits up to `limit` for the group to be gone; whether it is. */
const awaitGroupGone = (group: number, limit: Duration.Input) =>
  Effect.sync(() => isGroupAlive(group)).pipe(
    Effect.repeat({ schedule: Schedule.spaced('10 millis'), while: (alive) => alive }),
    Effect.timeoutOption(limit),
    Effect.map(Option.isSome),
  );
/**
 * Runs `effect` on the system clock: it waits on real processes, so it keeps real time even when
 * the caller's clock is a TestClock.
 */
const onSystemClock = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.updateContext(effect, (context: Context.Context<never>) =>
    Context.omit(Clock.Clock)(context),
  );

/**
 * Runs listings in their own process group, so a listing stopped by its budget or by closing
 * takes any children with it. Node's `child_process` is wrapped here, once, rather than run
 * through `effect/process`: stopping a group needs the negative-PID signal to the whole group,
 * SIGKILL after the grace whether or not the leader has exited, and a wait until no member is left,
 * which its spawner's kill doesn't do (it can signal only the leader and doesn't confirm the group
 * is gone). The stop runs on the system clock; the budget on the caller's.
 */
export const makeRunListing =
  ({ budget, stopGrace }: ChatFileListingTiming): ChatFileListingRun =>
  (executable, args, cwd) =>
    Effect.scoped(
      Effect.gen(function* () {
        const ended = yield* Deferred.make<Ended>();
        const overflowed = yield* Deferred.make<void>();
        // Output still arriving after a stop is kept, up to the size budget: what the listing
        // printed before its budget ran out is its partial listing, however late it is read.
        const chunks: Buffer[] = [];
        let length = 0;
        const stopped = yield* Deferred.make<void>();
        const stop = (group: number) =>
          Effect.uninterruptible(
            Effect.flatMap(Deferred.succeed(stopped, undefined), (first) =>
              first
                ? Effect.gen(function* () {
                    signalGroup(group, 'SIGTERM');
                    // A group that ignores SIGTERM, or a child holding the output, is killed
                    // after the grace whether or not the leader exited.
                    if (!(yield* awaitGroupGone(group, stopGrace))) {
                      signalGroup(group, 'SIGKILL');
                      yield* awaitGroupGone(group, stopGrace);
                    }
                    yield* Effect.timeoutOption(Deferred.await(ended), stopGrace);
                  }).pipe(onSystemClock)
                : Deferred.await(stopped),
            ),
          );
        const child = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const child = spawn(executable, [...args], {
              cwd,
              detached: true,
              stdio: ['ignore', 'pipe', 'ignore'],
            });
            const end = (value: Ended) => Deferred.doneUnsafe(ended, Exit.succeed(value));
            child.stdout!.on('data', (chunk: Buffer) => {
              if (length >= listingBytes) return;
              if (length + chunk.length > listingBytes) {
                chunks.push(chunk.subarray(0, listingBytes - length));
                length = listingBytes;
                Deferred.doneUnsafe(overflowed, Exit.void);
                return;
              }
              chunks.push(chunk);
              length += chunk.length;
            });
            child.stdout!.on('error', () => {});
            child.once('error', (error) => {
              if (child.pid !== undefined) signalGroup(child.pid, 'SIGKILL');
              end({ code: null, error });
            });
            child.once('close', (code) => end({ code }));
            return child;
          }),
          // Closing the index, or a caller giving up, stops a listing that is still running.
          (child) =>
            Effect.flatMap(Deferred.isDone(ended), (done) =>
              done || child.pid === undefined ? Effect.void : stop(child.pid),
            ),
        );
        const outcome = yield* Effect.raceFirst(
          Effect.map(Deferred.await(ended), (value) => Option.some(value)),
          Effect.as(
            Effect.raceFirst(Effect.sleep(budget), Deferred.await(overflowed)),
            Option.none<Ended>(),
          ),
        );
        if (Option.isNone(outcome)) {
          if (child.pid !== undefined) yield* stop(child.pid);
          return { bytes: Buffer.concat(chunks), truncated: true };
        }
        const { code, error } = outcome.value;
        const output = Buffer.concat(chunks);
        if (error)
          return yield* new ListingError({
            reason: error.code === 'ENOENT' ? 'missing' : 'failed',
            output,
          });
        if (code === 0) return { bytes: output, truncated: false };
        return yield* new ListingError({
          reason: 'exited',
          ...(code === null ? {} : { status: code }),
          output,
        });
      }),
    );
