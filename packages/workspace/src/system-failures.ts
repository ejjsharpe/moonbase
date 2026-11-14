import { Data } from 'effect';

// Failures below the host's own errors: what the filesystem helper or a Node call reported. The
// host decides what each means where it reads them, and sends any it does not as `Unavailable`.

/** The filesystem helper (or Git, which it runs) exited unsuccessfully or could not start. */
export class HelperFailure extends Data.TaggedError('HelperFailure')<{
  readonly message: string;
  /** Its exit status, or null when it was stopped or never started. */
  readonly status: number | null;
  readonly stderr: string;
  /** Stopped part way (by a signal or its limit): what it was doing may have happened. */
  readonly uncertain: boolean;
  /** What it wrote to stdout before it ended. */
  readonly output: Buffer;
}> {}

/** A Node or OS call failed; `code` is its errno code, such as `ENOENT`. */
export class SystemFailure extends Data.TaggedError('SystemFailure')<{
  readonly code: string | undefined;
  readonly cause: unknown;
}> {}
