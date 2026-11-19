import { Data, Deferred, Duration, Effect, Exit, Option } from 'effect';
import { type ProcessGroupExit, type ProcessGroupsShape } from '@moonbase/process-group';

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

/**
 * Runs listings in their own process group (`@moonbase/process-group`), so a listing stopped by
 * its budget or by closing takes any children with it: SIGTERM, then SIGKILL after `stopGrace`
 * whether or not the leader has exited, and as long again for the group to be gone. A listing
 * whose group can't be confirmed gone fails rather than returning what it printed. The stop runs
 * on the system clock; the budget on the caller's.
 */
export const makeRunListing =
  ({ budget, stopGrace }: ChatFileListingTiming, groups: ProcessGroupsShape): ChatFileListingRun =>
  (executable, args, cwd) =>
    Effect.scoped(
      Effect.gen(function* () {
        const overflowed = yield* Deferred.make<void>();
        // Output still arriving after a stop is kept, up to the size budget: what the listing
        // printed before its budget ran out is its partial listing, however late it is read.
        const chunks: Buffer[] = [];
        let length = 0;
        // Closing the index, or a caller giving up, stops a listing that is still running.
        const group = yield* groups
          .spawn(executable, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'ignore'],
            stopTiming: { termGrace: stopGrace, deadline: Duration.toMillis(stopGrace) * 2 },
          })
          .pipe(
            Effect.mapError(() => new ListingError({ reason: 'failed', output: Buffer.alloc(0) })),
          );
        group.process.stdout!.on('data', (chunk: Buffer) => {
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
        // A listing has ended once every pipe closed, so all it printed has been read.
        const outcome = yield* Effect.raceFirst(
          Effect.andThen(group.closed, Effect.map(group.exit, Option.some)),
          Effect.as(
            Effect.raceFirst(Effect.sleep(budget), Deferred.await(overflowed)),
            Option.none<ProcessGroupExit>(),
          ),
        );
        if (Option.isNone(outcome)) {
          // A group still running could go on writing where the listing looked: nothing is kept.
          yield* Effect.mapError(
            group.stop,
            () => new ListingError({ reason: 'failed', output: Buffer.alloc(0) }),
          );
          return { bytes: Buffer.concat(chunks), truncated: true };
        }
        const { code, spawnFailed, spawnErrorCode } = outcome.value;
        const output = Buffer.concat(chunks);
        if (spawnFailed)
          return yield* new ListingError({
            reason: spawnErrorCode === 'ENOENT' ? 'missing' : 'failed',
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
