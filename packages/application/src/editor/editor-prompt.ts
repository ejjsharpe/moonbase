import { Deferred, Effect, type Scope, Stream, SubscriptionRef } from 'effect';

/** The prompt shown, read-only: views answer it only through the service that owns it. */
export type ShownPrompt<P> = {
  readonly get: Effect.Effect<P | null>;
  /** The prompt shown now, then each change. A stalled reader holds nothing up. */
  readonly changes: Stream.Stream<P | null>;
};

/** One prompt at a time, shown until it is answered. */
export type EditorPrompt<P extends { readonly id: string }, A> = {
  readonly shown: ShownPrompt<P>;
  /**
   * Shows `prompt` and waits for its answer. While another prompt is shown, or once the scope has
   * closed, it is refused: it answers Cancel at once and the shown prompt stays.
   */
  readonly ask: (prompt: P) => Effect.Effect<A>;
  /**
   * Answers the shown prompt if it is `promptId`; a stale or second answer does nothing. The
   * prompt stays shown until its `ask` resumes, so it leaves the screen in the same step as
   * whatever the asker does next (a close releasing the editor, say).
   */
  readonly answer: (promptId: string, answer: A) => Effect.Effect<void>;
  /** Answers the shown prompt, if any, with Cancel. */
  readonly cancel: Effect.Effect<void>;
};

type Current<P, A> = { readonly prompt: P; readonly reply: Deferred.Deferred<A> };
type PromptState<P, A> = { readonly closed: boolean; readonly current: Current<P, A> | null };

/**
 * Makes a prompt that, when its scope closes, answers Cancel to the one shown and refuses later
 * asks.
 */
export const makeEditorPrompt = <P extends { readonly id: string }, A>(
  cancel: A,
): Effect.Effect<EditorPrompt<P, A>, never, Scope.Scope> =>
  Effect.gen(function* () {
    // The one state and its lock. It stays private, so only the transitions below hold the lock,
    // each briefly and without waiting on anything else.
    const state = yield* SubscriptionRef.make<PromptState<P, A>>({ closed: false, current: null });
    /**
     * Applies `next` and answers Cancel to a prompt it takes off screen if it is still unanswered,
     * in one step that can't be interrupted, so a prompt never leaves the screen unanswered.
     */
    const takeDown = (next: (state: PromptState<P, A>) => PromptState<P, A>) =>
      Effect.uninterruptible(
        SubscriptionRef.modifyEffect(state, (before) =>
          Effect.gen(function* () {
            const after = next(before);
            if (before.current && after.current !== before.current) {
              yield* Deferred.succeed(before.current.reply, cancel);
            }
            return [undefined, after] as const;
          }),
        ),
      );
    /** Settles the shown prompt's reply, if `accept` takes it; its `ask` takes it off screen. */
    const reply = (accept: (current: Current<P, A>) => boolean, answer: A) =>
      Effect.flatMap(SubscriptionRef.get(state), ({ current }) =>
        current && accept(current)
          ? Effect.asVoid(Deferred.succeed(current.reply, answer))
          : Effect.void,
      );
    yield* Effect.addFinalizer(() => takeDown(() => ({ closed: true, current: null })));

    const shown = SubscriptionRef.changes(state).pipe(
      Stream.map((s) => s.current?.prompt ?? null),
      Stream.changes,
    );
    return {
      shown: {
        get: Effect.map(SubscriptionRef.get(state), (s) => s.current?.prompt ?? null),
        changes: shown,
      },
      ask: (prompt) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const entry: Current<P, A> = { prompt, reply: yield* Deferred.make<A>() };
            const admitted = yield* SubscriptionRef.modify(state, (s) =>
              s.closed || s.current ? [false, s] : [true, { ...s, current: entry }],
            );
            if (!admitted) return cancel;
            return yield* restore(Deferred.await(entry.reply)).pipe(
              Effect.ensuring(takeDown((s) => (s.current === entry ? { ...s, current: null } : s))),
            );
          }),
        ),
      answer: (promptId, answer) => reply((current) => current.prompt.id === promptId, answer),
      cancel: reply(() => true, cancel),
    } satisfies EditorPrompt<P, A>;
  });
