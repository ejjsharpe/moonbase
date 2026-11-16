import type { Context, Effect } from 'effect';
import {
  makeEditorAtoms,
  type EditorAtoms,
  type EditorServices,
} from '@moonbase/application/editor';

/** One editor as the workbench uses it: its services, atoms over them, and the root's runner. */
export type WorkbenchEditor = {
  readonly context: Context.Context<EditorServices>;
  readonly atoms: EditorAtoms;
  /**
   * Runs an editor action on the app root's runtime, rejecting with its failure. The workbench
   * creates no runtime of its own.
   */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
};

/** Binds an editor's services to the root runtime that built them, with its atoms made once. */
export const makeWorkbenchEditor = (
  context: Context.Context<EditorServices>,
  run: WorkbenchEditor['run'],
): WorkbenchEditor => ({ context, atoms: makeEditorAtoms(context), run });
