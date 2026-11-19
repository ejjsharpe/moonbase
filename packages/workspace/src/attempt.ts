import { Effect, Schema } from 'effect';
import { isWorkspaceError, type WorkspaceError } from '@moonbase/contracts/workspace-errors';
import { asSystemFailure, HelperFailure, SystemFailure } from './system-failures.ts';

const isHelperFailure = Schema.is(HelperFailure);
const isSystemFailure = Schema.is(SystemFailure);

/** What workspace work fails with before the host or client maps it for its callers. */
export type WorkspaceFailure = WorkspaceError | HelperFailure | SystemFailure;

/** `error` as a workspace failure: the workspace's errors as they are, anything else a system failure. */
export const asWorkspaceFailure = (error: unknown): WorkspaceFailure =>
  isWorkspaceError(error) || isHelperFailure(error) || isSystemFailure(error)
    ? error
    : asSystemFailure(error);

/**
 * Runs a synchronous step that must not be split, as an Effect that fails with what it threw: a
 * workspace error as itself, anything else as a `SystemFailure`. Only for work that has to run in
 * one step (a store transaction, a reservation together with its claim, a no-follow identity
 * check); anything else returns an Effect with its own errors.
 */
export const attempt = <A>(work: () => A): Effect.Effect<A, WorkspaceFailure> =>
  Effect.try({ try: work, catch: asWorkspaceFailure });
