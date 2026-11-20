import { Cause, Effect } from 'effect';
import * as Schema from 'effect/Schema';
import type { ErrorGroup } from '@moonbase/contracts/error-groups';

// What a transcript read found wrong with what it read (epic #273 D14). Each problem names what
// happened, what it means for the read (its `group`) and its message, which is Moonbase's own;
// `describeChatFailure` shows it.

const problems = {
  'source-changed': ['conflict', 'Transcript source changed or is stale.'],
  'live-authority': ['conflict', 'Live transcript reads require current observation authority.'],
  'cursor-stalled': ['incompatible', 'Transcript cursor did not advance.'],
  'reply-mismatch': ['incompatible', 'Transcript reply does not match the captured selection.'],
  'manifest-repeats-part': ['incompatible', 'Transcript manifest repeats a part.'],
  'manifest-continuation-repeats': ['incompatible', 'Manifest continuation repeats a part.'],
  'expected-manifest': ['incompatible', 'Expected a transcript manifest.'],
  'content-unavailable': ['unavailable', 'Selected transcript content is unavailable.'],
  'chunk-gap': ['incompatible', 'Transcript content has a missing or overlapping chunk.'],
  'encoding-changed': ['incompatible', 'Transcript encoding changed within a selected part.'],
  'content-incomplete': ['incompatible', 'Transcript content is incomplete.'],
  'history-repeats-entry': ['incompatible', 'History repeats an entry.'],
  'history-order-changed': ['incompatible', 'History order changed within a navigation window.'],
  'history-cursor-stalled': ['incompatible', 'History cursor did not advance.'],
  'around-mismatch': ['incompatible', 'Around-entry reply does not match its navigation boundary.'],
  'entry-source': ['incompatible', 'Transcript entry belongs to another source.'],
  'snapshot-conversation': ['incompatible', 'Snapshot belongs to another conversation.'],
  'live-run-mismatch': ['incompatible', 'Live transcript does not match its run.'],
  'find-reply-mismatch': [
    'incompatible',
    'Find reply does not match the query or advance its fixed boundary.',
  ],
  'find-match-order': ['incompatible', 'Find repeats or reverses an original-text match.'],
  'find-match-invalid': ['incompatible', 'Find returned an invalid original-text match.'],
  'find-match-gone': ['conflict', 'Saved Find match is no longer available.'],
  'find-replay-unavailable': ['incompatible', 'Find must be refreshed before replay.'],
  'invalid-view': ['incompatible', 'Invalid transcript view.'],
} as const satisfies Record<string, readonly [ErrorGroup, string]>;
export type TranscriptReadProblem = keyof typeof problems;

/** A transcript read, or the view it was given, did not hold together. */
export class TranscriptReadError extends Schema.TaggedError<TranscriptReadError>()(
  'TranscriptReadError',
  { problem: Schema.Literals(Object.keys(problems) as TranscriptReadProblem[]) },
) {
  get group(): ErrorGroup {
    return problems[this.problem][0];
  }
  override get message(): string {
    return problems[this.problem][1];
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
