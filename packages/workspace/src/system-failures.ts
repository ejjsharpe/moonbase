import { Effect, Schema } from 'effect';

// Failures below the host's own errors: what the filesystem helper or a Node call reported. The
// host decides what each means where it reads them, and sends any it does not as `Unavailable`.

/** The filesystem helper (or Git, which it runs) exited unsuccessfully or could not start. */
export class HelperFailure extends Schema.TaggedError<HelperFailure>()('HelperFailure', {
  /** Its exit status, or null when it was stopped or never started. */
  status: Schema.NullOr(Schema.Number),
  stderr: Schema.String,
  /** Stopped part way (by a signal or its limit): what it was doing may have happened. */
  uncertain: Schema.Boolean,
  /** Stopped at its own time or output limit, rather than by a signal from elsewhere. */
  limitReached: Schema.Boolean,
  /** What it wrote to stdout before it ended. */
  output: Schema.instanceOf(Buffer),
}) {
  override get message() {
    if (this.stderr) return this.stderr;
    return this.limitReached
      ? 'Filesystem output/time limit reached; refine request.'
      : 'Filesystem helper unavailable.';
  }
}

/**
 * How a failed helper run ended:
 * - `limit`: stopped at its own time or output limit; what it wrote before is a partial result.
 * - `stopped`: stopped by a signal from elsewhere; what it was doing may have happened.
 * - `nothing-found`: ended on its own with exit 1 and nothing on stderr, which Git and ripgrep
 *   use for "nothing found".
 * - `failed`: ended on its own unsuccessfully, or never started.
 */
export const classifyHelperFailure = (
  failure: HelperFailure,
): 'limit' | 'stopped' | 'nothing-found' | 'failed' => {
  if (failure.limitReached) return 'limit';
  if (failure.uncertain) return 'stopped';
  return failure.status === 1 && !failure.stderr ? 'nothing-found' : 'failed';
};

/** A Node or OS call failed; `code` is its errno code, such as `ENOENT`. */
export class SystemFailure extends Schema.TaggedError<SystemFailure>()('SystemFailure', {
  code: Schema.optional(Schema.String),
  cause: Schema.Unknown,
}) {
  override get message() {
    return 'System call failed' + (this.code ? ': ' + this.code : '');
  }
}

/** `error` thrown by a Node or OS call, as a `SystemFailure`; a `code` that is not a string is dropped. */
export const asSystemFailure = (error: unknown) => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return new SystemFailure({ code: typeof code === 'string' ? code : undefined, cause: error });
};

/** Runs a Node or OS call that throws only its own errors, failing with a `SystemFailure`. */
export const systemCall = <A>(call: () => A): Effect.Effect<A, SystemFailure> =>
  Effect.try({ try: call, catch: asSystemFailure });
