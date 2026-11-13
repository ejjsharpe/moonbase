import * as Schema from 'effect/Schema';
import { FileTargetSchema } from '../shared/target-schema.ts';

export const ApplicationErrorCodeSchema = Schema.Literals([
  'InvalidInput',
  'Unavailable',
  'Conflict',
  'Persistence',
  'Uncertain',
  'Cancelled',
  'Unauthorized',
  'Incompatible',
]);
export type ApplicationErrorCode = typeof ApplicationErrorCodeSchema.Type;

/**
 * Legacy (epic #273, D14): modules move to their own tagged errors and the shared outcome errors
 * below, each in the ticket that rewrites it. Its message is written by Moonbase, never copied
 * from an unknown failure, so it is safe to show; `normalizeApplicationError` in
 * `@moonbase/effect` turns anything else into one.
 */
export class ApplicationError extends Schema.TaggedError<ApplicationError>()('ApplicationError', {
  code: ApplicationErrorCodeSchema,
  message: Schema.String,
  target: Schema.optional(FileTargetSchema),
}) {
  // oxlint-disable-next-line no-unused-private-class-members -- `is` checks this brand: unlike `instanceof`, it runs no Proxy trap.
  #applicationError = true;
  static is(value: unknown): value is ApplicationError {
    return typeof value === 'object' && value !== null && #applicationError in value;
  }
}

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

/** Throws an `ApplicationError`; typed `never` so it can end an expression. */
export function fail(code: ApplicationErrorCode, message: string): never {
  throw new ApplicationError({ code, message });
}
