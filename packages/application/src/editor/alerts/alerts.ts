import { isKnownError } from '@moonbase/contracts/error-groups';
import { isEditorError } from '../editor-errors.ts';

const fallback = 'Application effect failed';

/**
 * The text the editor shows for a failure (D14), its one tag-to-text mapping: a string is a note
 * Moonbase wrote and shows as it is; the editor's errors, the workspace's, desktop IPC's and the
 * shared outcomes build their message from their fields; anything else shows only fixed text.
 */
export function describeEditorFailure(error: unknown): string {
  if (typeof error === 'string') return error;
  if (isEditorError(error) || isKnownError(error)) return (error as Error).message;
  return fallback;
}

/** The alerts shown, newest last: at most 20. */
export const appendAlert = (alerts: readonly string[], message: string): readonly string[] => [
  ...alerts.slice(-19),
  message,
];

/** Whether the failure is work its caller cancelled, the shared `CancelledError`. */
export const isCancelled = (error: unknown) =>
  error instanceof Error && (error as { _tag?: unknown })._tag === 'CancelledError';
