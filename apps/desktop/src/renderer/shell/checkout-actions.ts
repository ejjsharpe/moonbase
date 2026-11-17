import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { EditorActions } from '@moonbase/workbench';

/**
 * The shell's project actions, each bringing the project into view (`showProject`) once it has
 * something to show: opening one from the picker, closing one (its unsaved work keeps it open and
 * shown), and importing files into one.
 */
export function makeCheckoutActions({
  editor,
  isLive,
  selectCheckout,
  selectClipboardImports,
  selectDroppedImports,
  showProject,
  importInto,
}: {
  editor: EditorActions | null;
  /** Whether the application is live, so a project may still open or files arrive. */
  isLive(): boolean;
  selectCheckout?: () => Promise<string | null>;
  selectClipboardImports?: (checkout: CheckoutTarget) => Promise<string[] | null>;
  selectDroppedImports?: (checkout: CheckoutTarget, files: File[]) => Promise<string[]>;
  showProject(): void;
  /** Imports approved references into the workbench's checkout. */
  importInto(checkout: CheckoutTarget, references: string[]): void;
}) {
  const importFiles = async (checkout: CheckoutTarget, selection: Promise<string[]>) => {
    const references = await selection;
    if (references.length && isLive()) {
      showProject();
      importInto(checkout, references);
    }
  };
  return {
    importFiles,
    /** Imports files dropped on the window at the selected checkout's root. */
    async dropFiles(checkout: CheckoutTarget | undefined, files: File[]) {
      if (!isLive() || !selectDroppedImports) return;
      if (!checkout) throw Error('Open a checkout before importing files.');
      await importFiles(checkout, selectDroppedImports(checkout, files));
    },
    /** The clipboard's files to import, none once the application isn't live. */
    selectClipboardImports:
      selectClipboardImports &&
      ((checkout: CheckoutTarget) =>
        isLive() ? selectClipboardImports(checkout) : Promise.resolve([])),
    /** Dropped files' references, none once the application isn't live. */
    selectDroppedImports:
      selectDroppedImports &&
      ((checkout: CheckoutTarget, files: File[]) =>
        isLive() ? selectDroppedImports(checkout, files) : Promise.resolve([])),
    async openCheckout() {
      const root = await selectCheckout?.();
      if (root && editor && isLive()) {
        showProject();
        await editor.openCheckout(root);
      }
    },
    async closeCheckout(checkout: CheckoutTarget) {
      if (!editor) return;
      if (!(await editor.closeCheckout(checkout))) {
        const selection = editor.selectCheckout(checkout);
        showProject();
        await selection;
      }
    },
  };
}
