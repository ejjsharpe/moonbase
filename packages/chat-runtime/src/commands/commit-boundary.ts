import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { ConversationBusy, type Harness, type Tx } from '@earendil-works/pi-durable';
import { Effect } from 'effect';
import { ChatBusyError, isChatError, type ChatError } from '@moonbase/contracts/chat-errors';
import { callAbortable } from '../abortable-call.ts';
import { uncertainError } from './safe-error.ts';

/**
 * A failure proven to have committed nothing, such as a refusal a commit's own callback raised
 * before it wrote. Only these stay definite once a mutation may have committed.
 */
export class Refusal {
  readonly error: ChatError;
  constructor(error: ChatError) {
    this.error = error;
  }
}

/**
 * Runs a mutation from its first commit attempt, or its first lookup of what an earlier attempt
 * committed, to its reply. Every failure but a `Refusal` may follow a commit, a lost
 * acknowledgement, a post-commit read or a typed error included, so it fails as `UncertainError`.
 */
export const mayHaveCommitted = <A>(
  effect: Effect.Effect<A, ChatError | Refusal>,
): Effect.Effect<A, ChatError> =>
  Effect.mapError(effect, (error) => (error instanceof Refusal ? error.error : uncertainError()));

/**
 * Commits `change` in one Pi transaction. A chat error `change` throws aborts the transaction
 * before anything is written, so it fails as a `Refusal`; any other failure, a typed one Pi
 * reports included, may follow the commit and fails as `UncertainError`.
 */
export const commitChange = <A>(
  harness: Harness,
  change: (tx: Tx) => Promise<A>,
): Effect.Effect<A, ChatError | Refusal> =>
  callAbortable(() =>
    harness.commit(async (tx) => {
      try {
        return await change(tx);
      } catch (error) {
        throw isChatError(error) ? new Refusal(error) : error;
      }
    }, context),
  ).pipe(Effect.mapError((error) => (error instanceof Refusal ? error : uncertainError())));
/**
 * A failure of Pi's submit: a `Refusal` only for Pi's raw busy refusal, which proves nothing was
 * written, and uncertain for anything else, even a chat error.
 */
export const submitError = (error: unknown): ChatError | Refusal => {
  try {
    if (error instanceof ConversationBusy) return new Refusal(new ChatBusyError());
  } catch {
    /* Unknown SDK diagnostics remain private. */
  }
  return uncertainError();
};
