import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The executables the daemon runs, found once at its entry: in the app's layout beside the bundle,
// else in a source checkout or on PATH.

const executable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The workspace's native helper: `workspace/filesystem` beside the `daemon/` folder of the bundle
 * that `entry` names, else, when `fromSource`, `packages/workspace/dist/filesystem` of a source checkout. Absent when
 * neither holds an executable file, in which case the daemon composes no workspace.
 */
export function findFilesystemHelper(
  entry: string | URL,
  { fromSource = false }: { fromSource?: boolean } = {},
): string | undefined {
  return [
    fileURLToPath(new URL('../workspace/filesystem', entry)),
    // Relative to this source file, which only a source checkout lays out; a bundle never looks.
    ...(fromSource
      ? [fileURLToPath(new URL('../../../packages/workspace/dist/filesystem', import.meta.url))]
      : []),
  ].find(executable);
}

/**
 * The ripgrep that chat file search and the workspace both use: the app's `workspace/ripgrep/rg`
 * beside the `daemon/` folder of the bundle that `entry` names, else the first `rg` on `path`'s
 * absolute folders, as when run from source or on a host without the app. Absent when neither
 * holds an executable file: chat search then lists with Git and the workspace has no search.
 */
export function findRipgrep(
  entry: string | URL,
  path = process.env.PATH ?? '',
): string | undefined {
  return [
    fileURLToPath(new URL('../workspace/ripgrep/rg', entry)),
    ...path
      .split(':')
      .filter((folder) => isAbsolute(folder))
      .map((folder) => join(folder, 'rg')),
  ].find(executable);
}
