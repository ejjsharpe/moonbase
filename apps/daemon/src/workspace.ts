import { accessSync, constants, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FolderApprovals } from '@moonbase/contracts/daemon';
import type { RootPredicate } from '@moonbase/workspace';
import type { DaemonSettings } from './daemon-settings.ts';
import { describeFailure } from './failure.ts';
import type { DaemonLog } from './log.ts';

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

// Folded as APFS compares names: a worktree location's parent need not be spelled as its real path.
const isInside = (outer: string, path: string) => {
  const [a, b] = [outer.normalize('NFC').toLowerCase(), path.normalize('NFC').toLowerCase()];
  return b === a || b.startsWith(a === '/' ? '/' : `${a}/`);
};

/**
 * Where the workspace may not go, and which roots it may open. Paths reserved in both modes are
 * the daemon's secrets and state; local mode also refuses any root inside the data directory except
 * under `chats/`, and host mode opens only what `folders` (the approved roots) allows, by real
 * path: one named through a link is refused, as is a root replaced since startup.
 */
export async function createRootPolicy(
  directory: string,
  settings: DaemonSettings,
  folders: FolderApprovals,
): Promise<{ reserved: string[]; allowRoot: RootPredicate }> {
  const data = await realpath(directory),
    chats = join(data, 'chats');
  // A root holding any of these, or inside one, is refused. That includes holding the data
  // directory, which holds `token`; roots inside the data directory are refused below.
  const reserved = [
    join(data, 'token'),
    join(data, 'credentials'),
    join(data, 'workspace'),
    ...(settings.credentialKey?.source === 'file' ? [settings.credentialKey.path] : []),
  ];
  return {
    reserved,
    // A host's roots neither hold nor sit inside the data directory (checked at startup), and
    // `folders` has only real paths under them, so nothing it allows is inside the data directory.
    allowRoot:
      settings.mode === 'host'
        ? (real, requested) => real === requested && folders.has(real)
        : (real) => !isInside(data, real) || isInside(chats, real),
  };
}

/**
 * Closes the workspace file host, waiting at most `deadlineMs`. A close that fails (a stale lock,
 * say) or never finishes (a helper that never exits) is logged by code and shutdown goes on, so it
 * can't keep the daemon, and with it the directory's lock, from exiting.
 */
export async function closeWorkspace(
  dispose: () => Promise<void>,
  { deadlineMs, log }: { deadlineMs: number; log: Pick<DaemonLog, 'write'> },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deadlineMs);
  });
  const closing = dispose().then(
    () => 'closed' as const,
    (error: unknown) => {
      log.write({ event: 'workspace', reason: 'close-failed', code: describeFailure(error).code });
      return 'closed' as const;
    },
  );
  try {
    if ((await Promise.race([closing, deadline])) === 'timeout')
      log.write({ event: 'workspace', reason: 'close-timeout' });
  } finally {
    clearTimeout(timer);
  }
}
