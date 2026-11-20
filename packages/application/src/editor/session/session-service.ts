import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  Layer,
  Option,
  Scope,
  SubscriptionRef,
} from 'effect';
import { EditorError } from '../editor-errors.ts';
import { awaitForCaller } from '../await-for-caller.ts';

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
  /**
   * `run` for work only its caller wants, such as an open or a reveal a view asked for:
   * interrupting the caller interrupts it too.
   */
  readonly runWithCaller: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
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
   * Runs `initializeRepository`'s work in the editor's scope, marking `checkoutId` as
   * initializing until it ends. Edits wait meanwhile: they would name the folder target that
   * `git init` retires. Fails while another initialization runs.
   */
  readonly initialize: <A, E>(
    checkoutId: string,
    work: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | EditorError>;
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
        /** The running `initializeRepository`, which `awaitInitialization` waits for. */
        const initialization = yield* Scope.provide(FiberHandle.make(), scope);
        const get = SubscriptionRef.get(state);
        const update = (f: (state: SessionState) => SessionState) =>
          SubscriptionRef.update(state, f);
        // Another may start as one ends, so wait again until none runs.
        const awaitInitialization: Effect.Effect<void> = Effect.suspend(() => {
          const running = FiberHandle.getUnsafe(initialization);
          return Option.isSome(running)
            ? Effect.andThen(Fiber.await(running.value), awaitInitialization)
            : Effect.void;
        });
        const admits = Effect.map(get, (current) => current.admissionsOpen && !current.closing);
        const admit = Effect.flatMap(admits, (open) =>
          open ? Effect.void : Effect.fail(new EditorError({ reason: 'closing' })),
        );
        const closed = yield* Deferred.make<void>();
        // The fence is the forked fiber's first step, and the work starts in the same synchronous
        // step: a close announced before it admits nothing, and one announced after it closes the
        // scope the work already runs in.
        const fork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.forkIn(
            Effect.flatMap(get, (current) => (current.closing ? Effect.interrupt : effect)),
            scope,
            { startImmediately: true },
          );
        const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.flatMap(fork(effect), Fiber.join);
        const runWithCaller = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          awaitForCaller(fork(effect), Fiber.join);
        const close = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const first = yield* SubscriptionRef.modify(state, (s) => [
              !s.closing,
              { ...s, closing: true, admissionsOpen: false },
            ]);
            // Complete the shared wait even if a finalizer dies, so later closers never hang.
            if (first)
              yield* Scope.close(scope, Exit.void).pipe(
                Effect.ensuring(Deferred.succeed(closed, undefined)),
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
          runWithCaller,
          admitted: (effect) => run(Effect.andThen(admit, effect)),
          admits,
          admit,
          assertReady: Effect.flatMap(get, (current) => {
            if (current.closing) return Effect.fail(new EditorError({ reason: 'closed' }));
            if (!current.ready) return Effect.fail(new EditorError({ reason: 'not-ready' }));
            return Effect.void;
          }),
          initialize: (checkoutId, work) =>
            Effect.gen(function* () {
              const marked = update((s) => ({ ...s, initializing: checkoutId })).pipe(
                Effect.andThen(work),
                Effect.ensuring(update((s) => ({ ...s, initializing: null }))),
              );
              // `onlyIfMissing` starts nothing while another runs; the handle then holds that one.
              const started = yield* FiberHandle.run(initialization, marked, {
                onlyIfMissing: true,
              });
              const running = FiberHandle.getUnsafe(initialization);
              if (Option.isSome(running) && running.value !== started)
                return yield* new EditorError({ reason: 'initializing-already' });
              return yield* Fiber.join(started);
            }),
          awaitInitialization,
          close,
        } satisfies EditorSessionShape;
      }),
    );
}
