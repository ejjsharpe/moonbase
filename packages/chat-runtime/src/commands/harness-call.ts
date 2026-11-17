import { Effect } from 'effect';
import type { ChatError } from '@moonbase/contracts/chat-errors';
import { safeError } from './safe-error.ts';

/**
 * One call into Pi, given the signal that aborts it. Interrupting the call aborts the signal and
 * then waits for Pi's Promise to settle, so no SDK work outlives the fiber that started it and the
 * store never closes under it. `uncertain` marks a mutation: an unknown failure may have committed.
 */
export const callHarness = <A>(
  run: (signal: AbortSignal) => Promise<A>,
  uncertain = false,
): Effect.Effect<A, ChatError> =>
  Effect.callback<A, ChatError>((resume, signal) => {
    let settled: Promise<void>;
    try {
      settled = run(signal).then(
        (value) => resume(Effect.succeed(value)),
        (error: unknown) => resume(Effect.fail(safeError(error, uncertain))),
      );
    } catch (error) {
      resume(Effect.fail(safeError(error, uncertain)));
      return;
    }
    return Effect.promise(() => settled);
  });
