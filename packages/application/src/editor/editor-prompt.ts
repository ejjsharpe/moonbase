import { Deferred, Effect, type Scope, SubscriptionRef } from 'effect';

/** A prompt on screen and the reply its asker waits for. */
export type PendingPrompt<P, A> = { readonly prompt: P; readonly reply: Deferred.Deferred<A> };

/** One prompt at a time, shown until it is answered. */
export type EditorPrompt<P extends { readonly id: string }, A> = {
  /** The prompt shown, with its reply, or null. */
  readonly pending: SubscriptionRef.SubscriptionRef<PendingPrompt<P, A> | null>;
  /** Shows `prompt`, answering Cancel to any it replaces, and waits for its answer. */
  readonly ask: (prompt: P) => Effect.Effect<A>;
  /** Answers the shown prompt if it is `promptId`; a stale answer does nothing. */
  readonly answer: (promptId: string, answer: A) => Effect.Effect<void>;
};

/** Makes a prompt that answers `cancel` to the one shown when its scope closes. */
export const makeEditorPrompt = <P extends { readonly id: string }, A>(
  cancel: A,
): Effect.Effect<EditorPrompt<P, A>, never, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(SubscriptionRef.make<PendingPrompt<P, A> | null>(null), (pending) =>
      Effect.flatMap(SubscriptionRef.get(pending), (shown) =>
        shown ? Deferred.succeed(shown.reply, cancel) : Effect.void,
      ),
    ),
    (pending) => ({
      pending,
      ask: (prompt) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const entry: PendingPrompt<P, A> = { prompt, reply: yield* Deferred.make<A>() };
            const replaced = yield* SubscriptionRef.getAndSet(pending, entry);
            if (replaced) yield* Deferred.succeed(replaced.reply, cancel);
            return yield* restore(Deferred.await(entry.reply)).pipe(
              Effect.ensuring(
                SubscriptionRef.update(pending, (shown) => (shown === entry ? null : shown)),
              ),
            );
          }),
        ),
      answer: (promptId, answer) =>
        Effect.flatMap(SubscriptionRef.get(pending), (shown) =>
          shown?.prompt.id === promptId
            ? Effect.asVoid(Deferred.succeed(shown.reply, answer))
            : Effect.void,
        ),
    }),
  );
