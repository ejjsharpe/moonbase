import { Effect } from 'effect';
import {
  isWorkspaceHostError,
  type WorkspaceHostError,
} from '@moonbase/contracts/workspace-host-errors';
import { HelperFailure, SystemFailure } from './system-failures.ts';

/** What host work fails with before the host maps it for its callers. */
export type HostFailure = WorkspaceHostError | HelperFailure | SystemFailure;

/** `error` as a host failure: the host's own errors as they are, anything else a system failure. */
export const asHostFailure = (error: unknown): HostFailure =>
  isWorkspaceHostError(error) || error instanceof HelperFailure || error instanceof SystemFailure
    ? error
    : new SystemFailure({ code: (error as NodeJS.ErrnoException | undefined)?.code, cause: error });

/**
 * Runs synchronous work that may throw, such as a filesystem call or a check, as an Effect that
 * fails with what it threw: a host error as itself, anything else as a `SystemFailure`.
 */
export const attempt = <A>(work: () => A): Effect.Effect<A, HostFailure> =>
  Effect.try({ try: work, catch: asHostFailure });
