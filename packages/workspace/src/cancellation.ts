import { Effect, Exit } from 'effect';

// Host work runs uninterruptibly except where it says it may stop, so a cancelled save or
// operation never stops between writing the disk and journalling it.

/**
 * Where work stops if its caller has cancelled. It yields first, so a cancellation sent while the
 * work ran without pause (its checks are synchronous) still arrives before what follows.
 */
export const cancellationPoint = Effect.interruptible(Effect.yieldNow);

/** Whether the work has been asked to stop, without stopping it. */
export const isCancelled = Effect.map(Effect.exit(cancellationPoint), Exit.isFailure);
