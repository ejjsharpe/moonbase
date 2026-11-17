import { Deferred, Effect, Exit, Fiber, FiberMap, type Scope } from 'effect';
import type { ChatTranscriptSource } from '@moonbase/contracts/chat';
import { describeChatFailure } from '../chat-errors.ts';
import { catchReadFailure, TranscriptReadError } from './transcript-errors.ts';
import { admitThrough, behindGate, joinRead } from './transcript-gate.ts';
import type { TranscriptFailure, TranscriptStore } from './transcript-store.ts';

export const historyJob = 'history',
  manifestJob = 'manifest';

/** What a running job reads, which decides what a snapshot or a cancelled reveal interrupts. */
export type TranscriptJobRead = {
  readonly source: ChatTranscriptSource | undefined;
  /** Started for the Find match being revealed, so cancelling the reveal interrupts it. */
  readonly revealing: boolean;
};
type Job = TranscriptJobRead & { fiber?: Fiber.Fiber<void> };
export type TranscriptJobOptions = {
  /** Interrupts a running job for the key rather than joining it. */
  replace?: boolean;
  source?: ChatTranscriptSource;
  revealing?: boolean;
  /**
   * Keeps a failure on the read's own state (manifest and part reads), so it neither blocks nor
   * clears history paging. Without it the failure is the transcript's `error`.
   */
  fail?: (error: unknown) => void;
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
  /** The keys of the running jobs `select` picks. */
  readonly keys: (select: (read: TranscriptJobRead, key: string) => boolean) => string[];
  /** Interrupts the running jobs `select` picks and waits for them to end. */
  readonly interrupt: (
    select: (read: TranscriptJobRead, key: string) => boolean,
  ) => Effect.Effect<void>;
};

export const makeTranscriptJobs = (
  store: TranscriptStore,
): Effect.Effect<TranscriptJobs, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Forks synchronously, so checking for a running job and installing one is a single step.
    const fork = yield* Effect.flatMap(FiberMap.make<string, void>(), (map) =>
      FiberMap.runtime(map)<never>(),
    );
    const jobs = new Map<string, Job>();
    /** A replaced job leaves the key to its successor; whoever interrupted it published first. */
    const settle = (key: string, job: Job, exit: Exit.Exit<void>) =>
      Effect.suspend(() => {
        if (jobs.get(key) !== job) return Effect.void;
        jobs.delete(key);
        if (Exit.hasInterrupts(exit)) {
          if (store.contents.peek(key)?.status === 'loading')
            store.contents.mark(key, { status: 'partial' });
          const manifest = store.state.manifest;
          if (key === manifestJob && manifest?.status === 'loading')
            store.state = { ...store.state, manifest: { ...manifest, status: 'partial' } };
        }
        store.state = {
          ...store.state,
          loading: key !== historyJob && jobs.has(historyJob),
        };
        return store.publish();
      });
    const run: TranscriptJobs['run'] = (key, work, options = {}) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        if (!store.isCurrent()) return;
        const pending = jobs.get(key);
        if (pending && !options.replace) return yield* joinRead(pending.fiber!);
        const history = key === historyJob;
        const job: Job = { source: options.source, revealing: !!options.revealing };
        const read = Effect.suspend(() =>
          store.isCurrent()
            ? work
            : Effect.fail(new TranscriptReadError({ problem: 'source-changed' })),
        ).pipe(
          catchReadFailure((error) =>
            Effect.sync(() => {
              if (options.fail) options.fail(error);
              else store.state = { ...store.state, error: describeChatFailure(error) };
            }),
          ),
          Effect.onExit((exit) => settle(key, job, exit)),
        );
        // Recorded before forking, which interrupts a replaced job: its settling then finds it gone.
        jobs.set(key, job);
        const fiber = (job.fiber = fork(key, behindGate(gate, read)));
        store.state = {
          ...store.state,
          error: history ? null : store.state.error,
          loading: history || store.state.loading,
        };
        yield* admitThrough(gate, store.publish());
        yield* joinRead(fiber);
      });
    const keys: TranscriptJobs['keys'] = (select) =>
      [...jobs].filter(([key, job]) => select(job, key)).map(([key]) => key);
    return {
      run,
      running: (key) => jobs.get(key)?.fiber,
      keys,
      interrupt: (select) =>
        Effect.suspend(() =>
          Fiber.interruptAll(
            [...jobs].filter(([key, job]) => select(job, key)).map(([, job]) => job.fiber!),
          ),
        ),
    } satisfies TranscriptJobs;
  });
