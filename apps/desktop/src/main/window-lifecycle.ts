import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  PubSub,
  Ref,
  SubscriptionRef,
} from 'effect';
import { makeWindowFailure } from '../ipc/ipc-errors.ts';
import type { WindowAction } from '../ipc/window-rpcs.ts';
import * as WindowState from './window-state.ts';

export type { QuitAnswer } from './window-state.ts';

/** A failure's message, as Quit and the log report it. */
export const describeCause = (cause: Cause.Cause<unknown>) =>
  Cause.prettyErrors(cause)
    .map((error) => error.message)
    .join('\n');

/**
 * The window's Quit handshake and its document's readiness: it asks the document to prepare Quit
 * and to dispose, reports cleanup failures to it, and says when Quit may release everything.
 */
export class WindowLifecycle extends Context.Service<
  WindowLifecycle,
  {
    readonly state: SubscriptionRef.SubscriptionRef<WindowState.WindowState>;
    /** What main asks of the document; each document watching for actions hears them. */
    readonly actions: PubSub.PubSub<WindowAction>;
    readonly show: Effect.Effect<void>;
    readonly requestQuit: Effect.Effect<void>;
    readonly markReady: Effect.Effect<void>;
    answerQuit(answer: WindowState.QuitAnswer): Effect.Effect<void>;
    /** Another document replaced the window's. */
    readonly replaceDocument: Effect.Effect<void>;
    /** The renderer crashed; false once Moonbase is closing. */
    readonly crashDocument: Effect.Effect<boolean>;
    /** The user recovers a crashed workbench; false once Moonbase is closing. */
    readonly recoverDocument: Effect.Effect<boolean>;
    /** Quits without asking the document. */
    readonly finishQuit: Effect.Effect<void>;
    /** Runs a document's release, whose failure is reported; Quit waits for it. */
    runCleanup(release: Effect.Effect<unknown, unknown>): Effect.Effect<void>;
    reportCleanup(cause: Cause.Cause<unknown>): Effect.Effect<void>;
    /** Whether Quit is under way, when no new native work starts. */
    readonly isQuitting: Effect.Effect<boolean>;
    /** Whether Quit is releasing everything. */
    readonly isClosing: Effect.Effect<boolean>;
    /** Adds `step`, which Quit runs once it is agreed, before it waits for document releases. */
    addQuitStep(step: Effect.Effect<void>): Effect.Effect<void>;
    /** Waits for Quit, runs its steps, then waits for the document releases under way. */
    readonly awaitQuit: Effect.Effect<void>;
  }
>()('moonbase/desktop/WindowLifecycle') {}

export type WindowLifecycleOptions = {
  window: Pick<BrowserWindow, 'isDestroyed' | 'show' | 'focus'>;
  /** Hands an action to the documents watching; an unpackaged test entry may hold or reorder it. */
  deliver?(action: WindowAction, publish: (action: WindowAction) => void): void;
};

export const makeWindowLifecycle = ({ window, deliver }: WindowLifecycleOptions) =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make(WindowState.initialWindowState);
    const actions = yield* PubSub.unbounded<WindowAction>();
    const quit = yield* Deferred.make<void>();
    const cleanups = yield* FiberSet.make();
    const quitSteps = yield* Ref.make<readonly Effect.Effect<void>[]>([]);
    const show = Effect.sync(() => {
      if (window.isDestroyed()) return;
      window.show();
      window.focus();
    });
    const publish = (action: WindowAction) => void PubSub.publishUnsafe(actions, action);
    /** Moves the state in one step, then does what the move asks. */
    const transition = (
      move: (
        current: WindowState.WindowState,
      ) => readonly [WindowState.WindowEffects, WindowState.WindowState],
    ) =>
      Effect.flatMap(
        SubscriptionRef.modify(state, (current) => move(current)),
        (effects) =>
          Effect.gen(function* () {
            if (effects.log) yield* Effect.logError(effects.log);
            if (effects.show) yield* show;
            if (effects.send?.length && !window.isDestroyed())
              yield* Effect.sync(() => {
                for (const action of effects.send!)
                  if (deliver) deliver(action, publish);
                  else publish(action);
              });
            if (effects.finish) yield* Deferred.succeed(quit, undefined);
          }),
      );
    const reportCleanup = (cause: Cause.Cause<unknown>) =>
      Effect.andThen(
        Effect.logError('Document cleanup failed:', describeCause(cause)),
        transition((current) =>
          WindowState.reportCleanup(current, {
            action: 'cleanup-error',
            id: randomUUID(),
            error: makeWindowFailure(describeCause(cause)),
          }),
        ),
      );
    const phase = Effect.map(SubscriptionRef.get(state), (current) => current.phase._tag);
    return WindowLifecycle.of({
      state,
      actions,
      show,
      requestQuit: transition((current) => WindowState.requestQuit(current, randomUUID())),
      markReady: transition((current) => WindowState.markReady(current, randomUUID())),
      answerQuit: (answer) =>
        transition((current) => WindowState.answerQuit(current, answer, randomUUID())),
      replaceDocument: transition(WindowState.replaceDocument),
      crashDocument: SubscriptionRef.modify(state, (current) => {
        const [, next] = WindowState.crashDocument(current);
        return [current.phase._tag !== 'Closing', next];
      }),
      recoverDocument: SubscriptionRef.modify(
        state,
        (current): readonly [boolean, WindowState.WindowState] =>
          current.phase._tag === 'Closing'
            ? [false, current]
            : [true, { ...current, phase: { _tag: 'Open', quitRequested: false } }],
      ),
      finishQuit: transition(WindowState.finishQuit),
      runCleanup: (release) =>
        FiberSet.run(
          cleanups,
          Effect.onExit(release, (exit) =>
            Exit.isFailure(exit) ? reportCleanup(exit.cause) : Effect.void,
          ).pipe(Effect.ignore),
        ).pipe(Effect.asVoid),
      reportCleanup,
      isQuitting: Effect.map(SubscriptionRef.get(state), WindowState.isQuitting),
      isClosing: Effect.map(phase, (tag) => tag === 'Closing'),
      addQuitStep: (step) => Ref.update(quitSteps, (steps) => [...steps, step]),
      awaitQuit: Effect.gen(function* () {
        yield* Deferred.await(quit);
        yield* Effect.all(yield* Ref.get(quitSteps), { discard: true });
        yield* FiberSet.awaitEmpty(cleanups);
      }),
    });
  });

/** The window lifecycle's failures to report on Quit, with those of releasing everything. */
export const collectQuitFailures = (
  lifecycle: WindowLifecycle['Service'],
  closed: Exit.Exit<unknown, unknown>,
): Effect.Effect<string[]> =>
  Effect.map(SubscriptionRef.get(lifecycle.state), ({ failures }) => [
    ...failures.map((error) => error.message),
    ...(Exit.isFailure(closed) ? [describeCause(closed.cause)] : []),
  ]);
