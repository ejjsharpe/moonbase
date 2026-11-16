import type { ManagedRuntime } from 'effect';
import {
  acquireEditorDriver,
  type EditorDriverOptions,
} from '@moonbase/application/testing/editor-fixture';

export { answering, type EditorDriver } from '@moonbase/application/testing/editor-fixture';

/** An editor over `dependencies.client`; the workspace's runtime stays the caller's. */
export const acquireEditor = (
  _runtime: ManagedRuntime.ManagedRuntime<never, unknown> | unknown,
  dependencies: EditorDriverOptions,
) => acquireEditorDriver(dependencies);
