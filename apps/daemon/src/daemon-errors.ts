import * as Schema from 'effect/Schema';
import { getErrorGroup, type ErrorGroup } from '@moonbase/contracts/error-groups';
import { InvalidRootsError } from '@moonbase/contracts/folder-errors';
import { HostKeyExposedError } from '@moonbase/contracts/host-errors';
import { CredentialKeyError } from '@moonbase/contracts/provider-errors';

// The daemon's own failures (epic #273 D14). None names a path, secret or file contents, so each
// message may reach stderr and the journal as it is.

const dataProblems = {
  relative: 'Supply the absolute path of the daemon data directory.',
  uncreatable: 'The daemon data directory could not be created.',
  unsafe:
    'The daemon data directory or one of its files is not private to this user. Check its owner and permissions.',
  malformed: 'A daemon data file is malformed. Preserve the directory and check its files.',
  'file-uncreatable': 'A daemon data file could not be created.',
} as const;
/** The data directory or a file in it can't be used. */
export class DataDirectoryError extends Schema.TaggedError<DataDirectoryError>()(
  'DataDirectoryError',
  { problem: Schema.Literals(Object.keys(dataProblems) as (keyof typeof dataProblems)[]) },
) {
  override get message() {
    return dataProblems[this.problem];
  }
}

const configurationProblems = {
  arguments: 'The daemon takes one argument: the absolute path of its data directory.',
  settings: 'The daemon configuration is invalid.',
} as const;
/** The daemon was given more than its one argument, or settings it can't use. */
export class DaemonConfigurationError extends Schema.TaggedError<DaemonConfigurationError>()(
  'DaemonConfigurationError',
  {
    problem: Schema.Literals(
      Object.keys(configurationProblems) as (keyof typeof configurationProblems)[],
    ),
  },
) {
  override get message() {
    return configurationProblems[this.problem];
  }
}

const lockProblems = {
  held: 'A Moonbase daemon is already running for this data directory.',
  damaged:
    'The daemon lock file is damaged. If no daemon is running, remove daemon.lock from the data directory.',
  failed: 'The daemon lock could not be taken.',
} as const;
/** `daemon.lock` is held by another daemon, or can't be taken. */
export class DaemonLockError extends Schema.TaggedError<DaemonLockError>()('DaemonLockError', {
  problem: Schema.Literals(Object.keys(lockProblems) as (keyof typeof lockProblems)[]),
}) {
  override get message() {
    return lockProblems[this.problem];
  }
}

/** Every failure the daemon's own modules report. */
export type DaemonError = DataDirectoryError | DaemonConfigurationError | DaemonLockError;

const generic: Partial<Record<ErrorGroup, string>> = {
  refusal: 'The daemon configuration is invalid.',
  incompatible: 'The daemon store or runtime is incompatible.',
  storage: 'The daemon store is unavailable; preserve its data directory.',
  access: 'The daemon is not authorized to use its data.',
};

/**
 * What the daemon reports about a failure, on stderr and in its journal: the tag of a failure it
 * knows (its own, its startup refusals and those contracts defines, `UnknownError` for anything
 * else) and its own messages, which are written to be safe, or a generic one for the rest.
 */
export function describeFailure(error: unknown): { error: string; message: string } {
  if (
    error instanceof DataDirectoryError ||
    error instanceof DaemonConfigurationError ||
    error instanceof DaemonLockError ||
    error instanceof InvalidRootsError ||
    error instanceof HostKeyExposedError ||
    error instanceof CredentialKeyError
  )
    return { error: error._tag, message: error.message };
  const group = getErrorGroup(error);
  return {
    error: group ? (error as { _tag: string })._tag : 'UnknownError',
    message: (group && generic[group]) ?? 'The daemon is unavailable.',
  };
}
