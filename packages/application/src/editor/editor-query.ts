import { Effect, Exit, Fiber, FiberHandle, Scope, Stream, SubscriptionRef } from 'effect';
import { describeEditorFailure } from './alerts/alerts.ts';

/** What every popup query shows: its message and whether an open from it is running. */
export type QueryState = { message: string; busy: boolean };

const unavailable =
  'File unavailable. Your current selection and edits are retained. Edit the path or retry.';

/** A popup's queries and the opens it makes from their results. */
export type EditorQuery<S extends QueryState> = {
  readonly state: SubscriptionRef.SubscriptionRef<S>;
  /**
   * Runs `work` as the popup's query a moment after the last one, replacing the running one. A
   * `key` repeating the last query is a refresh: it leaves an open running, and one asked for while
   * the query still runs waits for it and reruns once, so a stream of refreshes (a watcher reports
   * several a second while an agent works) can't keep restarting the query.
   */
  readonly replace: (key: string, work: Effect.Effect<void>) => Effect.Effect<void>;
  /** Whether `key` repeats the last query. */
  readonly repeats: (key: string) => boolean;
  /** A query's message, unless a failed open is still on screen: a refresh only updates rows. */
  readonly resultMessage: (message: string) => string;
  readonly update: (patch: Partial<S>) => Effect.Effect<void>;
  /**
   * Opens a result, one at a time: a newer query cancels it. Its failure's message stays until the
   * next query or open the user starts.
   */
  readonly open: <E>(open: Effect.Effect<boolean, E>) => Effect.Effect<boolean>;
};

/**
 * Makes a popup's query, living as long as both the popup's scope and the editor's `scope`: closing
 * either interrupts its queries and opens and ends its refreshes on each of `changes`.
 */
export const makeEditorQuery = <S extends QueryState>(
  initial: S,
  editor: { readonly scope: Scope.Scope; readonly changes: Stream.Stream<unknown> },
): Effect.Effect<EditorQuery<S>, never, Scope.Scope> =>
  Effect.gen(function* () {
    // A scope of the editor's that the popup's closes too. A closed editor's is closed from the
    // start, so the query runs nothing.
    const scope = yield* Scope.fork(editor.scope, 'parallel');
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    return yield* Scope.provide(makeQuery(initial, editor.changes), scope);
  });

const makeQuery = <S extends QueryState>(
  initial: S,
  changes: Stream.Stream<unknown>,
): Effect.Effect<EditorQuery<S>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make(initial);
    const running = yield* FiberHandle.make<void, never>();
    const opening = yield* FiberHandle.make<boolean, never>();
    let last: { key: string; work: Effect.Effect<void> } | undefined;
    let settled = true;
    let rerun: Effect.Effect<void> | undefined;
    /** Why the last open failed, shown until the next query or open the user starts. */
    let failedOpen: string | undefined;
    const update = (patch: Partial<S>) =>
      SubscriptionRef.update(state, (s) => ({ ...s, ...patch }));
    const settle = Effect.suspend(() => {
      settled = true;
      const next = rerun;
      rerun = undefined;
      return next ?? Effect.void;
    });
    const replace = (key: string, work: Effect.Effect<void>): Effect.Effect<void> =>
      Effect.suspend(() => {
        const refresh = key === last?.key;
        if (refresh && !settled) {
          rerun = replace(key, work);
          return Effect.void;
        }
        last = { key, work };
        settled = false;
        rerun = undefined;
        const cancelOpen = refresh
          ? Effect.void
          : Effect.andThen(
              Effect.sync(() => {
                failedOpen = undefined;
              }),
              FiberHandle.clear(opening),
            );
        const run = Effect.sleep('120 millis').pipe(
          Effect.andThen(work),
          // A superseded query never settles: the newer one does.
          Effect.onExit((exit) => (Exit.hasInterrupts(exit) ? Effect.void : settle)),
        );
        return Effect.andThen(
          cancelOpen,
          FiberHandle.run(running, { startImmediately: true })(run),
        ).pipe(Effect.asVoid);
      });
    // Each change runs the last query again as a refresh.
    const refresh = Effect.suspend(() => (last ? replace(last.key, last.work) : Effect.void));
    yield* changes.pipe(
      Stream.runForEach(() => refresh),
      Effect.forkScoped,
    );
    return {
      state,
      replace,
      repeats: (key) => key === last?.key,
      resultMessage: (message) => failedOpen ?? message,
      update,
      open: <E>(open: Effect.Effect<boolean, E>) =>
        Effect.gen(function* () {
          if ((yield* SubscriptionRef.get(state)).busy) return false;
          failedOpen = undefined;
          yield* update({ busy: true } as Partial<S>);
          const fail = (message: string) =>
            Effect.andThen(
              Effect.sync(() => {
                failedOpen = message;
              }),
              update({ message } as Partial<S>),
            );
          const fiber = yield* FiberHandle.run(opening)(
            open.pipe(
              Effect.tap((opened) => (opened ? Effect.void : fail(unavailable))),
              Effect.catch((error: E) => Effect.as(fail(describeEditorFailure(error)), false)),
            ),
          );
          const exit = yield* Fiber.await(fiber);
          yield* update({ busy: false } as Partial<S>);
          return Exit.isSuccess(exit) && exit.value;
        }),
    } satisfies EditorQuery<S>;
  });
