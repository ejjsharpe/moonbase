import { Context, type Effect } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';

/**
 * What the app supplies the workbench from its platform, each optional. Each Effect fails with
 * the app's own errors, which the editor's alerts describe. A renderer path alone grants no
 * access: imports take only the approved references these return.
 */
export type WorkbenchPlatformShape = {
  /** Asks the user to choose files to import into `checkout`, in the OS's own picker. */
  readonly selectNativeImports?: (checkout: CheckoutTarget) => Effect.Effect<string[], unknown>;
  /**
   * Approves files copied in the OS for importing: none when the OS clipboard holds no files, so
   * ⌘V pastes the tree's own entries instead, or null when the user declined, which pastes nothing.
   */
  readonly selectClipboardImports?: (
    checkout: CheckoutTarget,
  ) => Effect.Effect<string[] | null, unknown>;
  /**
   * Approves files dropped from the OS onto the files tree, one reference per file in order, for
   * importing into the folder dropped on. Without it, such drops pass through to the app.
   */
  readonly selectDroppedImports?: (
    checkout: CheckoutTarget,
    files: File[],
  ) => Effect.Effect<string[], unknown>;
  /** Copies a checkout's paths to the clipboard, joined by newlines: absolute, or as `relative`. */
  readonly copyPaths?: (
    checkout: CheckoutTarget,
    paths: string[],
    relative: boolean,
  ) => Effect.Effect<void, unknown>;
  /** Shows a checkout's file or folder in the OS file manager. */
  readonly revealPath?: (checkout: CheckoutTarget, path: string) => Effect.Effect<void, unknown>;
};

/** The app's platform capabilities, as the workbench's actions run them. */
export class WorkbenchPlatform extends Context.Service<WorkbenchPlatform, WorkbenchPlatformShape>()(
  'moonbase/workbench/WorkbenchPlatform',
) {}
