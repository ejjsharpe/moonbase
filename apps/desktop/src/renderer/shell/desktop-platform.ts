import { Effect } from 'effect';
import type { WorkbenchPlatformShape } from '@moonbase/workbench';
import type { DesktopNativeShape } from '../ipc/desktop-native.ts';

/** The native capabilities the workbench's files tree uses, as `DesktopNative` has them. */
export type EditorNative = Partial<
  Pick<DesktopNativeShape, 'pasteImports' | 'dropImports' | 'copyPaths' | 'revealPath'>
>;

/**
 * The workbench's platform over main's native capabilities. Files copied or dropped import only
 * while the application is `live`; afterwards they are none.
 */
export function makeDesktopPlatform(
  { pasteImports, dropImports, copyPaths, revealPath }: EditorNative,
  live: Effect.Effect<boolean>,
): WorkbenchPlatformShape {
  const whileLive = <A, E>(work: Effect.Effect<A, E>, none: A) =>
    Effect.flatMap(live, (isLive) => (isLive ? work : Effect.succeed(none)));
  return {
    ...(pasteImports && {
      selectClipboardImports: (checkout) => whileLive(pasteImports(checkout), []),
    }),
    ...(dropImports && {
      selectDroppedImports: (checkout, files) => whileLive(dropImports(checkout, files), []),
    }),
    ...(copyPaths && { copyPaths }),
    ...(revealPath && { revealPath }),
  };
}
