import * as Schema from 'effect/Schema';

const reasons = {
  start: 'The process could not be started.',
  teardown: 'The process group could not be confirmed stopped before its deadline.',
} as const;

/** A process group could not be started, or its stop was not confirmed, for `reason`. */
export class ProcessGroupError extends Schema.TaggedError<ProcessGroupError>()(
  'ProcessGroupError',
  { reason: Schema.Literals(['start', 'teardown']) },
) {
  override get message(): string {
    return reasons[this.reason];
  }
}
