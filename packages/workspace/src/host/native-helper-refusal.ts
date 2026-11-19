import { NativeSourceError } from '@moonbase/contracts/workspace-host-errors';
import { HelperFailure } from '../system-failures.ts';

// The helper (`native/filesystem.c`) reports a failure as `<errno>:<message>: <strerror>`; strerror
// holds no `: `, so the message runs to the first line's last one. These are the messages it
// writes when it refuses a native import's source.
const refusals = new Map<string, NativeSourceError['problem']>([
  ['Operation unavailable: hard-linked file', 'unsupported'],
  ['Unsupported source', 'unsupported'],
  ['Import ancestor replaced', 'parent-changed'],
  ['Native import source replaced', 'changed'],
]);

/**
 * `error` as the native import refusal the helper reported, or undefined when it reported
 * anything else (which stays a system failure).
 */
export const findNativeHelperRefusal = (error: unknown) => {
  if (!(error instanceof HelperFailure) || error.status !== 1 || error.uncertain) return undefined;
  const problem = refusals.get(/^\d+:(.*): /.exec(error.stderr)?.[1] ?? '');
  return problem && new NativeSourceError({ problem });
};
