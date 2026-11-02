import type { FileTarget } from './workspace.ts';
import type { ApplicationErrorCodeSchema } from './error-schema.ts';

export type ApplicationErrorCode = typeof ApplicationErrorCodeSchema.Type;
export class ApplicationError extends Error {
  // oxlint-disable-next-line no-unused-private-class-members -- Private-brand membership below authenticates errors without trusting public fields.
  #applicationError = true;
  readonly _tag = 'ApplicationError';
  readonly code: ApplicationErrorCode;
  readonly target?: FileTarget;
  constructor(options: { code: ApplicationErrorCode; message: string; target?: FileTarget }) {
    super(options.message);
    this.name = 'ApplicationError';
    this.code = options.code;
    this.target = options.target;
  }
  static is(value: unknown): value is ApplicationError {
    try {
      return typeof value === 'object' && value !== null && #applicationError in value;
    } catch {
      return false;
    }
  }
  static fromUnknown(value: unknown): ApplicationError {
    if (ApplicationError.is(value)) return value;
    let message: string;
    try {
      message = String(value);
    } catch {
      message = 'Unprintable application failure';
    }
    return new ApplicationError({ code: 'Unavailable', message });
  }
}
