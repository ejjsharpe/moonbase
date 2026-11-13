import * as Schema from 'effect/Schema';
import { FileTargetSchema } from './target-schema.ts';

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
 * The one error Moonbase shows or sends. Its message is written by Moonbase, never copied from
 * an unknown failure, so it is safe to show; `normalizeApplicationError` in `@moonbase/effect`
 * turns anything else into one.
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

/** Throws an `ApplicationError`; typed `never` so it can end an expression. */
export function fail(code: ApplicationErrorCode, message: string): never {
  throw new ApplicationError({ code, message });
}
