import { Cause, Context, Effect, Exit, Fiber, FiberMap, Option, type Scope } from 'effect';
import type { ChatTranscriptSource } from '@moonbase/contracts/chat';
import { describeChatFailure } from '../chat-errors.ts';
import type { TranscriptState } from './transcript-state.ts';
import type { TranscriptFailure, TranscriptStore } from './transcript-store.ts';

export const historyJob = 'history',
  manifestJob = 'manifest';

/** What a running job reads, which decides what a snapshot or a cancelled reveal interrupts. */
export type TranscriptJobRead = {
  readonly source: ChatTranscriptSource | undefined;
  /** Started for the Find match being revealed, so cancelling the reveal interrupts it. */
  readonly revealing: boolean;
};
/** Each job's fiber carries what it reads. */
const JobRead = Context.Reference<TranscriptJobRead>('moonbase/chat/TranscriptJobRead', {
  defaultValue: () => ({ source: undefined, revealing: false }),
});
export type TranscriptJobOptions = {
  /** Interrupts a running job for the key rather than joining it. */
  replace?: boolean;
  source?: ChatTranscriptSource;
  revealing?: boolean;
  /**
   * Keeps a failure on the read's own state (manifest and part reads), so it neither blocks nor
   * clears history paging. Without it the failure is the transcript's `error`.
   */
  fail?: (state: TranscriptState, error: unknown) => TranscriptState;
};

/**
 * A transcript's keyed reads: the history read, the manifest read and each part's read. A key runs
 * one read at a time; closing the scope interrupts them all.
 */
export type TranscriptJobs = {
  /**
   * Runs `work` under `key` and waits for it, or joins the key's running job unless `replace`.
   * Starts nothing once the transcript failed. The history read clears `error` as it starts.
   */
  readonly run: (
    key: string,
    work: Effect.Effect<void, TranscriptFailure>,
    options?: TranscriptJobOptions,
  ) => Effect.Effect<void>;
  /** The key's running job, to join. */
  readonly running: (key: string) => Fiber.Fiber<void> | undefined;
  /** Interrupts the key's running job, making its read stale, and waits for it to end. */
  readonly remove: (key: string) => Effect.Effect<void>;
  /** Interrupts the running jobs `select` picks and waits for them to end. */
  readonly interrupt: (
    select: (read: TranscriptJobRead, key: string) => boolean,
  ) => Effect.Effect<void>;
  /**
   * Interrupts the running jobs `select` picks, synchronously, on behalf of fiber `by`, and returns
   * them to wait for. None resumes its read once this returns, even if its interruption waits.
   */
  readonly interruptUnsafe: (
    select: (read: TranscriptJobRead, key: string) => boolean,
    by: number,
  ) => readonly Fiber.Fiber<void>[];
};

/**
 * Waits for a read fiber to end. Its failures were published and its interruption is a
 * cancellation, so only a defect (such as one thrown while publishing) fails the wait.
 */
export const joinRead = (fiber: Fiber.Fiber<void>): Effect.Effect<void> =>
  Effect.flatMap(Fiber.await(fiber), (exit) =>
    Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
      ? Effect.failCause(exit.cause)
      : Effect.void,
  );

export const makeTranscriptJobs = (
  store: TranscriptStore,
): Effect.Effect<TranscriptJobs, never, Scope.Scope> =>
  Effect.gen(function* () {
    const jobs = yield* FiberMap.make<string, void, never>();
    const running = (key: string) => Option.getOrUndefined(FiberMap.getUnsafe(jobs, key));
    /**
     * Publishes how a job ended, in one update: its failure, if it failed, or a load it left
     * unfinished, if interrupted. A replaced job leaves the key, and its state, to its successor.
     */
    const settle = (key: string, ended: Exit.Exit<unknown>, options: TranscriptJobOptions) =>
      Effect.withFiber((self) => {
        const interrupted = Exit.isFailure(ended);
        // Replacing a job installs its successor first. A job that ends by itself is the key's,
        // even one that ended as it started, before the map recorded it.
        const current = running(key);
        if (interrupted && current && current !== self) return Effect.void;
        const failure = Exit.isSuccess(ended) ? ended.value : undefined;
        if (interrupted && store.contents.peek(key)?.status === 'loading')
          store.contents.mark(key, { status: 'partial' });
        return store.update((input) => {
          let state = input;
          if (failure !== undefined)
            state = options.fail
              ? options.fail(state, failure)
              : { ...state, error: describeChatFailure(failure) };
          const manifest = state.manifest;
          if (interrupted && key === manifestJob && manifest?.status === 'loading')
            state = { ...state, manifest: { ...manifest, status: 'partial' } };
          return { ...state, loading: key !== historyJob && FiberMap.hasUnsafe(jobs, historyJob) };
        });
      });
    const run: TranscriptJobs['run'] = (key, work, options = {}) =>
      Effect.gen(function* () {
        if (store.failed) return;
        const history = key === historyJob;
        // Publishing that the read started is the job's first step. `FiberMap.run` records the job
        // only once its fiber suspends, but what the publish prompts (a cancel, a newer read) runs
        // in subscribers' own fibers, after this one yields, so it finds the job in the map.
        const started = store.update((state) => ({
          ...state,
          error: history ? null : state.error,
          loading: history || state.loading,
        }));
        const job = Effect.andThen(started, work).pipe(
          // A failure ends the job with its value, to be published as it settles. The checks a read
          // runs throw their `TranscriptReadError`, so a defect is published too.
          Effect.as(undefined as unknown),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(Cause.squash(cause)),
          ),
          Effect.onExit((ended) => settle(key, ended, options)),
          Effect.asVoid,
        );
        // `onlyIfMissing` starts none while the key's job runs; this then joins that one.
        const fiber = yield* FiberMap.run(jobs, key, job, { onlyIfMissing: !options.replace }).pipe(
          Effect.provideService(JobRead, {
            source: options.source,
            revealing: !!options.revealing,
          }),
        );
        yield* joinRead(options.replace ? fiber : (running(key) ?? fiber));
      });
    const interruptUnsafe: TranscriptJobs['interruptUnsafe'] = (select, by) => {
      const stopped = [...jobs]
        .filter(([key, fiber]) => select(fiber.getRef(JobRead), key))
        .map(([, fiber]) => fiber);
      for (const fiber of stopped) fiber.interruptUnsafe(by);
      return stopped;
    };
    return {
      run,
      running,
      remove: (key) => FiberMap.remove(jobs, key),
      interrupt: (select) =>
        Effect.withFiber((self) => Fiber.awaitAll(interruptUnsafe(select, self.id))).pipe(
          Effect.asVoid,
        ),
      interruptUnsafe,
    } satisfies TranscriptJobs;
  });
