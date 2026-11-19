import { Effect } from 'effect';
import type { ChatError } from '@moonbase/contracts/chat-errors';
import { callAbortable } from '../abortable-call.ts';
import { safeError } from './safe-error.ts';

/**
 * One call into Pi. Interrupting it waits for Pi's Promise to settle, so no SDK work outlives the
 * fiber that started it and the store never closes under it. `uncertain` marks a mutation: an
 * unknown failure may have committed.
 */
export const callHarness = <A>(
  run: () => Promise<A>,
  uncertain = false,
): Effect.Effect<A, ChatError> =>
  Effect.mapError(callAbortable(run), (error) => safeError(error, uncertain));
