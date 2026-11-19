import { Effect, Exit } from 'effect';

/**
 * Calls a Promise API with the signal that aborts it. Interrupting the call aborts the signal and
 * then waits for the Promise to settle, so none of its work outlives the fiber that started it.
 * `onLateFailure` sees what the Promise rejects with once aborted, unless it is the abort itself:
 * a failure of its cleanup, which a closing scope should still see.
 */
export const callAbortable = <A>(
  run: (signal: AbortSignal) => Promise<A>,
  onLateFailure?: (error: unknown) => Effect.Effect<void>,
): Effect.Effect<A, unknown> =>
  Effect.callback<A, unknown>((resume, signal) => {
    let failure: { error: unknown } | undefined;
    const fail = (error: unknown) => {
      failure = { error };
      return Exit.fail(error);
    };
    let settled: Promise<Exit.Exit<A, unknown>>;
    try {
      settled = run(signal).then(Exit.succeed, fail);
    } catch (error) {
      settled = Promise.resolve(fail(error));
    }
    void settled.then(resume);
    return Effect.andThen(
      Effect.promise(() => settled),
      Effect.suspend(() =>
        onLateFailure && failure && failure.error !== signal.reason
          ? onLateFailure(failure.error)
          : Effect.void,
      ),
    );
  });
