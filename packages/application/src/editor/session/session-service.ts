import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  Ref,
  SubscriptionRef,
} from 'effect';
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
  /** Runs work the editor owns: closing the editor interrupts it. */
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
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
  /** Stops admitting and reporting, and interrupts the work the editor owns. */
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
        const fibers = yield* FiberSet.make();
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
        yield* Effect.addFinalizer(() => update((s) => ({ ...s, closing: true, disposed: true })));
        return {
          clientId,
          state,
          get,
          update,
          run: (effect) =>
            Effect.flatMap(get, (current) =>
              current.closing
                ? Effect.interrupt
                : Effect.flatMap(FiberSet.run(fibers, { startImmediately: true })(effect), Fiber.join),
            ),
          admit: Effect.flatMap(get, (current) =>
            current.admissionsOpen && !current.closing
              ? Effect.void
              : Effect.fail(new EditorError({ reason: 'closing' })),
          ),
          assertReady: Effect.flatMap(get, (current) =>
            current.closing
              ? Effect.fail(new EditorError({ reason: 'closed' }))
              : current.ready
                ? Effect.void
                : Effect.fail(new EditorError({ reason: 'not-ready' })),
          ),
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
          close: Effect.gen(function* () {
            yield* update((s) => ({ ...s, closing: true, admissionsOpen: false }));
            yield* FiberSet.clear(fibers);
          }),
        } satisfies EditorSessionShape;
      }),
    );
}
