import { Deferred, Effect, Ref, type Scope, Semaphore, SubscriptionRef } from 'effect';

/** One prompt at a time, shown until it is answered. */
export type EditorPrompt<P extends { readonly id: string }, A> = {
  /** The prompt shown, or null. Subscribers answer it only through `answer`. */
  readonly shown: SubscriptionRef.SubscriptionRef<P | null>;
  /**
   * Shows `prompt` and waits for its answer. While another prompt is shown it is refused: it
   * answers Cancel at once and the shown prompt stays.
   */
  readonly ask: (prompt: P) => Effect.Effect<A>;
  /** Answers the shown prompt if it is `promptId`; a stale answer does nothing. */
  readonly answer: (promptId: string, answer: A) => Effect.Effect<void>;
  /** Answers the shown prompt, if any, with Cancel. */
  readonly cancel: Effect.Effect<void>;
};

type PendingPrompt<P, A> = { readonly prompt: P; readonly reply: Deferred.Deferred<A> };

/** Makes a prompt that answers `cancel` to the one shown when its scope closes. */
export const makeEditorPrompt = <P extends { readonly id: string }, A>(
  cancel: A,
): Effect.Effect<EditorPrompt<P, A>, never, Scope.Scope> =>
  Effect.acquireRelease(buildEditorPrompt<P, A>(cancel), (prompt) => prompt.cancel);

const buildEditorPrompt = <P extends { readonly id: string }, A>(
  cancel: A,
): Effect.Effect<EditorPrompt<P, A>> =>
  Effect.gen(function* () {
    const shown = yield* SubscriptionRef.make<P | null>(null);
    // The reply stays here, so only `answer` and `cancel` settle it.
    const pending = yield* Ref.make<PendingPrompt<P, A> | null>(null);
    const lock = yield* Semaphore.make(1);
    /**
     * Takes the shown prompt off screen if `accept` takes it, and settles its reply. Once it holds
     * the lock it can't be interrupted, so a prompt never leaves the screen with its reply unsettled.
     */
    const settle = (accept: (entry: PendingPrompt<P, A>) => boolean, answer: A) =>
      lock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const entry = yield* Ref.get(pending);
            if (!entry || !accept(entry)) return;
            yield* Ref.set(pending, null);
            yield* SubscriptionRef.set(shown, null);
            yield* Deferred.succeed(entry.reply, answer);
          }),
        ),
      );
    const cancelShown = settle(() => true, cancel);
    return {
      shown,
      ask: (prompt) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const entry: PendingPrompt<P, A> = { prompt, reply: yield* Deferred.make<A>() };
            const admitted = yield* lock.withPermits(1)(
              Effect.gen(function* () {
                if (yield* Ref.get(pending)) return false;
                yield* Ref.set(pending, entry);
                yield* SubscriptionRef.set(shown, prompt);
                return true;
              }),
            );
            if (!admitted) return cancel;
            return yield* restore(Deferred.await(entry.reply)).pipe(
              Effect.ensuring(settle((shownEntry) => shownEntry === entry, cancel)),
            );
          }),
        ),
      answer: (promptId, answer) => settle((entry) => entry.prompt.id === promptId, answer),
      cancel: cancelShown,
    } satisfies EditorPrompt<P, A>;
  });
