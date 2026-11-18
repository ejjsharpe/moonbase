import * as Schema from 'effect/Schema';
import { FileTargetSchema } from './target-schema.ts';

// Outcomes every caller treats the same, whatever module failed (D14).

/** A mutation that may have committed: its caller checks the outcome and never resends it. */
export class UncertainError extends Schema.TaggedError<UncertainError>()('UncertainError', {
  operation: Schema.String,
  target: Schema.optional(FileTargetSchema),
}) {
  override get message(): string {
    return `${this.operation} may have completed. Check its outcome before retrying.`;
  }
}

/** Work stopped because its caller cancelled it. */
export class CancelledError extends Schema.TaggedError<CancelledError>()('CancelledError', {
  operation: Schema.String,
}) {
  override get message(): string {
    return `${this.operation} was cancelled.`;
  }
}

/** The caller isn't allowed to do this, or its credentials were refused. */
export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()(
  'UnauthorizedError',
  { operation: Schema.String },
) {
  override get message(): string {
    return `${this.operation} is not authorized.`;
  }
}
