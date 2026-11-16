import { ApplicationError } from '@moonbase/contracts/errors';
import { isWorkspaceError } from '@moonbase/contracts/workspace-errors';
import { isEditorError } from '../editor-errors.ts';

const sharedOutcomes = new Set(['UncertainError', 'CancelledError', 'UnauthorizedError']);
const fallback = 'Application effect failed';

/**
 * The text the editor shows for a failure (D14), its one tag-to-text mapping: a string is a note
 * Moonbase wrote and shows as it is; the editor's, the workspace's and the shared outcome errors
 * build their message from their fields; anything else shows only fixed text.
 */
export function describeEditorFailure(error: unknown): string {
  if (typeof error === 'string') return error;
  if (isEditorError(error) || ApplicationError.is(error) || isWorkspaceError(error))
    return error.message;
  const tag = error instanceof Error ? (error as { _tag?: unknown })._tag : undefined;
  return typeof tag === 'string' && sharedOutcomes.has(tag) ? (error as Error).message : fallback;
}

/** The alerts shown, newest last: at most 20. */
export const appendAlert = (alerts: readonly string[], message: string): readonly string[] => [
  ...alerts.slice(-19),
  message,
];
