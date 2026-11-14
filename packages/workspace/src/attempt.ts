import { Effect } from 'effect';
import { isWorkspaceError, type WorkspaceError } from '@moonbase/contracts/workspace-errors';
import { HelperFailure, SystemFailure } from './system-failures.ts';

/** What workspace work fails with before the host or client maps it for its callers. */
export type WorkspaceFailure = WorkspaceError | HelperFailure | SystemFailure;

/** `error` as a workspace failure: the workspace's errors as they are, anything else a system failure. */
export const asWorkspaceFailure = (error: unknown): WorkspaceFailure =>
  isWorkspaceError(error) || error instanceof HelperFailure || error instanceof SystemFailure
    ? error
    : new SystemFailure({ code: (error as NodeJS.ErrnoException | undefined)?.code, cause: error });

/**
 * Runs synchronous work that may throw, such as a filesystem call or a check, as an Effect that
 * fails with what it threw: a workspace error as itself, anything else as a `SystemFailure`.
 */
export const attempt = <A>(work: () => A): Effect.Effect<A, WorkspaceFailure> =>
  Effect.try({ try: work, catch: asWorkspaceFailure });
