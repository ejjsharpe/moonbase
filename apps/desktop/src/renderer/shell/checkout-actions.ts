import { Effect } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { EditorActions } from '@moonbase/workbench';
import type { ShellNative } from './desktop-shell.tsx';

/**
 * The shell's project actions as Effects, each bringing the project into view (`showProject`)
 * once it has something to show: opening one from the picker, closing one (its unsaved work keeps
 * it open and shown), and importing files dropped on the window into one.
 */
export function makeCheckoutActions({
  editor,
  isLive,
  selectCheckout,
  showProject,
  importInto,
}: {
  editor: EditorActions | null;
  /** Whether the application is live, so a project may still open or files arrive. */
  isLive(): boolean;
  /** A project's root, chosen in the native picker; null when the user cancelled. */
  selectCheckout?: ShellNative['chooseCheckout'];
  showProject(): void;
  /** Imports approved references into the workbench's checkout. */
  importInto(checkout: CheckoutTarget, references: string[]): void;
}) {
  const selectDroppedImports = editor?.platform.selectDroppedImports;
  return {
    /** Imports files dropped on the window at the selected checkout's root. */
    dropFiles: (checkout: CheckoutTarget | undefined, files: File[]) =>
      Effect.gen(function* () {
        if (!isLive() || !selectDroppedImports) return;
        if (!checkout) return yield* Effect.fail(Error('Open a checkout before importing files.'));
        const references = yield* selectDroppedImports(checkout, files);
        if (references.length && isLive()) {
          showProject();
          importInto(checkout, references);
        }
      }),
    openCheckout: Effect.gen(function* () {
      const root = selectCheckout && (yield* selectCheckout);
      if (root && editor && isLive()) {
        showProject();
        yield* editor.openCheckout(root);
      }
    }),
    closeCheckout: (checkout: CheckoutTarget) =>
      Effect.gen(function* () {
        if (!editor || (yield* editor.closeCheckout(checkout))) return;
        showProject();
        yield* editor.selectCheckout(checkout);
      }),
  };
}
