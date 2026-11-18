import { Cause, Effect } from 'effect';
import * as Schema from 'effect/Schema';
import type { ApplicationErrorCode } from '@moonbase/contracts/errors';

// What a transcript read found wrong with what it read (epic #273 D14). Each problem names what
// happened and its message is Moonbase's own; `describeChatFailure` shows it.

const problems = {
  'source-changed': ['Conflict', 'Transcript source changed or is stale.'],
  cancelled: ['Cancelled', 'Transcript read cancelled.'],
  'live-authority': ['Conflict', 'Live transcript reads require current observation authority.'],
  'cursor-stalled': ['Incompatible', 'Transcript cursor did not advance.'],
  'reply-mismatch': ['Incompatible', 'Transcript reply does not match the captured selection.'],
  'manifest-repeats-part': ['Incompatible', 'Transcript manifest repeats a part.'],
  'manifest-continuation-repeats': ['Incompatible', 'Manifest continuation repeats a part.'],
  'expected-manifest': ['Incompatible', 'Expected a transcript manifest.'],
  'content-unavailable': ['Unavailable', 'Selected transcript content is unavailable.'],
  'chunk-gap': ['Incompatible', 'Transcript content has a missing or overlapping chunk.'],
  'encoding-changed': ['Incompatible', 'Transcript encoding changed within a selected part.'],
  'content-incomplete': ['Incompatible', 'Transcript content is incomplete.'],
  'history-repeats-entry': ['Incompatible', 'History repeats an entry.'],
  'history-order-changed': ['Incompatible', 'History order changed within a navigation window.'],
  'history-cursor-stalled': ['Incompatible', 'History cursor did not advance.'],
  'around-mismatch': ['Incompatible', 'Around-entry reply does not match its navigation boundary.'],
  'entry-source': ['Incompatible', 'Transcript entry belongs to another source.'],
  'snapshot-conversation': ['Incompatible', 'Snapshot belongs to another conversation.'],
  'live-run-mismatch': ['Incompatible', 'Live transcript does not match its run.'],
  'find-reply-mismatch': [
    'Incompatible',
    'Find reply does not match the query or advance its fixed boundary.',
  ],
  'find-match-order': ['Incompatible', 'Find repeats or reverses an original-text match.'],
  'find-match-invalid': ['Incompatible', 'Find returned an invalid original-text match.'],
  'find-match-gone': ['Conflict', 'Saved Find match is no longer available.'],
  'find-replay-unavailable': ['Incompatible', 'Find must be refreshed before replay.'],
  'invalid-view': ['Incompatible', 'Invalid transcript view.'],
} as const satisfies Record<string, readonly [ApplicationErrorCode, string]>;
export type TranscriptReadProblem = keyof typeof problems;

/** A transcript read, or the view it was given, did not hold together. */
export class TranscriptReadError extends Schema.TaggedError<TranscriptReadError>()(
  'TranscriptReadError',
  { problem: Schema.Literals(Object.keys(problems) as TranscriptReadProblem[]) },
) {
  override get message(): string {
    return problems[this.problem][1];
  }
  /** The legacy code (D14) the problem had as an `ApplicationError`. */
  get code(): ApplicationErrorCode {
    return problems[this.problem][0];
  }
}

/** Runs a synchronous check, failing with the `TranscriptReadError` it throws. */
export const checkTranscript = <A>(check: () => A): Effect.Effect<A, TranscriptReadError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(check());
    } catch (error) {
      if (error instanceof TranscriptReadError) return Effect.fail(error);
      throw error;
    }
  });

/**
 * Hands a read's failure to `handle`, which publishes it. The checks a read runs throw their
 * `TranscriptReadError`, so a defect is handled too; an interruption is a cancellation and passes.
 */
export const catchReadFailure =
  (handle: (error: unknown) => Effect.Effect<void>) =>
  <E>(effect: Effect.Effect<void, E>): Effect.Effect<void> =>
    Effect.catchCause(effect, (cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : handle(Cause.squash(cause)),
    );
