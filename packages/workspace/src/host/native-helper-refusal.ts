import { NativeSourceError } from '@moonbase/contracts/workspace-host-errors';
import { classifyHelperFailure, type HelperFailure } from '../system-failures.ts';

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
 * The native import refusal the helper reported by ending with exit 1, or undefined when it
 * reported anything else (which stays a helper failure).
 */
export const findNativeHelperRefusal = (failure: HelperFailure) => {
  if (classifyHelperFailure(failure) !== 'failed' || failure.status !== 1) return undefined;
  const problem = refusals.get(/^\d+:(.*): /.exec(failure.stderr)?.[1] ?? '');
  return problem && new NativeSourceError({ problem });
};
