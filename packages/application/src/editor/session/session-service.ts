import { Context, Deferred, Effect, Exit, Fiber, Layer, Ref, Scope, SubscriptionRef } from 'effect';
import { EditorError } from '../editor-errors.ts';

/** The editor's modes, which gate what every concept admits. */
export type SessionState = {
  /** Recovery has loaded. */
  ready: boolean;
  /** The first load is still restoring checkouts and files. */
  loading: boolean;
  /** Composition fences admissions while it prepares Quit, without interrupting admitted work. */
  admissionsOpen: boolean;
  /** The editor is closing: it admits nothing and reports nothing. */
  closing: boolean;
  /** The editor has released everything it owned. */
  disposed: boolean;
  /** A close or reload holds the editor until its prompt is answered and its edits commit. */
  preserving: boolean;
  /** The checkout whose `initializeRepository` is running; it refuses saves and file operations. */
  initializing: string | null;
};

const initialState: SessionState = {
  ready: false,
  loading: false,
  admissionsOpen: true,
  closing: false,
  disposed: false,
  preserving: false,
  initializing: null,
};

export type EditorSessionShape = {
  /** The recovery namespace this editor reads and writes. */
  readonly clientId: string;
  readonly state: SubscriptionRef.SubscriptionRef<SessionState>;
  readonly get: Effect.Effect<SessionState>;
  readonly update: (f: (state: SessionState) => SessionState) => Effect.Effect<void>;
  /**
   * The scope the editor's work runs in, watches included. Closing the editor closes it, which
   * interrupts that work; anything forked into it afterwards is interrupted at once.
   */
  readonly scope: Scope.Scope;
  /**
   * Runs work the editor owns in its scope and waits for it. Closing the editor interrupts it, and
   * once it is closing a run is interrupted before it starts; a caller that stops waiting leaves it
   * running.
   */
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Runs an action the editor owns once it admits it: `run` after `admit`. */
  readonly admitted: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | EditorError, R>;
  /** Whether the editor admits new actions. */
  readonly admits: Effect.Effect<boolean>;
  /** Fails unless the editor admits new actions. */
  readonly admit: Effect.Effect<void, EditorError>;
  /** Fails unless recovery has loaded and the editor isn't closing. */
  readonly assertReady: Effect.Effect<void, EditorError>;
  /**
   * Marks `checkoutId` as initializing until `endInitialization`. Edits wait meanwhile: they
   * would name the folder target that `git init` retires.
   */
  readonly beginInitialization: (checkoutId: string) => Effect.Effect<void>;
  readonly endInitialization: Effect.Effect<void>;
  /** Waits until no `initializeRepository` runs. */
  readonly awaitInitialization: Effect.Effect<void>;
  /**
   * Stops admitting and reporting, then closes the editor's scope, interrupting its work. Every
   * caller waits until the scope has closed, its finalizers included.
   */
  readonly close: Effect.Effect<void>;
};

/** One editor's identity, modes and owned work. */
export class EditorSession extends Context.Service<EditorSession, EditorSessionShape>()(
  'moonbase/editor/EditorSession',
) {
  static readonly layer = (options: { clientId?: string }) =>
    Layer.effect(
      EditorSession,
      Effect.gen(function* () {
        const clientId = options.clientId ?? crypto.randomUUID();
        if (!clientId.trim()) return yield* new EditorError({ reason: 'client-id' });
        const state = yield* SubscriptionRef.make(initialState);
        // Closing interrupts all of its work at once: no piece of it waits on another's end.
        const scope = yield* Scope.fork(yield* Effect.scope, 'parallel');
        const initialization = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
        const get = SubscriptionRef.get(state);
        const update = (f: (state: SessionState) => SessionState) =>
          SubscriptionRef.update(state, f);
        const awaitInitialization: Effect.Effect<void> = Effect.gen(function* () {
          for (;;) {
            const done = yield* Ref.get(initialization);
            if (!done) return;
            yield* Deferred.await(done);
          }
        });
        const admits = Effect.map(get, (current) => current.admissionsOpen && !current.closing);
        const admit = Effect.flatMap(admits, (open) =>
          open ? Effect.void : Effect.fail(new EditorError({ reason: 'closing' })),
        );
        const closed = yield* Deferred.make<void>();
        // The fence is the forked fiber's first step, and the work starts in the same synchronous
        // step: a close announced before it admits nothing, and one announced after it closes the
        // scope the work already runs in.
        const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.flatMap(
            Effect.forkIn(
              Effect.flatMap(get, (current) => (current.closing ? Effect.interrupt : effect)),
              scope,
              { startImmediately: true },
            ),
            Fiber.join,
          );
        const close = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const first = yield* SubscriptionRef.modify(state, (s) => [
              !s.closing,
              { ...s, closing: true, admissionsOpen: false },
            ]);
            if (first)
              yield* Effect.andThen(
                Scope.close(scope, Exit.void),
                Deferred.succeed(closed, undefined),
              );
            yield* restore(Deferred.await(closed));
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.andThen(
            close,
            update((s) => ({ ...s, disposed: true })),
          ),
        );
        return {
          clientId,
          state,
          get,
          update,
          scope,
          run,
          admitted: (effect) => run(Effect.andThen(admit, effect)),
          admits,
          admit,
          assertReady: Effect.flatMap(get, (current) => {
            if (current.closing) return Effect.fail(new EditorError({ reason: 'closed' }));
            if (!current.ready) return Effect.fail(new EditorError({ reason: 'not-ready' }));
            return Effect.void;
          }),
          beginInitialization: (checkoutId) =>
            Effect.gen(function* () {
              yield* Ref.set(initialization, yield* Deferred.make<void>());
              yield* update((s) => ({ ...s, initializing: checkoutId }));
            }),
          endInitialization: Effect.gen(function* () {
            const done = yield* Ref.getAndSet(initialization, undefined);
            if (done) yield* Deferred.succeed(done, undefined);
            yield* update((s) => ({ ...s, initializing: null }));
          }),
          awaitInitialization,
          close,
        } satisfies EditorSessionShape;
      }),
    );
}
