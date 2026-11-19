import { Cause, Context, Effect, Layer } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import {
  EditorAlerts,
  makeEditorAtoms,
  type EditorAtoms,
  type EditorServices,
} from '@moonbase/application/editor';
import { WorkbenchPlatform, type WorkbenchPlatformShape } from './workbench-platform.ts';

/** What the workbench's actions may require: the editor's services and the app's platform. */
export type WorkbenchServices = EditorServices | WorkbenchPlatform;

/** Work a view starts: its failure is reported, so it fails with nothing the view handles. */
export type WorkbenchWork = Effect.Effect<unknown, unknown, WorkbenchServices>;

/** One editor as the workbench uses it: its services, atoms over them and the atom runtime. */
export type WorkbenchEditor = {
  readonly context: Context.Context<EditorServices>;
  readonly atoms: EditorAtoms;
  readonly platform: WorkbenchPlatformShape;
  /** The atom runtime views run the editor's actions on. The workbench owns no other runtime. */
  readonly runtime: Atom.AtomRuntime<WorkbenchServices>;
  /**
   * Work the editor owns rather than a view, such as a save or a mutation: unmounting the view
   * that started it leaves it running.
   */
  readonly work: Atom.AtomResultFn<WorkbenchWork, unknown>;
};

/** Reports `work`'s failure or defect in the editor's alerts; an interruption is no failure. */
export const reportFailure = (
  work: WorkbenchWork,
): Effect.Effect<unknown, never, WorkbenchServices> =>
  Effect.catchCause(work, (cause) =>
    Effect.gen(function* () {
      if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt;
      const failure = Cause.findErrorOption(cause);
      const alerts = yield* EditorAlerts;
      yield* alerts.report(failure._tag === 'Some' ? failure.value : Cause.squash(cause));
    }),
  );

/**
 * One function atom on `runtime` that runs each Effect written to it, reporting its failure.
 * `concurrent` runs each beside the others; otherwise a newer one interrupts the one running.
 */
export const makeWorkAtom = (
  runtime: Atom.AtomRuntime<WorkbenchServices>,
  concurrent: boolean,
): Atom.AtomResultFn<WorkbenchWork, unknown> =>
  runtime.fn((work: WorkbenchWork) => reportFailure(work), { concurrent });

/**
 * Binds an editor's services, built on the app root's runtime, to an atom runtime for its views,
 * with the platform capabilities the app supplies.
 */
export function makeWorkbenchEditor(
  context: Context.Context<EditorServices>,
  platform: WorkbenchPlatformShape = {},
): WorkbenchEditor {
  const runtime = Atom.runtime(
    Layer.succeedContext(Context.add(context, WorkbenchPlatform, platform)),
  );
  return {
    context,
    atoms: makeEditorAtoms(context),
    platform,
    runtime,
    // Kept alive and eager: work written to it runs whether or not a view reads it.
    work: makeWorkAtom(runtime, true).pipe(Atom.keepAlive, Atom.setLazy(false)),
  };
}
