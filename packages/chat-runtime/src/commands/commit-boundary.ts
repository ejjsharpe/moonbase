import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { ConversationBusy, type Harness, type Tx } from '@earendil-works/pi-durable';
import { Effect } from 'effect';
import { ChatBusyError, type ChatError } from '@moonbase/contracts/chat-errors';
import { isAccessRefusal, isIncompatible } from '@moonbase/contracts/error-groups';
import { callAbortable } from '../abortable-call.ts';
import { uncertainError } from './safe-error.ts';

/**
 * A failure proven to have committed nothing, now or in any earlier attempt of the same request:
 * a conflicting binding decoded from the request's journal, a validation that is the same whatever
 * happened before, or a refusal the request recorded. Only these stay definite once a mutation may
 * have committed; a caller marks each one explicitly.
 */
export class Refusal {
  readonly error: ChatError;
  constructor(error: ChatError) {
    this.error = error;
  }
}

/** `error` if it is a `Refusal`; a value whose prototype can't even be read is not one. */
const findRefusal = (error: unknown): Refusal | undefined => {
  try {
    return error instanceof Refusal ? error : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Runs a mutation from its first commit attempt, or its first lookup of what an earlier attempt
 * committed, to its reply. Every failure but a `Refusal` may follow a commit, a lost
 * acknowledgement, a post-commit read, a journal that fails to decode, a typed error or a defect
 * included, so it fails as `UncertainError`.
 */
export const mayHaveCommitted = <A>(
  effect: Effect.Effect<A, ChatError | Refusal>,
): Effect.Effect<A, ChatError> =>
  effect.pipe(
    Effect.mapError((error) => findRefusal(error)?.error ?? uncertainError()),
    Effect.catchDefect(() => Effect.fail(uncertainError())),
  );

/**
 * Runs a check that precedes a mutation's commit but may follow an earlier attempt's, such as its
 * chat's metadata lookup. Only the chat's authority refusals (`access`, `incompatible`) stay
 * definite; any other failure, a defect included, fails as `UncertainError`.
 */
export const keepAuthorityRefusals = <A>(
  effect: Effect.Effect<A, ChatError>,
): Effect.Effect<A, ChatError> =>
  effect.pipe(
    Effect.mapError((error) =>
      isAccessRefusal(error) || isIncompatible(error) ? error : uncertainError(),
    ),
    Effect.catchDefect(() => Effect.fail(uncertainError())),
  );

/**
 * Commits `change` in one Pi transaction. A `Refusal` `change` throws stays one. Pi rolls back
 * only the current attempt, which proves nothing about an earlier one, so any other failure, a
 * chat error `change` throws included, fails as `UncertainError`.
 */
export const commitChange = <A>(
  harness: Harness,
  change: (tx: Tx) => Promise<A>,
): Effect.Effect<A, ChatError | Refusal> =>
  callAbortable(() => harness.commit(change, context)).pipe(
    Effect.mapError((error) => findRefusal(error) ?? uncertainError()),
  );
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
