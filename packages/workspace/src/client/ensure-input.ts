import { fail } from '@moonbase/contracts/errors';

/** Refuses a client request as `InvalidInput` unless `condition` holds (until CL-11 tags these). */
export const ensureInput: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) fail('InvalidInput', message);
};
