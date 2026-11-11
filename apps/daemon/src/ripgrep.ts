import { accessSync, constants, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The ripgrep an app ships beside the daemon bundle that `entry` names: `daemon/daemon.mjs` in the
 * app's resources finds `workspace/ripgrep/rg` there. Absent when no executable file is there, as
 * when the daemon runs from source or on a remote host; file search then uses `rg` on PATH, then
 * Git.
 */
export function findBundledRipgrep(entry: string | URL): string | undefined {
  const path = fileURLToPath(new URL('../workspace/ripgrep/rg', entry));
  try {
    if (!statSync(path).isFile()) return undefined;
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}
