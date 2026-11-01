import { ApplicationError } from './client.ts';

// Only owner-authored application errors carry diagnostics safe for public clients.
export const safeApplicationFailure = (value: unknown, message: string): ApplicationError =>
  ApplicationError.is(value) ? value : new ApplicationError({ code: 'Unavailable', message });
