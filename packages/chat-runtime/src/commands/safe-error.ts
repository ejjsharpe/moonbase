import { Effect } from 'effect';
import { ConversationBusy } from '@earendil-works/pi-durable';
import {
  ChatBusyError,
  ChatStoreError,
  ChatUnavailableError,
  isChatError,
  type ChatError,
} from '@moonbase/contracts/chat-errors';
import { UncertainError } from '@moonbase/contracts/errors';

/**
 * A chat failure safe to show: Pi's busy refusal as `ChatBusyError`, any other unknown failure
 * hidden, as a store failure, or for a mutation that may have committed as `UncertainError`.
 */
export const safeError = (error: unknown, uncertain = false): ChatError => {
  if (isChatError(error)) return error;
  try {
    if (error instanceof ConversationBusy) return new ChatBusyError();
  } catch {
    /* Unknown SDK diagnostics remain private. */
  }
  return uncertain
    ? new UncertainError({ operation: 'The chat request' })
    : new ChatStoreError({ problem: 'failed' });
};
/**
 * A watch's failure safe to show: a chat error as itself, and anything else (Pi's subscriptions,
 * a failed re-read) unavailable, so its client watches again.
 */
export const watchError = (error: unknown): ChatError =>
  isChatError(error) ? error : new ChatUnavailableError({ reason: 'watch-failed' });
/**
 * Runs a synchronous check that throws a chat error, such as a stored-record decoder Pi's commit
 * callbacks share, keeping its failure typed.
 */
export const runCheck = <A>(check: () => A, uncertain = false): Effect.Effect<A, ChatError> =>
  Effect.try({ try: check, catch: (error) => safeError(error, uncertain) });
